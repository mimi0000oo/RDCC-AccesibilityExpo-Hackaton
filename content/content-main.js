/**
 * content/content-main.js
 * Content-script entry point. The only module that wires everything else
 * together (ARCHITECTURE.md §4, §9 step "content-main.js"):
 *   - starts meet-observer.js
 *   - builds the shared ModuleContext and hands it to both registries
 *   - loads the persisted AccessibilityState (utils/storage.js) and applies
 *     it to every filter/overlay module on load
 *   - subscribes to storage changes (driven by the popup) and live-applies
 *     them, so toggling a profile in the popup takes effect immediately
 *     without a page reload
 * This file owns the module failure boundary at the top level: anything
 * that goes wrong here is caught and logged, never allowed to break the
 * Meet tab (ARCHITECTURE.md §1, §6).
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});
  const logger = AA.logger ? AA.logger.scope("content-main") : console;

  // profile key -> { registry, id } — maps AccessibilityState.profile entries
  // (utils/storage.js DEFAULT_STATE) to the registry + module id that owns them.
  const PROFILE_MAP = {
    contrast: { registry: "filterRegistry", id: "contrast" },
    colorblind: { registry: "filterRegistry", id: "colorblind" },
    inversion: { registry: "filterRegistry", id: "inversion" },
    readingRuler: { registry: "overlayRegistry", id: "readingRuler" },
    magnifier: { registry: "overlayRegistry", id: "magnifier" },
    pauseVideos: { registry: "overlayRegistry", id: "pauseVideos" },
    focusMode: { registry: "overlayRegistry", id: "focusMode" },
    liveCaptions: { registry: "overlayRegistry", id: "liveCaptions" },
    aiRecap: { registry: "overlayRegistry", id: "aiRecap" },
    customHotkeys: { registry: "overlayRegistry", id: "customHotkeys" },
  };

  function applyProfile(profile) {
    if (!profile || typeof profile !== "object") return;
    for (const [key, target] of Object.entries(PROFILE_MAP)) {
      const options = profile[key];
      if (!options) continue;
      const registry = AA[target.registry];
      if (!registry) continue;
      try {
        if (options.enabled) {
          registry.enable(target.id, options);
        } else {
          registry.disable(target.id);
        }
      } catch (err) {
        logger.error(`failed to apply profile for "${target.id}"`, err);
      }
    }
  }

  async function loadAndApplyInitialState() {
    if (!AA.storage) {
      logger.warn("AA.storage unavailable; skipping initial profile load");
      return;
    }
    try {
      const state = await AA.storage.getState();
      applyProfile(state.profile);
    } catch (err) {
      logger.error("failed to load initial state", err);
    }
  }

  function subscribeToStorageChanges() {
    if (!AA.storage || typeof AA.storage.onChange !== "function") return () => {};
    return AA.storage.onChange((newValue) => {
      if (!newValue) return;
      applyProfile(newValue.profile);
      AA.messaging?.emit("profile:updated", newValue.profile);
    });
  }

  // Relays local module:error telemetry to the popup (ARCHITECTURE.md §6:
  // a disabled module must be flagged in the popup). Best-effort only — if no
  // popup is open, chrome.runtime.sendMessage silently has no receiver.
  function relayModuleErrorsToPopup() {
    AA.messaging?.on("module:error", (payload) => {
      AA.messaging?.broadcastRuntime("module:error", payload);
    });
  }

  // Lets a freshly-opened popup ask "what's the status right now" (it missed
  // any module:error broadcast that happened before it opened).
  function respondToStatusQueries() {
    AA.messaging?.onRuntime((message, _sender, sendResponse) => {
      if (!message || message.event !== "status:query") return;
      sendResponse({
        filters: AA.filterRegistry ? AA.filterRegistry.getStatus() : {},
        overlays: AA.overlayRegistry ? AA.overlayRegistry.getStatus() : {},
      });
    });
  }

  function showInviteAppliedNotice() {
    try {
      if (typeof document === "undefined" || !document.body) return;
      const notice = document.createElement("div");
      notice.setAttribute("data-aa-overlay", "invite-notice");
      notice.textContent = "Accessibility profile applied from this meeting's invite link.";
      notice.style.cssText =
        "position:fixed;bottom:16px;left:16px;z-index:2147483647;" +
        "background:#1a73e8;color:#fff;font:600 13px sans-serif;" +
        "padding:10px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);" +
        "pointer-events:none;opacity:1;transition:opacity 400ms ease;";
      document.body.appendChild(notice);
      global.setTimeout(() => {
        notice.style.opacity = "0";
        global.setTimeout(() => notice.remove(), 450);
      }, 5000);
    } catch (err) {
      logger.error("failed to show invite-applied notice", err);
    }
  }

  // Lets a recruiter share a Meet link with an accessibility profile baked
  // in (utils/invite-link.js), so a candidate joining doesn't have to
  // configure anything themselves. Only runs once per page load, since the
  // URL fragment doesn't change after that. Writes through AA.storage like
  // any other profile change (so the popup reflects it and the candidate can
  // freely adjust/undo it afterward) — it becomes their current profile, not
  // a hidden session-only override.
  async function applyInviteLinkPresetFromUrl() {
    try {
      if (!AA.inviteLink || typeof location === "undefined" || !AA.storage) return;
      const preset = AA.inviteLink.decode(location.hash);
      if (!preset) return;
      // Apply directly first — don't rely solely on the storage.onChange
      // round-trip to light the modules up. Persist after, so the popup
      // reflects it too and the candidate can freely adjust/undo it.
      applyProfile(preset);
      for (const [key, options] of Object.entries(preset)) {
        await AA.storage.setSlice(`profile.${key}`, options);
      }
      logger.info("applied accessibility preset from invite link", Object.keys(preset));
      showInviteAppliedNotice();
    } catch (err) {
      logger.error("failed to apply invite-link preset", err);
    }
  }

  function buildContext() {
    return {
      meet: AA.meetObserver ? AA.meetObserver.surface : null,
      storage: AA.storage || null,
      logger: AA.logger ? AA.logger.scope("ctx") : console,
      reportError(err) {
        logger.error("module reported an error", err);
        AA.messaging?.emit("module:error", { source: "ctx.reportError", error: String(err) });
      },
    };
  }

  async function start() {
    try {
      if (AA.meetObserver) AA.meetObserver.start();

      const ctx = buildContext();
      if (AA.filterRegistry) AA.filterRegistry.initAll(ctx);
      if (AA.overlayRegistry) AA.overlayRegistry.initAll(ctx);

      // Sequenced on purpose: the invite-link preset (if any) must apply
      // AFTER the candidate's own stored state has loaded, not racing it —
      // otherwise the slower of the two async loads wins arbitrarily,
      // sometimes silently undoing the preset (confirmed empirically).
      await loadAndApplyInitialState();
      subscribeToStorageChanges();
      relayModuleErrorsToPopup();
      respondToStatusQueries();
      await applyInviteLinkPresetFromUrl();

      logger.info("MeetAssist content script ready");
    } catch (err) {
      // Top-level boundary: content-main.js must never let an init failure
      // propagate into Meet's own page context.
      logger.error("content-main initialization failed; extension features disabled for this tab", err);
    }
  }

  start();
})(typeof window !== "undefined" ? window : globalThis);
