/**
 * content/overlays/reading-ruler.js
 * Dyslexia-friendly reading ruler. Implements the OverlayModule contract
 * (ARCHITECTURE.md §4): init(ctx), enable(options), disable(), update(options),
 * destroy(), onFrame(timestamp).
 *
 * Strategy: on enable(), inject three `position:fixed`, full-viewport-width,
 * `pointer-events:none` bands attached once to `document.body` and reused
 * across enable/update/disable cycles (never recreated):
 *   - a "dim above" band pinned to the top of the viewport
 *   - a "dim below" band pinned to the bottom of the viewport
 *   - a clear "window" band of `height` px between them that lets the
 *     content directly under the cursor read at full opacity
 * A single `mousemove` listener stores the latest clientY in a plain number
 * (no DOM/layout work in the listener itself, per ARCHITECTURE.md §7). All
 * actual positioning happens once per rAF tick inside `onFrame(timestamp)`,
 * driven by the shared rAF loop owned by overlay-registry.js — this module
 * never calls `requestAnimationFrame` itself. Positioning uses
 * `transform: translateY(...)` exclusively (GPU-composited, no `top`/
 * `margin` writes) so following the cursor costs no layout per frame.
 *
 * Options shape (ARCHITECTURE.md §3): { enabled, height, opacity }.
 *
 * Privacy (ARCHITECTURE.md §8): no MediaStream/video pixel data is read; this
 * module only tracks mouse Y position (a UI input event) and renders CSS
 * boxes. No network calls, no storage reads/writes beyond what ctx provides.
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const MODULE_ID = "readingRuler";
  const DEFAULTS = { height: 56, opacity: 0.65 };
  const MIN_HEIGHT = 1;
  const MAX_HEIGHT = 10000;
  const MIN_OPACITY = 0;
  const MAX_OPACITY = 1;

  let ctx = null;
  let logger = null;
  let enabled = false;
  let destroyed = false;

  let currentHeight = DEFAULTS.height;
  let currentOpacity = DEFAULTS.opacity;

  // Latest known cursor Y, updated cheaply by the mousemove listener and
  // consumed once per frame by onFrame(). Defaults to vertical center of the
  // viewport so the band has a sane initial position before any mouse input.
  let pointerY = typeof window !== "undefined" ? window.innerHeight / 2 : 0;
  let lastRenderedY = null; // last Y we actually rendered at; avoids redundant style writes

  let containerEl = null; // wraps the three bands; the only node appended to <body>
  let dimAboveEl = null;
  let dimBelowEl = null;
  let windowEl = null; // unused visually (transparent gap) but kept for potential future styling

  let mousemoveHandler = null;
  let listenerAttached = false;

  function getLogger() {
    if (logger) return logger;
    if (ctx && ctx.logger) return ctx.logger;
    if (AA.logger && typeof AA.logger.scope === "function") {
      return AA.logger.scope("overlays:reading-ruler");
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

  function clampHeight(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return currentHeight;
    return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n));
  }

  function clampOpacity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return currentOpacity;
    return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, n));
  }

  // Builds the (initially hidden) DOM structure exactly once. Safe to call
  // multiple times — no-ops if already built.
  function ensureDom() {
    if (containerEl) return true;
    if (typeof document === "undefined" || !document.body) {
      getLogger().warn?.("document.body unavailable, cannot build reading ruler DOM");
      return false;
    }

    const container = document.createElement("div");
    container.setAttribute("data-aa-overlay", MODULE_ID);
    container.style.position = "fixed";
    container.style.top = "0";
    container.style.left = "0";
    container.style.width = "0";
    container.style.height = "0";
    container.style.pointerEvents = "none";
    container.style.zIndex = "2147483646"; // just under max, stays above Meet UI
    container.style.display = "none"; // toggled by enable()/disable()

    const dimAbove = document.createElement("div");
    dimAbove.setAttribute("data-aa-overlay-part", "dim-above");
    dimAbove.style.position = "fixed";
    dimAbove.style.left = "0";
    dimAbove.style.top = "0";
    dimAbove.style.width = "100vw";
    dimAbove.style.pointerEvents = "none";
    dimAbove.style.willChange = "transform, height";

    const dimBelow = document.createElement("div");
    dimBelow.setAttribute("data-aa-overlay-part", "dim-below");
    dimBelow.style.position = "fixed";
    dimBelow.style.left = "0";
    dimBelow.style.top = "0";
    dimBelow.style.width = "100vw";
    dimBelow.style.pointerEvents = "none";
    dimBelow.style.willChange = "transform, height";

    const windowBand = document.createElement("div");
    windowBand.setAttribute("data-aa-overlay-part", "window");
    windowBand.style.position = "fixed";
    windowBand.style.left = "0";
    windowBand.style.top = "0";
    windowBand.style.width = "100vw";
    windowBand.style.pointerEvents = "none";
    windowBand.style.background = "transparent";
    windowBand.style.boxShadow = "none";
    windowBand.style.willChange = "transform, height";

    container.appendChild(dimAbove);
    container.appendChild(windowBand);
    container.appendChild(dimBelow);
    document.body.appendChild(container);

    containerEl = container;
    dimAboveEl = dimAbove;
    dimBelowEl = dimBelow;
    windowEl = windowBand;
    return true;
  }

  // Updates only the colors/sizes that depend on options (height, opacity).
  // Never recreates nodes — just mutates existing style properties, so this
  // is safe to call live from update() with no flicker.
  function applyOptionsToDom() {
    if (!dimAboveEl || !dimBelowEl || !windowEl) return;
    const bg = `rgba(0, 0, 0, ${currentOpacity})`;
    dimAboveEl.style.background = bg;
    dimBelowEl.style.background = bg;
    windowEl.style.height = `${currentHeight}px`;
    // dim bands cover the full viewport height above/below the window band;
    // their own height is intentionally large and they're pushed in/out of
    // view via transform in onFrame(), avoiding any top/height layout writes
    // on every frame.
    const tallHeight = typeof window !== "undefined" ? window.innerHeight + currentHeight : 4000;
    dimAboveEl.style.height = `${tallHeight}px`;
    dimBelowEl.style.height = `${tallHeight}px`;
  }

  // Positions the bands via transform only (no layout) so the ruler can
  // follow the cursor at 60fps. Called once per rAF tick from onFrame().
  function renderAt(y) {
    if (!dimAboveEl || !dimBelowEl || !windowEl) return;
    const half = currentHeight / 2;
    const tallHeight = typeof window !== "undefined" ? window.innerHeight + currentHeight : 4000;

    // Window band: centered on y, height = currentHeight.
    windowEl.style.transform = `translateY(${y - half}px)`;

    // Dim-above band: its bottom edge should sit at (y - half). Since the
    // band's own box is `tallHeight` tall anchored at top:0, translate it up
    // by (tallHeight - (y - half)) so its bottom lines up with the window top.
    dimAboveEl.style.transform = `translateY(${y - half - tallHeight}px)`;

    // Dim-below band: its top edge should sit at (y + half).
    dimBelowEl.style.transform = `translateY(${y + half}px)`;
  }

  function onMouseMove(evt) {
    // Deliberately cheap: just stash a number. No DOM reads/writes here.
    pointerY = evt.clientY;
  }

  function attachListener() {
    if (listenerAttached) return;
    if (typeof document === "undefined") return;
    mousemoveHandler = onMouseMove;
    document.addEventListener("mousemove", mousemoveHandler, { passive: true });
    listenerAttached = true;
  }

  function detachListener() {
    if (!listenerAttached) return;
    if (mousemoveHandler && typeof document !== "undefined") {
      document.removeEventListener("mousemove", mousemoveHandler, { passive: true });
    }
    mousemoveHandler = null;
    listenerAttached = false;
  }

  function show() {
    if (containerEl) containerEl.style.display = "block";
  }

  function hide() {
    if (containerEl) containerEl.style.display = "none";
  }

  function init(context) {
    try {
      ctx = context || null;
      destroyed = false;
      logger =
        (ctx && ctx.logger) ||
        (AA.logger && typeof AA.logger.scope === "function"
          ? AA.logger.scope("overlays:reading-ruler")
          : console);
      getLogger().debug?.("init");
    } catch (err) {
      safeReportError(err);
    }
  }

  function enable(options) {
    try {
      if (destroyed) return;
      if (typeof document === "undefined" || !document.body) {
        getLogger().warn?.("document.body unavailable, no-op");
        return;
      }
      const opts = options || {};
      if (opts.enabled === false) {
        disable();
        return;
      }
      currentHeight = clampHeight(opts.height != null ? opts.height : currentHeight);
      currentOpacity = clampOpacity(opts.opacity != null ? opts.opacity : currentOpacity);

      if (!ensureDom()) return;
      applyOptionsToDom();
      attachListener();
      show();
      lastRenderedY = null; // force a render on next frame even if pointerY hasn't moved
      enabled = true;
      getLogger().info?.(`enabled (height=${currentHeight}, opacity=${currentOpacity})`);
    } catch (err) {
      safeReportError(err);
    }
  }

  function disable() {
    try {
      hide();
      detachListener();
      enabled = false;
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
      if (opts.height != null) currentHeight = clampHeight(opts.height);
      if (opts.opacity != null) currentOpacity = clampOpacity(opts.opacity);

      if (!containerEl) {
        // update() called before enable(); nothing to mutate yet.
        if (opts.enabled === true) enable(opts);
        return;
      }
      applyOptionsToDom();
      lastRenderedY = null; // re-render at next frame with the new height/opacity
      if (opts.enabled === true && !enabled) {
        attachListener();
        show();
        enabled = true;
      }
      getLogger().debug?.(`updated (height=${currentHeight}, opacity=${currentOpacity})`);
    } catch (err) {
      safeReportError(err);
    }
  }

  function onFrame(timestamp) {
    try {
      if (destroyed || !enabled) return;
      if (!containerEl || !dimAboveEl || !dimBelowEl || !windowEl) return;
      if (pointerY === lastRenderedY) return; // nothing changed, skip the write
      renderAt(pointerY);
      lastRenderedY = pointerY;
    } catch (err) {
      // onFrame already runs inside overlay-registry.js's safeCall try/catch,
      // but guard defensively anyway per the module contract notes.
      safeReportError(err);
    }
  }

  function destroy() {
    try {
      hide();
      detachListener();
      if (containerEl && containerEl.parentNode) {
        containerEl.parentNode.removeChild(containerEl);
      }
      containerEl = null;
      dimAboveEl = null;
      dimBelowEl = null;
      windowEl = null;
      lastRenderedY = null;
      enabled = false;
      destroyed = true;
      currentHeight = DEFAULTS.height;
      currentOpacity = DEFAULTS.opacity;
      getLogger().info?.("destroyed");
      ctx = null;
      logger = null;
    } catch (err) {
      safeReportError(err);
    }
  }

  AA.overlays = AA.overlays || {};
  AA.overlays.readingRuler = {
    id: MODULE_ID,
    init,
    enable,
    disable,
    update,
    destroy,
    onFrame,
  };
  AA.overlayRegistry?.register(AA.overlays.readingRuler);
})(typeof window !== "undefined" ? window : globalThis);
