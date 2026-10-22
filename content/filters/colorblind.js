/**
 * content/filters/colorblind.js
 * Color-vision-deficiency (CVD) correction filter — daltonization via the
 * well-established Brettel/Vienot SVG color-matrix approach.
 *
 * Injects ONE hidden <svg> containing three <filter> defs (protanopia,
 * deuteranopia, tritanopia), each wrapping a <feColorMatrix type="matrix">
 * that redistributes color-channel energy into channels the user can still
 * distinguish. The correction itself is applied as a CSS `filter: url(#...)`
 * on the call-area root, so it is GPU-composited and costs zero per-frame JS
 * (ARCHITECTURE.md §7).
 *
 * FilterModule contract (ARCHITECTURE.md §4):
 *   init(ctx) / enable(options) / disable() / update(options) / destroy()
 * Options shape (ARCHITECTURE.md §3):
 *   { enabled: boolean, mode: "protanopia" | "deuteranopia" | "tritanopia", intensity?: number (0-100, default 100) }
 * `intensity` linearly blends the mode's correction matrix toward identity
 * (0 = no correction, 100 = full) — lets someone with a mild/anomalous
 * deficiency dial in less than the full correction instead of all-or-nothing.
 *
 * Defensive by design: a missing ctx.meet, no video tiles, or a missing
 * document never throws — the module logs and no-ops instead, per
 * ARCHITECTURE.md §1 ("never crash the call").
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const SVG_NS = "http://www.w3.org/2000/svg";
  const SVG_ROOT_ID = "aa-cvd-filter-defs";
  const VALID_MODES = ["protanopia", "deuteranopia", "tritanopia"];
  const DEFAULT_MODE = "deuteranopia";
  const DEFAULT_INTENSITY = 100;

  // Widely-published Brettel/Vienot daltonization correction matrices.
  // Each boosts the color channels that are hardest to discriminate for the
  // given deficiency, expressed as a 4x5 feColorMatrix "values" string.
  const MATRICES = {
    protanopia: [0.567, 0.433, 0, 0, 0, 0.558, 0.442, 0, 0, 0, 0, 0.242, 0.758, 0, 0, 0, 0, 0, 1, 0],
    deuteranopia: [0.625, 0.375, 0, 0, 0, 0.7, 0.3, 0, 0, 0, 0, 0.3, 0.7, 0, 0, 0, 0, 0, 1, 0],
    tritanopia: [0.95, 0.05, 0, 0, 0, 0, 0.433, 0.567, 0, 0, 0, 0.475, 0.525, 0, 0, 0, 0, 0, 1, 0],
  };

  // Identity 4x5 feColorMatrix — "no correction at all". Blending toward this
  // from the full MATRICES[mode] value (by `intensity`, 0-100) lets someone
  // with a mild deficiency dial in less-than-full correction, rather than
  // the all-or-nothing matrices above.
  const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

  // Linearly interpolates each matrix cell between identity (t=0) and the
  // mode's full correction matrix (t=1), t = intensity / 100.
  function blendedMatrixValues(mode, intensity) {
    const t = Math.min(100, Math.max(0, Number(intensity))) / 100;
    const full = MATRICES[mode] || MATRICES[DEFAULT_MODE];
    return full.map((v, i) => IDENTITY_MATRIX[i] + (v - IDENTITY_MATRIX[i]) * t).join(" ");
  }

  let log = AA.logger ? AA.logger.scope("colorblind") : console;
  let moduleCtx = null;
  let svgDefs = null; // the single injected <svg> defs node
  let matrixElsByMode = new Map(); // mode -> <feColorMatrix>, so intensity changes just update "values"
  let appliedElement = null; // the element currently carrying style.filter
  let currentMode = null;
  let currentIntensity = DEFAULT_INTENSITY;
  let isEnabled = false;

  function safeReportError(err) {
    try {
      moduleCtx?.reportError?.(err);
    } catch (_) {
      /* reportError must never throw back into us */
    }
  }

  function normalizeOptions(options) {
    const safe = options && typeof options === "object" ? options : {};
    const mode = VALID_MODES.includes(safe.mode) ? safe.mode : DEFAULT_MODE;
    const intensityNum = Number(safe.intensity);
    const intensity = Number.isFinite(intensityNum) ? Math.min(100, Math.max(0, intensityNum)) : DEFAULT_INTENSITY;
    return { enabled: safe.enabled !== false, mode, intensity };
  }

  // Finds the narrowest common ancestor of all current video tiles — i.e.
  // the call-area root — so the correction filter is applied once to the
  // whole grid rather than per-tile. Mirrors the approach meet-observer.js
  // uses for its MutationObserver root (ARCHITECTURE.md §7).
  function resolveTargetElement(meet) {
    if (!meet || typeof meet.getVideoTiles !== "function") return null;
    let tiles;
    try {
      tiles = meet.getVideoTiles();
    } catch (err) {
      log.error("getVideoTiles() threw", err);
      safeReportError(err);
      return null;
    }
    if (!Array.isArray(tiles) || tiles.length === 0) return null;

    try {
      let common = tiles[0].parentElement || tiles[0];
      for (let i = 1; i < tiles.length; i++) {
        const tile = tiles[i];
        while (common && !common.contains(tile)) {
          common = common.parentElement;
        }
      }
      return common || null;
    } catch (err) {
      log.error("failed to resolve call-area root from video tiles", err);
      safeReportError(err);
      return null;
    }
  }

  function buildSvgDefs() {
    if (typeof document === "undefined" || !document.body) {
      log.warn("no document.body available; cannot inject SVG filter defs");
      return null;
    }

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("id", SVG_ROOT_ID);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.style.position = "absolute";
    svg.style.width = "0";
    svg.style.height = "0";
    svg.style.overflow = "hidden";
    svg.style.pointerEvents = "none";

    matrixElsByMode = new Map();
    for (const mode of VALID_MODES) {
      const filter = document.createElementNS(SVG_NS, "filter");
      filter.setAttribute("id", `aa-cvd-${mode}`);
      filter.setAttribute("color-interpolation-filters", "sRGB");

      const feColorMatrix = document.createElementNS(SVG_NS, "feColorMatrix");
      feColorMatrix.setAttribute("type", "matrix");
      feColorMatrix.setAttribute("values", blendedMatrixValues(mode, DEFAULT_INTENSITY));

      filter.appendChild(feColorMatrix);
      svg.appendChild(filter);
      matrixElsByMode.set(mode, feColorMatrix);
    }

    document.body.appendChild(svg);
    return svg;
  }

  // Updates the given mode's <feColorMatrix> "values" in place — a plain
  // attribute write, not per-frame JS, so this stays within the perf budget
  // (ARCHITECTURE.md §7) even though it runs on every intensity slider tick.
  function setMatrixIntensity(mode, intensity) {
    const el = matrixElsByMode.get(mode);
    if (!el) return;
    el.setAttribute("values", blendedMatrixValues(mode, intensity));
  }

  // Creates the SVG defs node once (first enable()) and reuses it after —
  // update() only ever swaps which url(#aa-cvd-<mode>) is referenced.
  function ensureSvgDefs() {
    if (svgDefs && svgDefs.isConnected) return svgDefs;
    try {
      svgDefs = buildSvgDefs();
    } catch (err) {
      log.error("failed to inject SVG filter defs", err);
      safeReportError(err);
      svgDefs = null;
    }
    return svgDefs;
  }

  // Contributes via the shared composition registry (filter-registry.js)
  // rather than writing `el.style.filter` directly, so a second filter
  // module (e.g. contrast.js) targeting the same call-area root merges with
  // this one instead of one clobbering the other.
  function applyFilterToElement(el, mode) {
    if (!el || !el.style || !AA.filterRegistry) return;
    AA.filterRegistry.setFilterContribution(el, "colorblind", `url(#aa-cvd-${mode})`);
  }

  function restoreElement(el) {
    if (!el || !el.style || !AA.filterRegistry) return;
    AA.filterRegistry.clearFilterContribution(el, "colorblind");
  }

  function init(context) {
    moduleCtx = context || {};
    log = moduleCtx.logger || (AA.logger ? AA.logger.scope("colorblind") : console);
    log.info("init");
  }

  function enable(options) {
    if (!moduleCtx) {
      log.warn("enable() called before init(); ignoring");
      return;
    }

    const opts = normalizeOptions(options);
    if (!opts.enabled) {
      disable();
      return;
    }

    const defs = ensureSvgDefs();
    if (!defs) {
      log.warn("SVG filter defs unavailable; enable() no-op");
      return;
    }

    const target = resolveTargetElement(moduleCtx.meet);
    if (!target) {
      log.warn("no Meet video tiles found; enable() no-op");
      return;
    }

    setMatrixIntensity(opts.mode, opts.intensity);
    applyFilterToElement(target, opts.mode);
    appliedElement = target;
    currentMode = opts.mode;
    currentIntensity = opts.intensity;
    isEnabled = true;
    log.info(`enabled (mode: ${opts.mode}, intensity: ${opts.intensity})`);
  }

  function disable() {
    if (appliedElement) {
      restoreElement(appliedElement);
    }
    appliedElement = null;
    isEnabled = false;
    log.info("disabled");
  }

  function update(options) {
    if (!moduleCtx) {
      log.warn("update() called before init(); ignoring");
      return;
    }

    const opts = normalizeOptions(options);
    if (!opts.enabled) {
      disable();
      return;
    }

    const defs = ensureSvgDefs();
    if (!defs) {
      log.warn("SVG filter defs unavailable; update() no-op");
      return;
    }

    // Re-resolve in case Meet re-rendered the call grid under a new root.
    const target = resolveTargetElement(moduleCtx.meet);
    if (!target) {
      log.warn("no Meet video tiles found; update() no-op");
      return;
    }

    if (appliedElement && appliedElement !== target) {
      restoreElement(appliedElement);
    }

    setMatrixIntensity(opts.mode, opts.intensity);
    applyFilterToElement(target, opts.mode);
    appliedElement = target;
    currentMode = opts.mode;
    currentIntensity = opts.intensity;
    isEnabled = true;
    log.info(`updated -> mode: ${opts.mode}, intensity: ${opts.intensity}`);
  }

  function destroy() {
    if (appliedElement) {
      restoreElement(appliedElement);
      appliedElement = null;
    }
    if (svgDefs && svgDefs.parentNode) {
      svgDefs.parentNode.removeChild(svgDefs);
    }
    svgDefs = null;
    matrixElsByMode = new Map();
    currentMode = null;
    currentIntensity = DEFAULT_INTENSITY;
    isEnabled = false;
    log.info("destroyed");
  }

  AA.filters = AA.filters || {};
  AA.filters.colorblind = { id: "colorblind", init, enable, disable, update, destroy };
  AA.filterRegistry?.register(AA.filters.colorblind);
})(typeof window !== "undefined" ? window : globalThis);
