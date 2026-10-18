/* CleanAir Routes - static demo engine.
   A JavaScript copy of the server API (app.py) so the demo runs entirely in the browser:
   forecasts, officials' outlooks and metrics were computed on IBM LinuxONE and exported to data/*.js;
   routing (IDW pollution on every road + Dijkstra on time / inhaled dose) runs here, like src/routing.py. */
(function () {
  const M = window.CA_META, FCS = window.CA_FC, OFF = window.CA_OFF || {}, GEN = window.CA_GENAI || {};
  const NH = FCS.length;

  // ---------------------------------------------------------------- replay clock (shared by both pages)
  const KEY = 'cleanair_replay_idx';
  let idx = 0;
  try { idx = Math.min(NH - 1, Math.max(0, parseInt(localStorage.getItem(KEY) || '0', 10) || 0)); } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, String(idx)); } catch (e) {} };

  // ---------------------------------------------------------------- road graph
  function b64(s, T) {
    const bin = atob(s), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new T(u8.buffer);
  }
  let G = null;
  function graph() {
    if (G) return G;
    const g = window.CA_GRAPH, n = g.n, m = g.m;
    const lat = b64(g.lat, Int32Array), lon = b64(g.lon, Int32Array);
    const U = b64(g.u, Int32Array), V = b64(g.v, Int32Array), LEN = b64(g.len, Float32Array), HW = b64(g.hw, Uint8Array);
    const la = new Float64Array(n), lo = new Float64Array(n);
    for (let i = 0; i < n; i++) { la[i] = lat[i] / 1e6; lo[i] = lon[i] / 1e6; }
    const up = new Float64Array(m), midLa = new Float64Array(m), midLo = new Float64Array(m);
    const upl = g.classes.map(c => M.road_uplift[c] ?? 1.0);
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      up[e] = upl[HW[e]];
      midLa[e] = (la[U[e]] + la[V[e]]) / 2; midLo[e] = (lo[U[e]] + lo[V[e]]) / 2;
      deg[U[e] + 1]++; deg[V[e] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const nbr = new Int32Array(2 * m), eid = new Int32Array(2 * m), fill = deg.slice(0, n);
    for (let e = 0; e < m; e++) {
      nbr[fill[U[e]]] = V[e]; eid[fill[U[e]]++] = e;
      nbr[fill[V[e]]] = U[e]; eid[fill[V[e]]++] = e;
    }
    // IDW weights edge x station (power chosen by leave-one-station-out on LinuxONE)
    const st = Object.keys(M.stations), S = st.length, W = new Float32Array(m * S);
    for (let s = 0; s < S; s++) {
      const [sl, so] = M.stations[st[s]];
      for (let e = 0; e < m; e++) {
        const d = Math.max(hav(midLa[e], midLo[e], sl, so), 0.05);
        W[e * S + s] = 1 / Math.pow(d, M.power);
      }
    }
    G = { n, m, la, lo, U, V, LEN, up, off: deg, nbr, eid, st, S, W,
          time: new Float64Array(m), conc: new Float64Array(m), dose: new Float64Array(m) };
    return G;
  }
  function hav(a1, o1, a2, o2) {
    const r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
    const a = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }
  function stationVec(vals) {           // values aligned with G.st, NaN where a station has no forecast
    const v = new Float64Array(G.S);
    for (let s = 0; s < G.S; s++) v[s] = vals[G.st[s]] ?? NaN;
    return v;
  }
  function concEdge(e, v) {
    let num = 0, den = 0;
    for (let s = 0; s < G.S; s++) if (!isNaN(v[s])) { const w = G.W[e * G.S + s]; num += w * v[s]; den += w; }
    return (den ? num / den : 0) * G.up[e];
  }
  function setPollution(vals, mode) {
    const v = stationVec(vals), md = M.modes[mode];
    let cw = 0, lw = 0;
    for (let e = 0; e < G.m; e++) {
      const c = concEdge(e, v), t = G.LEN[e] / md.speed_kmh;
      G.conc[e] = c; G.time[e] = t; G.dose[e] = c * md.vent_m3h * t;
      cw += c * G.LEN[e]; lw += G.LEN[e];
    }
    G.meanConc = lw ? cw / lw : 0; G.vent = md.vent_m3h;
  }
  function nearest(lat, lon) {
    const c = Math.cos(lat * Math.PI / 180);
    let best = 0, bd = Infinity;
    for (let i = 0; i < G.n; i++) {
      const d = (G.la[i] - lat) ** 2 + ((G.lo[i] - lon) * c) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // Dijkstra with a binary heap; returns the list of edge ids from a to b
  function sp(a, b, wfn) {
    const n = G.n, dist = new Float64Array(n).fill(Infinity), pe = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    let hk = new Float64Array(1024), hv = new Int32Array(1024), hn = 0;
    const push = (k, x) => {
      if (hn === hk.length) { const k2 = new Float64Array(hn * 2), v2 = new Int32Array(hn * 2); k2.set(hk); v2.set(hv); hk = k2; hv = v2; }
      let i = hn++;
      while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
      hk[i] = k; hv[i] = x;
    };
    const pop = () => {
      const top = hv[0], k = hk[--hn], x = hv[hn];
      let i = 0;
      while (true) {
        let c = 2 * i + 1; if (c >= hn) break;
        if (c + 1 < hn && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= k) break;
        hk[i] = hk[c]; hv[i] = hv[c]; i = c;
      }
      hk[i] = k; hv[i] = x; return top;
    };
    dist[a] = 0; push(0, a);
    while (hn) {
      const u = pop();
      if (done[u]) continue; done[u] = 1;
      if (u === b) break;
      for (let j = G.off[u]; j < G.off[u + 1]; j++) {
        const v = G.nbr[j], e = G.eid[j], nd = dist[u] + wfn(e);
        if (nd < dist[v]) { dist[v] = nd; pe[v] = e; push(nd, v); }
      }
    }
    const nodes = [b], edges = [];
    let x = b;
    while (x !== a && pe[x] >= 0) { const e = pe[x]; edges.push(e); x = G.U[e] === x ? G.V[e] : G.U[e]; nodes.push(x); }
    return { nodes: nodes.reverse(), edges: edges.reverse() };
  }
  const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
  function summ(p) {
    let t = 0, d = 0, L = 0;
    for (const e of p.edges) { t += G.time[e]; d += G.dose[e]; L += G.LEN[e]; }
    return { minutes: r1(60 * t), km: r2(L), dose_ug: r2(d), avg_pm25: t ? r1(d / (G.vent * t)) : 0,
             coords: p.nodes.map(i => [G.la[i], G.lo[i]]), seg_pm25: p.edges.map(e => r1(G.conc[e])), _p: p };
  }
  function routes(src, dst, maxDetour = 0.25) {
    const a = nearest(src[0], src[1]), b = nearest(dst[0], dst[1]);
    const F = summ(sp(a, b, e => G.time[e])), C = summ(sp(a, b, e => G.dose[e]));
    let best = C.minutes <= F.minutes * (1 + maxDetour) ? C : F;
    const k = G.vent * G.meanConc;
    for (const al of [0.5, 1, 2]) {
      if (best === C) break;
      const S = summ(sp(a, b, e => G.dose[e] + al * k * G.time[e]));
      if (S.minutes <= F.minutes * (1 + maxDetour) && S.dose_ug < best.dose_ug) best = S;
    }
    return { routes: { fastest: F, cleanest: C, balanced: best }, a, b };
  }
  function doseAlong(p, vals, mode) {
    if (!p.edges.length) return [0, 0];
    const v = stationVec(vals), md = M.modes[mode];
    let d = 0, cw = 0, L = 0;
    for (const e of p.edges) {
      const c = concEdge(e, v), t = G.LEN[e] / md.speed_kmh;
      d += c * md.vent_m3h * t; cw += c * G.LEN[e]; L += G.LEN[e];
    }
    return [d, cw / L];
  }

  // ---------------------------------------------------------------- AQI + advice (same tables as src/advisory.py)
  function pm25ToAqi(c) {
    c = Math.max(0, +c);
    for (const [lo, hi, alo, ahi] of M.breaks) if (c <= hi + 0.999) return Math.round(alo + (ahi - alo) * (Math.min(c, hi) - lo) / (hi - lo));
    return 500;
  }
  function aqiCategory(c) {
    const a = pm25ToAqi(c);
    for (const [, , , ahi, name] of M.breaks) if (a <= ahi) return [name, a];
    return ['Severe', a];
  }
  const fmt = (s, o) => s.replace(/\{(\w+)(?::\.(\d)f)?\}/g, (_, k, d) => d != null ? Number(o[k]).toFixed(+d) : o[k]);
  const catLabel = (c, lang) => lang === 'ta' ? (M.cat_ta[c] || c) : c;
  const locTime = (s, lang) => { if (lang !== 'ta' || !s) return s; for (const [en, ta] of Object.entries(M.days_ta)) s = s.split(en).join(ta); return s; };
  function guidance(profile, med, p90, bestDep, saving, lang = 'en') {
    lang = M.advice[lang] ? lang : 'en';
    const sens = ['asthma', 'elderly', 'child'].includes(profile);
    const [cat, aqi] = aqiCategory(sens ? p90 : med), T = M.text[lang];
    const msg = M.advice[lang][sens ? 'sensitive' : 'general'][cat];
    const parts = [fmt(T.expected, { aqi, cat: catLabel(cat, lang) }) + (sens ? T.worst : '') + '. ' + msg];
    if (saving != null && saving >= 5) parts.push(fmt(T.saving, { pct: saving }));
    if (bestDep) parts.push(fmt(T.best, { t: locTime(bestDep, lang) }));
    return { category: cat, category_label: catLabel(cat, lang), aqi, color: M.colors[cat], text: parts.join(' '), lang };
  }

  // ---------------------------------------------------------------- API (same URLs and JSON as app.py)
  let lastRoute = null;
  function route(q) {
    const t0 = performance.now();
    graph();
    const src = q.get('from').split(',').map(Number), dst = q.get('to').split(',').map(Number);
    const mode = q.get('mode') || 'walk', profile = q.get('profile') || 'general', hour = +(q.get('hour') || 0), lang = q.get('lang') || 'en';
    const [s, w, n, e] = M.area.bbox;
    const inside = p => p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e;
    if (!inside(src) || !inside(dst)) return { error: `Please pick both points inside the highlighted area (${M.area.label}).` };
    const fc = FCS[idx], key = ['asthma', 'elderly', 'child'].includes(profile) ? 'p90' : 'median';
    const vals = h => Object.fromEntries(Object.entries(fc.stations).map(([k, v]) => [k, v[key][h]]));
    setPollution(vals(hour), mode);
    const R = routes(src, dst), r = R.routes;
    const saving = r.fastest.dose_ug ? 100 * (1 - r.cleanest.dose_ug / r.fastest.dose_ug) : 0;
    const timeline = [];
    for (let hh = 0; hh <= 24; hh++) {
      const [d, c] = doseAlong(r.cleanest._p, vals(hh), mode);
      timeline.push({ hour: hh, time: fc.times[hh], dose_ug: r2(d), avg_pm25: r1(c) });
    }
    const best = timeline.reduce((a, b) => b.dose_ug < a.dose_ug ? b : a);
    const bestLabel = fc.labels[best.hour], medAvg = r.balanced.avg_pm25;
    const bd = best.hour !== hour ? bestLabel : null;
    const adv = guidance(profile, medAvg, medAvg, bd, saving, lang);
    const pick = o => ({ minutes: o.minutes, km: o.km, dose_ug: o.dose_ug });
    const facts = { traveller: M.profiles[profile].label, mode, aqi: adv.aqi, category: adv.category,
      rule_based_advice: guidance(profile, medAvg, medAvg, bd, saving).text,
      fastest_route: pick(r.fastest), cleanest_route: pick(r.cleanest),
      cleanest_saves_percent: r1(saving), best_time_to_leave: bd || 'now' };
    for (const v of Object.values(r)) delete v._p;
    lastRoute = { idx, profile, mode, hour, lang, a: R.a, b: R.b };
    return { routes: r, saving_pct: r1(saving), advisory: adv, facts, timeline, best_departure: best, basis: key,
             latency_ms: r1(performance.now() - t0) };
  }
  // IBM Granite ran on LinuxONE; the public demo shows answers recorded there for the demo trip
  function recordedTravel() {
    if (!lastRoute) return null;
    graph();
    for (const t of GEN.travel || []) {
      if (t.idx !== lastRoute.idx || t.profile !== lastRoute.profile || t.mode !== lastRoute.mode ||
          t.hour !== lastRoute.hour || t.lang !== lastRoute.lang) continue;
      if (nearest(t.from[0], t.from[1]) === lastRoute.a && nearest(t.to[0], t.to[1]) === lastRoute.b) return t;
    }
    return null;
  }
  function csv() {
    const fc = FCS[idx], rows = ['station,time,hours_ahead,pm25_forecast,pm25_worst_case_p90,aqi,category'];
    for (const [st, v] of Object.entries(fc.stations))
      for (let h = 0; h <= 24; h++) { const [c, a] = aqiCategory(v.median[h]); rows.push([st, fc.times[h], h, v.median[h], v.p90[h], a, c].join(',')); }
    return rows.join('\n');
  }
  async function api(url, opts) {
    const u = new URL(url, location.href), p = u.pathname.replace(/.*\/api\//, '/api/'), q = u.searchParams;
    await new Promise(r => setTimeout(r, 0));          // let the page paint "Computing..." first
    switch (true) {
      case p === '/api/meta':
        return { profiles: M.profiles, modes: Object.keys(M.modes), now: FCS[idx].now, live: false, live_status: 'replay',
                 stations: M.stations, colors: M.colors, areas: { [M.area.key]: { label: M.area.label, bbox: M.area.bbox } },
                 replay: { idx, n: NH }, links: M.links };
      case p === '/api/tick':
        idx = (idx + 1) % NH; save();
        return { now: FCS[idx].now, wrapped: idx === 0 };
      case p === '/api/reset':
        idx = 0; save(); return { now: FCS[idx].now };
      case p === '/api/forecast':
        return { now: FCS[idx].now, stations: FCS[idx].stations, latency_ms: 0 };
      case p === '/api/route':
        return route(q);
      case p === '/api/metrics':
        return window.CA_METRICS || {};
      case p === '/api/genai_status':
        return { available: !!(GEN.travel || []).length, recorded: true, provider: GEN.provider, languages: ['en'] };
      case p === '/api/officials': {
        const lang = q.get('lang') === 'ta' ? 'ta' : 'en';
        return (OFF[idx] || {})[lang] || OFF[idx].en;
      }
      case p === '/api/officials/bulletin': {
        const b = (GEN.bulletin || []).find(x => x.idx === idx && x.lang === (q.get('lang') || 'en'));
        return b ? { status: 'done', recorded: true, ...b } : { status: 'unavailable', recorded: true, has_any: !!(GEN.bulletin || []).length };
      }
    }
    return { error: 'unknown endpoint ' + p };
  }
  window.CA = { api, csv, recordedTravel, hasGranite: !!(GEN.travel || []).length, demoTrip: GEN.demo_trip || M.demo_trip, idx: () => idx, n: NH,
                warm: () => setTimeout(graph, 50) };
})();
