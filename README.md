# TR-808 Drum Machine (PWA)

A self-contained Progressive Web App that synthesizes classic Roland TR-808–style drums in the browser (Web Audio API). Touch-first UI for iPhone / iPad Safari, with a 16-step sequencer and starter patterns.

## Run locally

From this directory:

```bash
cd /workspace/tr-808
python3 -m http.server 8080
```

Then open **http://localhost:8080/** (or your machine’s LAN IP) in a browser.

Alternatives:

```bash
npx --yes serve -p 8080
```

> **Note:** Serve over `http://` or `https://` — opening `file://` may block AudioContext / service worker on some browsers.

## Add to Home Screen (iOS)

1. Open the app in **Safari** on iPhone or iPad (use your Mac/PC LAN URL if testing a local server).
2. Tap **Share** → **Add to Home Screen**.
3. Confirm the name (**TR-808**) and tap **Add**.
4. Launch from the home screen icon — it opens fullscreen (`standalone`).
5. **Tap any pad or Play once** to unlock audio (iOS requires a user gesture).

## Features

- 13 instruments: BD, SD, LT, MT, HT, RS, CP, CH, OH, CY, CB, MA, CL
- Low-latency pad triggers on `pointerdown` / `touchstart`
- Fully synthesized sounds (no sample CDN)
- 16-step sequencer, BPM 60–180, playhead LEDs
- Starter patterns: Rock, Hip-Hop, Electro
- Volume, clear, installable manifest + icons
- Offline caching via service worker

## Files

| Path | Role |
|------|------|
| `index.html` | App shell / PWA meta |
| `css/styles.css` | Retro chassis UI |
| `js/audio.js` | Web Audio synthesis |
| `js/sequencer.js` | Scheduler + patterns |
| `js/app.js` | UI / touch wiring |
| `manifest.webmanifest` | Install manifest |
| `sw.js` | Offline cache |
| `icons/` | SVG + PNG icons |

## Known limitations

- Sounds are **808-inspired DSP**, not ROM samples — character is close, not bit-identical.
- First gesture is required before sound (browser autoplay policy / iOS).
- Desktop Safari / Chrome work; best touch UX is on iOS/iPadOS.
- `color-mix()` in CSS may soft-fail on very old browsers (pads still usable).
