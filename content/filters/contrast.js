/**
 * content/filters/contrast.js
 * High-contrast mode filter. Implements the FilterModule contract
 * (ARCHITECTURE.md §4): init(ctx), enable(options), disable(), update(options),
 * destroy().
 *
 * Strategy: resolve a single "call area root" element (nearest common
 * ancestor of `ctx.meet.getVideoTiles()` — no further climb; `filter`
 * creates a new containing block for `position: fixed`/`absolute`
 * descendants, so climbing past the tiles' own container reparents
 * anything fixed/absolute inside it — camera tiles, floating dock, etc. —
 * and visibly moves it. Mirrors colorblind.js's resolveTargetElement, which
 * never climbed and never had this bug. Falls back to `document.body` when
 * no Meet surface/tiles are available — e.g. before a call starts, or when
 * this module is driven directly as in the showcase page) and contribute a
 * `contrast()/saturate()` CSS filter value to it via
 * `AA.filterRegistry.setFilterContribution()`. That goes through the shared
 * composition map in filter-registry.js instead of writing `style.filter`
 * directly, so this module's effect merges correctly with any other filter
 * module (e.g. colorblind.js) that targets the same root, rather than one
 * silently overwriting the other.
 *
 * This is CSS-only and composited (ARCHITECTURE.md §7): no MediaStream/video
 * pixel data is ever read or touched (ARCHITECTURE.md §8).
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const MODULE_ID = "contrast";
  const DEFAULT_LEVEL = "high";

  // contrast()/saturate() presets per ARCHITECTURE.md §3 ("high" | "max" | "custom").
  const LEVELS = {
    high: "contrast(1.4) saturate(1.1)",
    max: "contrast(1.8) saturate(1.2)",
  };

  // "custom" level reads these two numeric knobs instead of a fixed preset —
  // clamped defensively since they can arrive via an invite-link payload,
  // not just the popup's range inputs.
  const DEFAULT_AMOUNT = 1.6;
  const DEFAULT_SATURATE = 1.15;
  const MIN_AMOUNT = 1;
  const MAX_AMOUNT = 3;
  const MIN_SATURATE = 0.5;
  const MAX_SATURATE = 2;

  let ctx = null;
  let logger = null;
  let targetEl = null; // currently-contributing-to call area root (cleared on disable/destroy)
  let currentLevel = DEFAULT_LEVEL;
  let currentAmount = DEFAULT_AMOUNT;
  let currentSaturate = DEFAULT_SATURATE;
  let enabled = false;

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  function getLogger() {
    if (logger) return logger;
    if (ctx && ctx.logger) return ctx.logger;
    if (AA.logger && typeof AA.logger.scope === "function") {
      return AA.logger.scope("filters:contrast");
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
      (log.error || console.error)(err);
    } catch (_) {
      /* never throw from error reporting */
    }
  }

  function filterStringForLevel(level) {
    if (level === "custom") {
      return `contrast(${currentAmount}) saturate(${currentSaturate})`;
    }
    return LEVELS[level] || LEVELS[DEFAULT_LEVEL];
  }

  // Resolves the single element that should receive the contrast filter: the
  // nearest common ancestor of the current video tiles — no further climb
  // (see header comment: climbing turns an ancestor into a new containing
  // block for any position:fixed/absolute descendant, which visibly moves
  // it). Falls back to document.body/documentElement when no tiles are
  // available so this never throws and degrades gracefully.
  function findCallAreaRoot() {
    try {
      if (typeof document === "undefined") return null;
      const tiles =
        ctx && ctx.meet && typeof ctx.meet.getVideoTiles === "function"
          ? ctx.meet.getVideoTiles()
          : [];

      const fallback = document.body || document.documentElement;
      if (!Array.isArray(tiles) || tiles.length === 0) return fallback;

      let common = tiles[0] && tiles[0].parentElement;
      for (let i = 1; i < tiles.length; i++) {
        const tile = tiles[i];
        if (!tile) continue;
        while (common && !common.contains(tile)) {
          common = common.parentElement;
        }
      }

      return common || fallback;
    } catch (err) {
      getLogger().error?.("findCallAreaRoot failed, falling back to body", err);
      return document.body || document.documentElement || null;
    }
  }

  // Withdraws this module's contribution from whatever element it last
  // targeted. Never touches an element it isn't currently contributing to.
  function clearTarget() {
    if (targetEl && AA.filterRegistry) {
      try {
        AA.filterRegistry.clearFilterContribution(targetEl, MODULE_ID);
      } catch (_) {
        /* node may already be detached; nothing to clean up */
      }
    }
    targetEl = null;
  }

  // Contributes this module's filter string to exactly one resolved node via
  // the shared composition registry, so a second filter module (e.g.
  // colorblind.js) contributing to the same element merges instead of
  // clobbering. Re-resolving to a new root first withdraws from the old one.
  function applyTarget() {
    const root = findCallAreaRoot();
    if (!root) return;
    if (!AA.filterRegistry) {
      getLogger().warn?.("AA.filterRegistry unavailable; cannot apply filter contribution");
      return;
    }

    if (targetEl && targetEl !== root) {
      clearTarget();
    }
    try {
      AA.filterRegistry.setFilterContribution(root, MODULE_ID, filterStringForLevel(currentLevel));
      targetEl = root;
    } catch (err) {
      getLogger().error?.("failed to set filter contribution on call area root", err);
    }
  }

  // Swaps the contributed filter string in place for the current target (if
  // any) — no removal/recreation, so there is no flicker between levels.
  function applyLevel(level, opts) {
    currentLevel = level === "custom" || LEVELS[level] ? level : DEFAULT_LEVEL;
    if (opts) {
      if (opts.amount !== undefined) currentAmount = clampNumber(opts.amount, MIN_AMOUNT, MAX_AMOUNT, DEFAULT_AMOUNT);
      if (opts.saturate !== undefined) currentSaturate = clampNumber(opts.saturate, MIN_SATURATE, MAX_SATURATE, DEFAULT_SATURATE);
    }
    if (targetEl && AA.filterRegistry) {
      try {
        AA.filterRegistry.setFilterContribution(targetEl, MODULE_ID, filterStringForLevel(currentLevel));
      } catch (err) {
        getLogger().error?.("failed to update filter contribution", err);
      }
    }
  }

  function init(context) {
    try {
      ctx = context || null;
      logger =
        (ctx && ctx.logger) ||
        (AA.logger && typeof AA.logger.scope === "function"
          ? AA.logger.scope("filters:contrast")
          : console);
      getLogger().debug?.("init");
    } catch (err) {
      safeReportError(err);
    }
  }

  function enable(options) {
    try {
      if (typeof document === "undefined") {
        getLogger().warn?.("document unavailable, no-op");
        return;
      }
      const opts = options || {};
      if (opts.enabled === false) {
        disable();
        return;
      }
      applyLevel(opts.level || currentLevel || DEFAULT_LEVEL, opts);
      applyTarget();
      enabled = true;
      getLogger().info?.(`enabled (level=${currentLevel})`);
    } catch (err) {
      safeReportError(err);
    }
  }

  function disable() {
    try {
      clearTarget();
      enabled = false;
      getLogger().info?.("disabled");
    } catch (err) {
      safeReportError(err);
    }
  }

  function update(options) {
    try {
      const opts = options || {};
      if (opts.enabled === false) {
        disable();
        return;
      }
      if (opts.level || opts.amount !== undefined || opts.saturate !== undefined) {
        applyLevel(opts.level || currentLevel, opts); // swap CSS value in place, no flicker
      }
      if (!enabled) return;
      applyTarget(); // re-resolve in case Meet's tile DOM changed
      getLogger().debug?.(`updated (level=${currentLevel})`);
    } catch (err) {
      safeReportError(err);
    }
  }

  function destroy() {
    try {
      clearTarget();
      enabled = false;
      currentLevel = DEFAULT_LEVEL;
      currentAmount = DEFAULT_AMOUNT;
      currentSaturate = DEFAULT_SATURATE;
      getLogger().info?.("destroyed");
      ctx = null;
      logger = null;
    } catch (err) {
      safeReportError(err);
    }
  }

  AA.filters = AA.filters || {};
  AA.filters.contrast = {
    id: MODULE_ID,
    init,
    enable,
    disable,
    update,
    destroy,
  };
  AA.filterRegistry?.register(AA.filters.contrast);
})(typeof window !== "undefined" ? window : globalThis);
