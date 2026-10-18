# CleanAir Routes — Chennai PM2.5 forecast + cleanest-route guidance

### ▶ Live demo: https://meranjith28.github.io/cleanair-routes/
### ▶ Demo video: https://youtu.be/gsfDoFJA_Lc

Forecasts PM2.5 at Chennai's monitoring stations for the next 24 hours and plans walking or cycling routes that
minimise the pollution you breathe in, with advice for asthma patients, elders and children (English and Tamil),
plus a dashboard with ready-to-send alerts for health officials.

**Try it:** open the live demo and click **"Try the demo trip"**, or click any two points inside the green box.
Use **+1 h ▶** to step through the replay and **Health officials' dashboard →** for the 24-hour outlook and alerts.

## How it works
- **Data:** hourly PM2.5 from 7 CPCB/TNPCB stations and the US Consulate monitor (OpenAQ), Open-Meteo weather, OpenStreetMap roads (120,000+ junctions)
- **Forecast:** one gradient-boosting model per horizon (1–24 h), blended with persistence, plus a calibrated worst-case (p90) forecast for sensitive users
- **Routing:** pollution estimated on every road between stations, then the fastest, cleanest and balanced routes by inhaled dose, plus the best time to leave
- **AI:** IBM Granite 3.3 2B writes plain-language advice and an officials' bulletin from the computed facts only

## Results (held-out winter, 1 Dec 2025 – 28 Feb 2026)
| Horizon | "No change" error | Our error | Better by |
|---|---|---|---|
| +1 h | 10.69 | 10.34 | 3.3 % |
| +3 h | 18.41 | 16.36 | 11.1 % |
| +6 h | 23.18 | 19.24 | 17.0 % |
| +12 h | 26.17 | 22.66 | 13.4 % |
| +24 h | 24.10 | 23.62 | 2.0 % |

Built and trained on **IBM LinuxONE (IBM z17, s390x)** for the IBM Z Datathon 2026 by Team FAVELA, including a neural
forecaster on the z17's on-chip AI accelerator (about 20× faster than the CPU, same accuracy).
This public demo replays real data from the held-out winter test period, which the model never trained on: forecasts and
alerts were computed with the same code and exported, and routing runs live in your browser.

![Architecture](architecture.png)

Full source code, model results and the LinuxONE notebook: https://github.com/meranjith28/FAVELA-CleanAir-Routes-IBMZ-Datathon-2026
