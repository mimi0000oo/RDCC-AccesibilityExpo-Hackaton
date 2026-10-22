/**
 * content/overlays/live-captions.js
 * Live captions for hard-of-hearing / APD users. Implements the
 * OverlayModule contract (ARCHITECTURE.md §4): init(ctx), enable(options),
 * disable(), update(options), destroy().
 *
 * Deliberately minimal: turns Meet's OWN native captions on when enabled,
 * and back off when disabled (including via the popup's Reset button) —
 * symmetric, so Meet's captions never end up stuck on after this module is
 * turned off. Nothing else — no overlay, no re-displaying/scraping Meet's
 * caption text, no language selection. Fully local: no network/microphone
 * access of its own (ARCHITECTURE.md §8).
 *
 * Finds Meet's REAL toggle button by matching its `aria-label` (Meet keeps
 * these for its own accessibility support, so it's the most durable hook
 * available — still unofficial/unstable like everything else this
 * extension reaches into, ARCHITECTURE.md §6/§7, so a markup change
 * degrades to a reported-but-non-throwing no-op, not a crash).
 *
 * Options shape: { enabled }.
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const MODULE_ID = "liveCaptions";

  const TOGGLE_ON_KEYWORDS = ["turn on captions", "activeaza subtitr", "porneste subtitr"];
  const TOGGLE_OFF_KEYWORDS = ["turn off captions", "dezactiveaza subtitr", "opreste subtitr"];

  let ctx = null;
  let logger = null;
  let enabled = false;
  let destroyed = false;

  function getLogger() {
    if (logger) return logger;
    if (ctx && ctx.logger) return ctx.logger;
    if (AA.logger && typeof AA.logger.scope === "function") {
      return AA.logger.scope("overlays:live-captions");
    }
    return console;
  }

  function safeReportError(err) {
    try {
      if (ctx && typeof ctx.reportError === "function") {
        ctx.reportError(err);
        return;
      }
    } catch (_) {
      /* fall through to logger below */
    }
    try {
      const log = getLogger();
      (log.error || console.error).call(log, err);
    } catch (_) {
      /* never throw from error reporting */
    }
  }

  function normalizeText(str) {
    return (str || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  function normalizeLabel(el) {
    return normalizeText(el.getAttribute("aria-label"));
  }

  // Best-effort: click Meet's own captions toggle if its label shows it's
  // currently in `fromState` ("on"/"off"), driving it to the other state.
  // Never throws, never assumes the button exists — if Meet's markup
  // doesn't match any known keyword, this just reports why and the user can
  // still toggle captions manually from Meet's own toolbar.
  //
  // Uses startsWith, NOT includes: Romanian forms negation by PREPENDING
  // "dez-" rather than using a separate word, so "Dezactivează subtitrarea"
  // (captions ON, click to turn OFF) literally CONTAINS "activeaza subtitr"
  // as a substring — includes() matched it as the "already off" state and
  // silently skipped the click (confirmed in testing: disable() did
  // nothing because of this exact collision). startsWith avoids it because
  // the real "on" label starts with "activeaza", the negated one doesn't.
  function clickMeetCaptionsToggle(fromState) {
    try {
      if (typeof document === "undefined") return;
      const fromKeywords = fromState === "on" ? TOGGLE_OFF_KEYWORDS : TOGGLE_ON_KEYWORDS;
      const alreadyKeywords = fromState === "on" ? TOGGLE_ON_KEYWORDS : TOGGLE_OFF_KEYWORDS;
      const candidates = document.querySelectorAll("[aria-label]");
      for (const el of candidates) {
        const label = normalizeLabel(el);
        if (alreadyKeywords.some((kw) => label.startsWith(kw))) return; // already in target state
        if (fromKeywords.some((kw) => label.startsWith(kw))) {
          el.click();
          return;
        }
      }
      safeReportError(new Error("live captions: couldn't find Meet's captions toggle button"));
    } catch (err) {
      safeReportError(err);
    }
  }

  function ensureMeetCaptionsOn() {
    clickMeetCaptionsToggle("off");
  }

  // Symmetric with ensureMeetCaptionsOn(): run when this module is disabled
  // (including via the popup's Reset button), so Meet's native captions
  // never end up stuck on after turning this toggle off.
  function ensureMeetCaptionsOff() {
    clickMeetCaptionsToggle("on");
  }

  function init(context) {
    try {
      ctx = context || null;
      destroyed = false;
      logger =
        (ctx && ctx.logger) ||
        (AA.logger && typeof AA.logger.scope === "function" ? AA.logger.scope("overlays:live-captions") : console);
      getLogger().debug?.("init");
    } catch (err) {
      safeReportError(err);
    }
  }

  function enable(options) {
    try {
      if (destroyed) return;
      const opts = options || {};
      if (opts.enabled === false) {
        disable();
        return;
      }
      enabled = true;
      ensureMeetCaptionsOn();
      getLogger().info?.("enabled");
    } catch (err) {
      safeReportError(err);
    }
  }

  // Symmetric with enable(): turns Meet's own captions back off too, so
  // they never end up stuck on after this module is disabled — including
  // via the popup's Reset button, which calls this through the same
  // registry.disable() path as a manual toggle-off. Only does so on an
  // actual on->off TRANSITION (guarded by `wasEnabled`) — every module's
  // disable() is also called once on every page load for whichever modules
  // are OFF in stored state (ARCHITECTURE.md §9 content-main.js
  // applyProfile), which would otherwise force Meet's native captions off
  // for a user who turned them on manually and simply never touched this
  // extension's toggle.
  function disable() {
    try {
      const wasEnabled = enabled;
      enabled = false;
      if (wasEnabled) ensureMeetCaptionsOff();
      getLogger().info?.("disabled");
    } catch (err) {
      safeReportError(err);
    }
  }

  function update(options) {
    try {
      if (destroyed) return;
      const opts = options || {};
      if (opts.enabled === false) {
        disable();
        return;
      }
      if (!enabled && opts.enabled === true) enable(opts);
    } catch (err) {
      safeReportError(err);
    }
  }

  function destroy() {
    try {
      disable();
      getLogger().info?.("destroyed");
    } catch (err) {
      safeReportError(err);
    } finally {
      ctx = null;
      logger = null;
      destroyed = true;
    }
  }

  AA.overlays = AA.overlays || {};
  AA.overlays.liveCaptions = {
    id: MODULE_ID,
    init,
    enable,
    disable,
    update,
    destroy,
  };
  AA.overlayRegistry?.register(AA.overlays.liveCaptions);
})(typeof window !== "undefined" ? window : globalThis);
