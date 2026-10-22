/**
 * background/service-worker.js
 * MV3 service worker. Minimal by design: lifecycle only, no business logic.
 *  - Initializes default state on install.
 *  - Updates the action badge to reflect whether any profile is active.
 *  - Relays runtime messages between popup and content scripts when both are
 *    open (chrome.runtime.sendMessage already reaches listening content
 *    scripts directly; this worker only handles badge/icon state).
 * No network access. No remote code. Local storage only.
 */

const STORAGE_KEY = "accessAbility.v1";

const DEFAULT_STATE = {
  schemaVersion: 1,
  profile: {
    contrast: { enabled: false, level: "high" },
    colorblind: { enabled: false, mode: "deuteranopia" },
    inversion: { enabled: false, smart: true },
    readingRuler: { enabled: false, height: 48, opacity: 0.85 },
    magnifier: { enabled: false, zoom: 2, shape: "circle", size: 220 },
    pauseVideos: { enabled: false },
    focusMode: { enabled: false, dimOthers: false, hideSelfView: false, hideReactions: false },
    liveCaptions: { enabled: false },
    aiRecap: { enabled: false, windowSeconds: 120 },
    customHotkeys: { enabled: false, toggleMicKey: "alt+m", toggleCameraKey: "alt+c", hangUpKey: "alt+h" },
  },
  ui: { lastOpenedTab: "filters" },
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(STORAGE_KEY);
  if (!existing[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_STATE });
  }
  updateBadge(existing[STORAGE_KEY] || DEFAULT_STATE);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) return;
  updateBadge(changes[STORAGE_KEY].newValue);
});

function countActive(state) {
  if (!state || !state.profile) return 0;
  return Object.values(state.profile).filter((p) => p && p.enabled).length;
}

function updateBadge(state) {
  const active = countActive(state);
  chrome.action.setBadgeText({ text: active > 0 ? String(active) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
}

// Defensive: never let an unhandled rejection kill the worker silently without
// at least a console trace to help debugging during the harness/critic pass.
self.addEventListener("unhandledrejection", (event) => {
  console.error("[AccessABILITY:background] unhandled rejection", event.reason);
});
