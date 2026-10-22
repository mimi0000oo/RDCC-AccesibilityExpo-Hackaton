/**
 * content/filters/inversion.js
 * "Smart" color inversion + brightness dimming filter (ARCHITECTURE.md §3:
 * profile.inversion).
 *
 * Two independent knobs composed into one CSS `filter` contribution:
 *
 * 1. `invertColors` (default true): inverts the whole page
 *    (`invert(1) hue-rotate(180deg)` on <html> — the hue-rotate corrects the
 *    hue shift a plain invert() introduces, standard trick). When `smart` is
 *    also true, every video tile (via ctx.meet.getVideoTiles()) and every
 *    <img> gets the SAME filter applied a second time, so the double-inversion
 *    cancels out and those elements render normally instead of looking like
 *    film negatives (same technique OS-level "smart invert" features use).
 *
 * 2. `brightness` (0.3-1, default 1): a plain `brightness()` multiplier,
 *    composed into the same root filter string, with NO exemptions — it's
 *    meant to darken video/images too, not just page chrome. This is the
 *    real fix for photophobia: inverting an already-dark Meet UI makes it
 *    BRIGHTER (the opposite of what light sensitivity needs), so the
 *    photophobia preset uses `invertColors: false` + a `brightness` < 1
 *    instead of inversion. Because the counter-filter applied to exempt
 *    nodes is always exactly `invert(1) hue-rotate(180deg)` (nothing more),
 *    and invert(invert(x)) = x regardless of where `brightness()` sits in
 *    the root's filter string, an exempt video tile still ends up with just
 *    the root's brightness applied to it, with the double-invert cancelling
 *    out cleanly — no extra bookkeeping needed for the brightness part.
 *
 * CSS-only, GPU-composited, no per-frame JS — satisfies ARCHITECTURE.md §7.
 *
 * FilterModule contract (ARCHITECTURE.md §4): init(ctx), enable(options),
 * disable(), update(options), destroy().
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});
  const logger = AA.logger ? AA.logger.scope("inversion") : console;

  const INVERT_FILTER = "invert(1) hue-rotate(180deg)";
  const MIN_BRIGHTNESS = 0.3;
  const MAX_BRIGHTNESS = 1;

  let ctx = null;

  // Desired state, driven entirely by enable()/update() option payloads.
  const state = { enabled: false, smart: true, invertColors: true, brightness: 1 };

  function clampBrightness(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1;
    return Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, num));
  }

  // Combines whichever of the two independent knobs are active into one CSS
  // filter string. Invert comes first so a later brightness() in the string
  // multiplies the already-inverted result, same order as the old invert-only
  // behavior — the exempt-node math in the header comment holds regardless.
  function rootFilterString() {
    const parts = [];
    if (state.invertColors) parts.push(INVERT_FILTER);
    if (state.brightness < 1) parts.push(`brightness(${state.brightness})`);
    return parts.join(" ");
  }

  // --- root (<html>) inversion bookkeeping ---
  let rootEl = null;
  let rootFilterApplied = false;

  // --- per-node counter-filter bookkeeping (smart-mode exemptions) ---
  // Tracked so destroy()/sync can withdraw exactly the contributions this
  // module made. All filter writes go through AA.filterRegistry's shared
  // composition map (filter-registry.js) rather than `el.style.filter`
  // directly, so another filter module targeting the same element (e.g. if
  // a Meet layout ever collapses the call-area root onto <html> itself)
  // merges instead of clobbering.
  const counterNodes = new Set();

  // --- live tile-change subscription (keeps smart exemptions in sync) ---
  let unsubscribeTileChanges = null;

  function getRootEl() {
    return (typeof document !== "undefined" && document.documentElement) || null;
  }

  function safeReport(err, context) {
    logger.warn(context, err);
    try {
      ctx?.reportError?.(err);
    } catch (_) {
      /* reportError must never throw back into us */
    }
  }

  function collectExemptNodes() {
    const nodes = [];

    try {
      const tiles = ctx?.meet?.getVideoTiles?.();
      if (Array.isArray(tiles)) {
        for (const tile of tiles) {
          if (tile instanceof Element) nodes.push(tile);
        }
      }
    } catch (err) {
      safeReport(err, "ctx.meet.getVideoTiles() threw, skipping tile exemptions");
    }

    try {
      const imgs = document.querySelectorAll("img");
      for (const img of imgs) nodes.push(img);
    } catch (err) {
      safeReport(err, "querySelectorAll(img) failed, skipping image exemptions");
    }

    return nodes;
  }

  function applyRootInvert() {
    const el = getRootEl();
    if (!el || !AA.filterRegistry) {
      logger.warn("no document.documentElement/filterRegistry available, cannot invert");
      return;
    }
    const filterString = rootFilterString();
    if (!filterString) {
      // Both knobs at their no-op defaults (invertColors off, brightness 1) —
      // nothing to contribute; withdraw any prior contribution instead.
      removeRootInvert();
      return;
    }
    rootEl = el;
    AA.filterRegistry.setFilterContribution(rootEl, "inversion", filterString);
    rootFilterApplied = true;
  }

  function removeRootInvert() {
    if (!rootFilterApplied || !rootEl || !AA.filterRegistry) {
      rootFilterApplied = false;
      return;
    }
    AA.filterRegistry.clearFilterContribution(rootEl, "inversion");
    rootFilterApplied = false;
  }

  function applyCounterFilter(node) {
    if (!node || !(node instanceof Element) || counterNodes.has(node) || !AA.filterRegistry) return;
    AA.filterRegistry.setFilterContribution(node, "inversion", INVERT_FILTER);
    counterNodes.add(node);
  }

  function removeCounterFilter(node) {
    if (!counterNodes.has(node) || !AA.filterRegistry) return;
    AA.filterRegistry.clearFilterContribution(node, "inversion");
    counterNodes.delete(node);
  }

  function removeAllCounterFilters() {
    for (const node of Array.from(counterNodes)) removeCounterFilter(node);
  }

  function syncExemptions() {
    const desired = new Set(collectExemptNodes());
    for (const node of desired) {
      if (!counterNodes.has(node)) applyCounterFilter(node);
    }
    for (const node of Array.from(counterNodes)) {
      if (!desired.has(node)) removeCounterFilter(node);
    }
  }

  function subscribeTileChanges() {
    if (unsubscribeTileChanges) return;
    try {
      const unsub = ctx?.meet?.on?.("meet:tiles-changed", () => {
        if (state.enabled && state.smart) syncExemptions();
      });
      if (typeof unsub === "function") unsubscribeTileChanges = unsub;
    } catch (err) {
      safeReport(err, "could not subscribe to meet:tiles-changed");
    }
  }

  function teardownTileSubscription() {
    if (unsubscribeTileChanges) {
      try {
        unsubscribeTileChanges();
      } catch (_) {
        /* best-effort unsubscribe */
      }
      unsubscribeTileChanges = null;
    }
  }

  // Single reconciliation point used by enable()/update()/disable() so that
  // switching smart <-> full never tears down and rebuilds the root filter —
  // only the per-tile counter-filters are added/removed, which is why the
  // toggle is flicker-free.
  function reconcile() {
    if (!state.enabled) {
      removeRootInvert();
      removeAllCounterFilters();
      teardownTileSubscription();
      return;
    }

    applyRootInvert();

    // Exemptions only make sense if colors are actually being inverted —
    // a brightness-only dim (photophobia) needs no double-invert cancellation.
    if (state.invertColors && state.smart) {
      syncExemptions();
      subscribeTileChanges();
    } else {
      removeAllCounterFilters();
      teardownTileSubscription();
    }
  }

  function init(context) {
    ctx = context || null;
    logger.info("initialized");
  }

  function enable(options) {
    const opts = options || {};
    if (typeof opts.smart === "boolean") state.smart = opts.smart;
    if (typeof opts.invertColors === "boolean") state.invertColors = opts.invertColors;
    if (opts.brightness !== undefined) state.brightness = clampBrightness(opts.brightness);
    state.enabled = typeof opts.enabled === "boolean" ? opts.enabled : true;
    reconcile();
    logger.info("enabled", { smart: state.smart, invertColors: state.invertColors, brightness: state.brightness, enabled: state.enabled });
  }

  function disable() {
    state.enabled = false;
    reconcile();
    logger.info("disabled");
  }

  function update(options) {
    const opts = options || {};
    if (typeof opts.enabled === "boolean") state.enabled = opts.enabled;
    if (typeof opts.smart === "boolean") state.smart = opts.smart;
    if (typeof opts.invertColors === "boolean") state.invertColors = opts.invertColors;
    if (opts.brightness !== undefined) state.brightness = clampBrightness(opts.brightness);
    reconcile();
    logger.info("updated", { smart: state.smart, invertColors: state.invertColors, brightness: state.brightness, enabled: state.enabled });
  }

  function destroy() {
    removeRootInvert();
    removeAllCounterFilters();
    teardownTileSubscription();
    state.enabled = false;
    state.invertColors = true;
    state.brightness = 1;
    rootEl = null;
    ctx = null;
    logger.info("destroyed");
  }

  AA.filters = AA.filters || {};
  AA.filters.inversion = { id: "inversion", init, enable, disable, update, destroy };
  AA.filterRegistry?.register(AA.filters.inversion);
})(typeof window !== "undefined" ? window : globalThis);
