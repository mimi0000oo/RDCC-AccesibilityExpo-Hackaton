/**
 * utils/storage.js
 * Single source of truth for AccessibilityState (ARCHITECTURE.md §3).
 * The ONLY module allowed to touch chrome.storage directly. Everyone else
 * calls AA.storage.getState()/getSlice()/setSlice()/onChange().
 *
 * Local-only by design (chrome.storage.local, never .sync) — ARCHITECTURE.md §8.
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});
  const logger = AA.logger ? AA.logger.scope("storage") : console;

  const STORAGE_KEY = "accessAbility.v1";
  const SCHEMA_VERSION = 1;

  const DEFAULT_STATE = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profile: {
      // level "custom" reads amount/saturate instead of a fixed high/max preset.
      contrast: { enabled: false, level: "high", amount: 1.6, saturate: 1.15 },
      // intensity (0-100) blends the mode's correction toward identity (100 = full).
      colorblind: { enabled: false, mode: "deuteranopia", intensity: 100 },
      // invertColors=false + brightness<1 is a real dim/dark mode (for
      // photophobia) decoupled from color inversion, which backfires on
      // Meet's dark theme (inverting dark -> bright).
      inversion: { enabled: false, smart: true, invertColors: true, brightness: 1 },
      readingRuler: { enabled: false, height: 48, opacity: 0.85 },
      magnifier: { enabled: false, zoom: 2, shape: "circle", size: 220 },
      // On-screen "Pause videos" button (camera tiles + shared screen).
      pauseVideos: { enabled: false },
      // Fully local — audio-level speaker spotlight (dims non-speaking
      // tiles, no DOM-markup guessing), self-view auto-hide, reaction
      // hiding. Each independently opt-in.
      focusMode: { enabled: false, dimOthers: false, hideSelfView: false, hideReactions: false },
      // Fully local — just turns Meet's OWN native captions on. Nothing else.
      liveCaptions: { enabled: false },
      // On-demand, on-device summary of recent captions (ARCHITECTURE.md §8).
      aiRecap: { enabled: false, windowSeconds: 120 },
      customHotkeys: { enabled: false, toggleMicKey: "alt+m", toggleCameraKey: "alt+c", hangUpKey: "alt+h" },
    },
    // popup-only preferences — never sent to content scripts, don't affect Meet
    // itself. expandedConditions: which condition panels to re-expand next
    // time the popup opens (a dropdown popup's JS/DOM is destroyed on every
    // close, so without this the menu would silently collapse back to
    // nothing every time, even though the underlying module state persists).
    ui: { lastOpenedTab: "filters", theme: "light", expandedConditions: [] },
  });

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function migrate(stored) {
    if (!stored || typeof stored !== "object") return deepClone(DEFAULT_STATE);
    if (stored.schemaVersion === SCHEMA_VERSION) return stored;
    logger.warn(`migrating stored state from v${stored.schemaVersion} to v${SCHEMA_VERSION}`);
    return deepClone(DEFAULT_STATE);
  }

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  async function getState() {
    if (!hasChromeStorage()) return deepClone(DEFAULT_STATE);
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return migrate(result[STORAGE_KEY]);
  }

  async function getSlice(path) {
    const state = await getState();
    return path.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), state);
  }

  async function setSlice(path, value) {
    const state = await getState();
    const keys = path.split(".");
    let node = state;
    for (let i = 0; i < keys.length - 1; i++) {
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    }
    return state;
  }

  function onChange(callback) {
    if (!hasChromeStorage() || !chrome.storage.onChanged) return () => {};
    const listener = (changes, areaName) => {
      if (areaName !== "local" || !changes[STORAGE_KEY]) return;
      try {
        callback(changes[STORAGE_KEY].newValue, changes[STORAGE_KEY].oldValue);
      } catch (err) {
        logger.error("onChange callback threw", err);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  AA.storage = {
    STORAGE_KEY,
    DEFAULT_STATE,
    getState,
    getSlice,
    setSlice,
    onChange,
  };
})(typeof window !== "undefined" ? window : globalThis);
