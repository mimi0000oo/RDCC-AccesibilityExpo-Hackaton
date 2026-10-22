# ARCHITECTURE.md — AccessABILITY for Google Meet

Chrome MV3 extension. Real-time accessibility overlays and visual filters for Google Meet,
built for candidates with visual impairments or neurodivergence during job interviews.

## 1. Design principles

1. **Never crash the call.** Google Meet must keep working even if every single
   accessibility module throws on every single frame. Enforced via per-module
   try/catch boundaries (§6) — no module may let an exception escape into Meet's
   own event loop.
2. **Zero data leakage.** No network calls, no analytics, no remote
   config, no telemetry — including `content/overlays/ai-recap.js`'s "Catch
   me up" button, which summarizes on-device (§8). All state lives in
   `chrome.storage.local`. `host_permissions` is `meet.google.com` only,
   and the extension declares no `remote code`.
3. **Zero-lag.** Visual work is rAF-scheduled and CSS/SVG-filter based wherever
   possible so it runs on the compositor thread, not JS per-frame layout.
4. **One folder, one owner.** Each subsystem folder exposes a small public API
   and emits typed events. No module reaches into another module's internals or
   DOM nodes it doesn't own. Cross-module changes go through `utils/` only, and
   edits to `utils/`, `manifest.json`, or `background/` are integrator-only.

## 2. Folder layout

```
manifest.json                  # MV3 manifest (integrator-owned)
background/
  service-worker.js            # lifecycle, icon/badge state, cross-tab relay
content/
  dom/
    meet-observer.js           # detects Meet's DOM, video tiles, screenshare, theme
  filters/
    contrast.js                # high-contrast mode
    colorblind.js              # protanopia/deuteranopia/tritanopia SVG filters
    inversion.js               # smart color inversion (skips video/images)
    filter-registry.js         # shared FilterModule lifecycle contract
  overlays/
    reading-ruler.js           # dyslexia-friendly line-focus ruler
    magnifier.js                # cursor-follow screen magnifier
    pause-videos.js             # on-screen "Pause videos" button: pauses every video incl. a shared screen
    focus-mode.js                # speaker spotlight (local audio analysis), self-view hide, reaction hiding
    custom-hotkeys.js           # configurable mic/camera/leave-call shortcuts
    live-captions.js            # turns Meet's own captions on — nothing else
    ai-recap.js                  # on-demand on-device AI "catch me up" recap, see §8
    overlay-registry.js        # shared OverlayModule lifecycle contract
  main-world/
    media-guard.js              # runs in Meet's own JS world: blocks Meet's play() on videos pause-videos paused
  content-main.js               # content-script entry point; wires registries
    to background, owns the module failure boundary
ui/
  popup/
    popup.html
    popup.js
    popup.css
utils/
  storage.js                   # chrome.storage.local wrapper + schema versioning
  messaging.js                 # typed runtime message bus (content <-> popup <-> bg)
  logger.js                    # scoped console logger, no PII, dev-only verbosity
  perf.js                      # frame-budget instrumentation helper
  invite-link.js               # encode/decode an accessibility preset into a Meet URL fragment
  floating-dock.js             # shared bottom-right row for on-screen buttons (Pause videos, Catch me up)
docs/
  STATUS.json                  # per-module score ledger (critic pass output)
tests/
  mock-meet.html                # standalone Meet DOM approximation for harness + showcase
  run.js                         # Puppeteer verification harness
  showcase/                      # one standalone showcase HTML per module
  output/                         # generated screenshots + run-log.json (gitignored)
```

## 3. Shared state data model

Single source of truth, persisted under `chrome.storage.local` key `accessAbility.v1`:

```ts
interface AccessibilityState {
  schemaVersion: 1;
  profile: {
    // "custom" level reads amount/saturate instead of a fixed preset.
    contrast: { enabled: boolean; level: "high" | "max" | "custom"; amount: number; saturate: number };
    // intensity (0-100) blends the mode's correction matrix toward identity (100 = full correction).
    colorblind: { enabled: boolean; mode: "protanopia" | "deuteranopia" | "tritanopia"; intensity: number };
    // smart = skip video/img when inverting; invertColors/brightness are independent
    // knobs — brightness<1 dims everything (incl. video) with no inversion, the real
    // fix for photophobia (inverting Meet's dark theme makes it BRIGHTER, not darker).
    inversion: { enabled: boolean; smart: boolean; invertColors: boolean; brightness: number };
    readingRuler: { enabled: boolean; height: number; opacity: number };
    magnifier: { enabled: boolean; zoom: number; shape: "circle" | "rect" };
    pauseVideos: { enabled: boolean }; // shows the on-screen button; pausing happens on click
    // Audio-level speaker spotlight (local Web Audio analysis, no network/
    // recording), self-view auto-hide, reaction hiding — each independent.
    focusMode: { enabled: boolean; dimOthers: boolean; hideSelfView: boolean; hideReactions: boolean };
    liveCaptions: { enabled: boolean }; // fully local — just turns Meet's own captions on
    aiRecap: { enabled: boolean; windowSeconds: number }; // on-demand, on-device, see §8
    customHotkeys: { enabled: boolean; toggleMicKey: string; toggleCameraKey: string; hangUpKey: string };
  };
  // theme/expandedConditions are the popup's OWN chrome (not Meet-facing
  // modules). theme: dark mode for the extension's menu, via a header
  // toggle — no OS-preference tracking. expandedConditions: which condition
  // panel(s) to re-expand next time the popup opens — a dropdown popup's
  // JS/DOM is destroyed on every close, so without this the menu would
  // visually reset to all-collapsed every time even though the underlying
  // module state (profile above) persists fine on its own.
  ui: { lastOpenedTab: string; theme: "light" | "dark"; expandedConditions: string[] };
}
```


- `utils/storage.js` is the only module allowed to read/write this key.
- Every module receives its slice via `storage.getSlice(key)` and subscribes to
  changes via `storage.onChange(key, cb)` — never reads `chrome.storage` directly.
- Schema changes bump `schemaVersion` and go through `utils/storage.js` migration,
  integrator-only.

## 4. Public API contract per module

All filter modules (`content/filters/*.js`) implement `FilterModule`:

```ts
interface FilterModule {
  id: string;                    // e.g. "contrast"
  init(ctx: ModuleContext): void;
  enable(options: object): void;
  disable(): void;
  update(options: object): void; // live option change, no flicker
  destroy(): void;               // full teardown, removes injected nodes/styles
}
```

All overlay modules (`content/overlays/*.js`) implement `OverlayModule` — same
shape as `FilterModule` plus `onFrame(timestamp)` called from a single shared
rAF loop owned by `overlay-registry.js` (no module runs its own `requestAnimationFrame`
loop — avoids N competing loops).

`ModuleContext` (passed by `content-main.js` at `init`):

```ts
interface ModuleContext {
  meet: MeetSurface;              // from meet-observer.js — video tiles, theme, screenshare node
  storage: StorageSlice;
  logger: ScopedLogger;
  reportError(err: Error): void;  // routes to isolation boundary, never throws
}
```

`meet-observer.js` exposes `MeetSurface`:

```ts
interface MeetSurface {
  getVideoTiles(): HTMLElement[];
  getScreenshareNode(): HTMLElement | null;
  getTheme(): "dark" | "light";
  on(event: MeetEvent, cb: Function): Unsubscribe;
}
```

## 5. Events

Namespaced on `utils/messaging.js`'s bus, `source:event` format:

- `meet:tiles-changed`, `meet:screenshare-start`, `meet:screenshare-end`, `meet:theme-changed`
- `profile:updated` (popup -> content, on any storage write)
- `module:error` (any module -> content-main -> logger; never propagates further)
- `module:ready` / `module:destroyed` (lifecycle telemetry, local console only)

## 6. Fault isolation

`content-main.js` wraps every module call:

```js
function safeCall(mod, fn, ...args) {
  try { return mod[fn]?.(...args); }
  catch (err) { reportError(mod.id, fn, err); disableModule(mod.id); }
}
```

A module that throws is disabled and flagged in the popup (badge: "module
unavailable") — it never takes down the content script, the service worker, or
Meet's own JS. `overlay-registry.js`'s shared rAF loop calls each module's
`onFrame` through the same `safeCall`, so one bad overlay frame doesn't stop
others from rendering.

## 7. Performance budget

| Metric | Budget | Enforcement |
|---|---|---|
| UI rendering | >= 60 fps (16.6ms/frame) while any overlay active | `utils/perf.js` frame-timer in dev mode; critic pass measures via Puppeteer `tracing` |
| DOM injection overhead | <= 15ms per module `init`/`enable` call | `utils/perf.js` wraps lifecycle calls, warns in console if exceeded |
| Filter application | CSS `filter`/SVG `<filter>` only — composited, no per-frame JS repaint | code review gate |
| Memory | No module may hold references to detached Meet DOM nodes after `destroy()` | critic pass checks via heap snapshot diff |
| MutationObserver scope | `meet-observer.js` observes the narrowest stable container Meet exposes, never `document.body` broadly | code review gate |

## 8. Privacy policy

- Local-only, no exceptions. `content/overlays/ai-recap.js`'s floating
  "Catch me up" button (ADHD/autism) scrapes Meet's own caption text into a
  rolling local buffer and, only when clicked, summarizes the last
  `windowSeconds` of it ON THIS DEVICE: Chrome's built-in Summarizer API
  (Gemini Nano — the model may download once, then runs offline) when the
  browser/hardware supports it, otherwise a local extractive "key points"
  summary (word-frequency sentence ranking, each sentence shortened to a
  ~10-word gist, plus a "Topics:" line). No network call, no API key.
  It replaced a Hugging Face Inference API call that sent captions
  off-device and stopped working when the account ran out of credits.
- Every other module is likewise 100% local. No network calls, no telemetry, no
  AI/ML, from any of them, including `content/overlays/live-captions.js`:
  - `live-captions.js` does NOT run its own speech recognition and does NOT
    touch the microphone, and does NOT add any overlay/bar of its own. It
    only turns Meet's OWN native captions on (if they're off) via aria-label
    matching Meet's real toggle button, same technique as
    `custom-hotkeys.js`. Nothing else — no language picker, no re-displayed
    text. Earlier versions tried local speech recognition (dropped: only
    heard the candidate's own mic, and could hang indefinitely with zero
    events — a genuinely silent failure), then a re-displayed oversized
    caption bar, then a best-effort caption-language setter — all dropped
    per explicit instruction to keep this module to exactly one thing:
    turning Meet's own caption feature on.
  - `focus-mode.js`'s `dimOthers` reads VOLUME LEVELS (a Web Audio
    AnalyserNode per tile) from each participant's own already-decoded
    `<video>` element — not the local microphone, not a new capture, and
    nothing leaves the tile's existing MediaStream or this device. Used only
    to pick who's momentarily loudest for the dim/spotlight effect; no
    audio is recorded, buffered, or sent anywhere.
  - Every other module: no `fetch`, no beacons, no remote fonts/images, and
    CSP in `manifest.json` disallows remote code.
- `host_permissions` is `https://meet.google.com/*` only. No permissions beyond `storage` and
  `activeTab`/`scripting`.
- No screen/video pixel data is ever read, copied, or stored — filters/overlays
  are presentation-layer only (CSS/SVG/DOM). `pause-videos.js`'s
  button calls `<video>.pause()`/`.play()` only — it never inspects frames.
  No module calls `getUserMedia` or otherwise requests microphone/camera
  access of its own; `focus-mode.js`'s volume analysis (above) reads tiles'
  existing streams, nothing new.
- All preferences stored locally in `chrome.storage.local`; nothing synced to
  `chrome.storage.sync` (which is Google-account-synced) unless the user is told —
  default is local-only.
- Uninstalling the extension removes all state; nothing persists outside the browser profile.
- Accessible invite links (`utils/invite-link.js`): a recruiter can encode their
  chosen profile into the Meet link's URL FRAGMENT (`#aa=...`), which browsers
  never send to any server — no backend, nothing stored remotely. Only a
  whitelisted subset of profile fields can round-trip through it (never
  arbitrary data), and a candidate's own extension applies it locally on load,
  writing through the same `chrome.storage.local` path as any manual toggle.

## 9. Build waves (dependency order)

1. manifest + background + utils (integrator)
2. content/dom (Meet observer/detection)
3. content/filters (3 parallel builders: contrast, colorblind, inversion)
4. content/overlays (2 parallel builders: reading-ruler, magnifier)
5. ui/popup
6. integration pass (integrator only)
7. critic pass -> docs/STATUS.json -> retry loop (max 4 rounds per module)
8. final whole-extension e2e audit
9. utils/invite-link.js (accessible invite links — recruiter-authored preset baked
   into the Meet URL fragment) + content-main.js wiring to apply it on load
10. content/overlays/pause-videos.js (integrator, post-launch addition;
    replaced reduce-motion.js) +
    the popup's condition-based menu (CONDITIONS in ui/popup/popup.js) that
    applies a preset combination of existing + new modules for a
    self-selected neurodivergence/vision need
11. content/overlays/live-captions.js (post-launch addition; just turns
    Meet's own native captions on — fully local, see §8) and
    content/overlays/custom-hotkeys.js
12. content/overlays/focus-mode.js (post-launch addition replacing
    dyslexia-font.js and privacy-view.js, both retired — see §8: speaker
    spotlight via local Web Audio analysis, self-view auto-hide, reaction
    hiding; built without a live Meet session to verify the DOM-text-based
    pieces against, so treat `hideSelfView`/`hideReactions` as the most
    likely to need a keyword adjustment)
13. content/overlays/ai-recap.js (post-launch addition for ADHD/autism;
    on-device summary — see §8)

## 10. Definition of done (per module)

- Loads with zero console errors in the Puppeteer harness.
- Has a standalone showcase page under `tests/showcase/`.
- Passes critic score >= 8.5/10 against WCAG 2.1 AA+ with zero errors.
- Respects the performance budget in §7.
- `destroy()` leaves zero DOM nodes, listeners, or timers behind.
