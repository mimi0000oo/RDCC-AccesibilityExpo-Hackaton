/**
 * content/overlays/overlay-registry.js
 * Shared lifecycle contract + fault isolation for all OverlayModule
 * implementations (reading-ruler.js, magnifier.js, focus-tracker.js).
 * Mirrors content/filters/filter-registry.js (ARCHITECTURE.md §4, §6).
 *
 * OverlayModule shape: { id, init(ctx), enable(options), disable(),
 *   update(options), destroy(), onFrame(timestamp) }
 * `onFrame` is optional — only overlays that need per-frame positioning
 * (magnifier following the cursor, a reading ruler following focus) provide
 * it. It is called through AA.perf.scheduleFrame()'s single shared rAF loop
 * (utils/perf.js), so N overlays never run N competing requestAnimationFrame
 * loops (ARCHITECTURE.md §7) — one bad overlay frame also can't stop others,
 * since each onFrame call is wrapped the same way filter calls are.
 *
 * Public API (same shape as AA.filterRegistry, intentionally):
 *   AA.overlayRegistry.register(module)
 *   AA.overlayRegistry.initAll(ctx)
 *   AA.overlayRegistry.enable(id, options) / disable(id) / update(id, options)
 *   AA.overlayRegistry.destroyAll()
 *   AA.overlayRegistry.getStatus() -> { [id]: "ok" | "disabled-error" }
 *   AA.overlayRegistry.setFilterContribution / clearFilterContribution
 *     (re-exported passthrough to filter-registry.js's composition map, so
 *     an overlay that also needs to contribute a CSS `filter:` value — e.g.
 *     a focus-dim effect — composes correctly with active filter modules
 *     instead of clobbering them.)
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});
  const logger = AA.logger ? AA.logger.scope("overlay-registry") : console;
  const perf = AA.perf;

  const modules = new Map(); // id -> OverlayModule
  const status = new Map(); // id -> "ok" | "disabled-error"
  const frameSubscriptions = new Map(); // id -> unsubscribe fn (only while enabled + has onFrame)
  let ctx = null;

  function register(module) {
    if (!module || !module.id) {
      logger.error("rejected module registration: missing id", module);
      return;
    }
    modules.set(module.id, module);
    status.set(module.id, "ok");
  }

  function safeCall(id, fn, ...args) {
    const module = modules.get(id);
    if (!module || status.get(id) === "disabled-error") return undefined;
    try {
      const run = () => module[fn]?.(...args);
      return perf ? perf.timeSync(`overlay:${id}:${fn}`, run) : run();
    } catch (err) {
      logger.error(`module "${id}" threw in "${fn}", disabling it`, err);
      status.set(id, "disabled-error");
      stopFrameLoop(id);
      AA.messaging?.emit("module:error", { id, fn, error: String(err) });
      try {
        module.destroy?.();
      } catch (_) {
        /* best-effort teardown, already in error state */
      }
      return undefined;
    }
  }

  function startFrameLoop(id) {
    const module = modules.get(id);
    if (!module || typeof module.onFrame !== "function") return;
    if (frameSubscriptions.has(id)) return; // already running
    if (!perf || typeof perf.scheduleFrame !== "function") {
      logger.warn(`AA.perf.scheduleFrame unavailable; "${id}" will not receive onFrame callbacks`);
      return;
    }
    const unsubscribe = perf.scheduleFrame((timestamp) => safeCall(id, "onFrame", timestamp));
    frameSubscriptions.set(id, unsubscribe);
  }

  function stopFrameLoop(id) {
    const unsubscribe = frameSubscriptions.get(id);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (_) {
        /* best-effort */
      }
      frameSubscriptions.delete(id);
    }
  }

  function initAll(context) {
    ctx = context;
    for (const id of modules.keys()) safeCall(id, "init", ctx);
    AA.messaging?.emit("module:ready", { ids: Array.from(modules.keys()) });
  }

  function enable(id, options) {
    safeCall(id, "enable", options);
    if (status.get(id) === "ok") startFrameLoop(id);
  }

  function disable(id) {
    stopFrameLoop(id);
    safeCall(id, "disable");
  }

  function update(id, options) {
    safeCall(id, "update", options);
  }

  function destroyAll() {
    for (const id of modules.keys()) {
      stopFrameLoop(id);
      safeCall(id, "destroy");
    }
    AA.messaging?.emit("module:destroyed", { ids: Array.from(modules.keys()) });
  }

  function getStatus() {
    return Object.fromEntries(status);
  }

  AA.overlayRegistry = {
    register,
    initAll,
    enable,
    disable,
    update,
    destroyAll,
    getStatus,
    // Passthrough so overlays can compose CSS `filter:` contributions with
    // active filter modules via the same mechanism (filter-registry.js).
    setFilterContribution: (...args) => AA.filterRegistry?.setFilterContribution(...args),
    clearFilterContribution: (...args) => AA.filterRegistry?.clearFilterContribution(...args),
  };
})(typeof window !== "undefined" ? window : globalThis);
