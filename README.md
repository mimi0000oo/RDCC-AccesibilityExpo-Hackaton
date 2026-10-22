# AccessABILITY for Google Meet

Chrome MV3 extension: real-time accessibility overlays and visual filters for Google Meet, built for candidates with visual impairments or neurodivergence during job interviews.

**Everything is local-only.** No network calls, no analytics, no remote config, no telemetry — including the on-device AI "Catch me up" recap. `host_permissions` is `https://meet.google.com/*` only. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design doc.

## Features

**Visual filters**
- High contrast (high / max / custom contrast+saturation amount)
- Color-blind correction (protanopia / deuteranopia / tritanopia, SVG-based, adjustable correction strength)
- Smart color inversion (skips video/images so camera feeds stay normal)

**Overlays**
- Reading ruler — dims everything except a band around the cursor, for dyslexia/line-tracking
- Magnifier — cursor-follow zoom lens (1.5x–4x, circle or rectangle)
- "Pause videos" on-screen button — freezes every video, including a shared screen
- Focus mode — dims non-speakers (local audio analysis), hides your own camera tile, hides floating emoji reactions
- Custom hotkeys — configurable mic/camera/leave-call shortcuts
- Live captions — turns on Meet's own native captions, nothing else
- AI "Catch me up" — on-demand, on-device summary of the last N seconds of captioned speech (Chrome's built-in Summarizer API when available, otherwise a local extractive summary)

**Popup condition menu** — pick what applies to you and it turns on the right modules with sensible defaults (still fine-tunable or toggleable afterward): Dyslexia, ADHD, Autism (ASD), Dyscalculia, Dysgraphia, Low vision, Color blindness, Photophobia, Hard of hearing, APD, Motor disabilities, Social anxiety, Sensory Processing Disorder, Photosensitive epilepsy, Motion sensitivity/vestibular.

**Accessible invite links** — a recruiter can encode a preset accessibility profile into a Meet URL fragment (`#aa=...`, never sent to any server) so a candidate's call opens with their needs already configured.

## Install (unpacked, for development)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this repo's root folder
3. Open any `https://meet.google.com/...` call → click the extension icon to open the preference UI (its own full-screen tab, not a dropdown)

## Project layout

```
manifest.json                  # MV3 manifest
background/service-worker.js   # lifecycle, icon/badge state, cross-tab relay
content/
  dom/meet-observer.js          # detects Meet's DOM, video tiles, screenshare, theme
  filters/                      # contrast, colorblind, inversion + filter-registry.js
  overlays/                     # reading-ruler, magnifier, pause-videos, focus-mode,
                                 # custom-hotkeys, live-captions, ai-recap + overlay-registry.js
  main-world/media-guard.js      # runs in Meet's own JS world (blocks play() while paused)
  content-main.js               # content-script entry point
ui/popup/                       # popup.html / popup.js / popup.css — the condition menu UI
utils/                          # storage, messaging, logger, perf, invite-link, floating-dock
docs/STATUS.json                # per-module score ledger
tests/                          # Puppeteer verification harness + mock Meet DOM + showcases
```

## Testing

```
npm install
npm run test:visual
```

Runs `tests/run.js` (Puppeteer) against `tests/mock-meet.html` — a standalone approximation of Meet's DOM — and reports pass/fail per section plus screenshots under `tests/output/`.

## Privacy

- Local-only, no exceptions — see [ARCHITECTURE.md §8](ARCHITECTURE.md).
- No screen/video pixel data is ever read, copied, or stored.
- All preferences live in `chrome.storage.local`; nothing synced to a Google account.
- Uninstalling the extension removes all state.
