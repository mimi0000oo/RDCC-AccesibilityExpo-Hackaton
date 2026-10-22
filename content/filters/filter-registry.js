/**
 * content/filters/filter-registry.js
 * Shared lifecycle contract + fault isolation for all FilterModule implementations
 * (contrast.js, colorblind.js, inversion.js). Per ARCHITECTURE.md §4 and §6:
 * every filter module registers itself here instead of being called directly,
 * so one module throwing never stops the others or crashes Meet.
 *
 * FilterModule shape: { id, init(ctx), enable(options), disable(), update(options), destroy() }
 *
 * Public API:
 *   AA.filterRegistry.register(module)
 *   AA.filterRegistry.initAll(ctx)
 *   AA.filterRegistry.enable(id, options) / disable(id) / update(id, options)
 *   AA.filterRegistry.destroyAll()
 *   AA.filterRegistry.getStatus() -> { [id]: "ok" | "disabled-error" }
 *
 * CSS `filter` composition (integration seam, added after the wave-3 critic
 * pass found a real bug: contrast.js and colorblind.js can both resolve the
 * same call-area root element, and each was writing `element.style.filter`
 * directly — the second write silently clobbers the first, since CSS filter
 * declarations don't merge across separate assignments). Any filter module
 * that wants to apply a CSS `filter:` value to an element must go through
 * this instead of touching `el.style.filter` itself, so N modules targeting
 * the same element compose into one merged value instead of overwriting:
 *   AA.filterRegistry.setFilterContribution(el, moduleId, "contrast(1.4) ...")
 *   AA.filterRegistry.clearFilterContribution(el, moduleId)
 * The element's original inline `filter` value (if any, set by something
 * outside this extension) is captured on first contribution and restored
 * once the last contribution is cleared — no lingering trace.
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});
  const logger = AA.logger ? AA.logger.scope("filter-registry") : console;
  const perf = AA.perf;

  const modules = new Map(); // id -> FilterModule
  const status = new Map(); // id -> "ok" | "disabled-error"
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
      return perf ? perf.timeSync(`filter:${id}:${fn}`, run) : run();
    } catch (err) {
      logger.error(`module "${id}" threw in "${fn}", disabling it`, err);
      status.set(id, "disabled-error");
      AA.messaging?.emit("module:error", { id, fn, error: String(err) });
      try {
        module.destroy?.();
      } catch (_) {
        /* best-effort teardown, already in error state */
      }
      return undefined;
    }
  }

  function initAll(context) {
    ctx = context;
    for (const id of modules.keys()) safeCall(id, "init", ctx);
    AA.messaging?.emit("module:ready", { ids: Array.from(modules.keys()) });
  }

  function enable(id, options) {
    safeCall(id, "enable", options);
  }

  function disable(id) {
    safeCall(id, "disable");
  }

  function update(id, options) {
    safeCall(id, "update", options);
  }

  function destroyAll() {
    for (const id of modules.keys()) safeCall(id, "destroy");
    AA.messaging?.emit("module:destroyed", { ids: Array.from(modules.keys()) });
  }

  function getStatus() {
    return Object.fromEntries(status);
  }

  // element -> Map<moduleId, filterString>
  const filterContributions = new WeakMap();
  // element -> original inline `filter` value, captured before our first write
  const originalFilters = new WeakMap();

  function recomputeFilter(el) {
    const contributions = filterContributions.get(el);
    if (!contributions || contributions.size === 0) {
      const original = originalFilters.get(el) || "";
      if (original) {
        el.style.setProperty("filter", original);
      } else {
        el.style.removeProperty("filter");
      }
      return;
    }
    el.style.setProperty("filter", Array.from(contributions.values()).join(" "));
  }

  function setFilterContribution(el, moduleId, filterString) {
    if (!el || !el.style || !filterString) return;
    if (!originalFilters.has(el)) {
      originalFilters.set(el, el.style.getPropertyValue("filter"));
    }
    if (!filterContributions.has(el)) {
      filterContributions.set(el, new Map());
    }
    filterContributions.get(el).set(moduleId, filterString);
    recomputeFilter(el);
  }

  function clearFilterContribution(el, moduleId) {
    if (!el || !el.style) return;
    const contributions = filterContributions.get(el);
    if (!contributions || !contributions.has(moduleId)) return;
    contributions.delete(moduleId);
    recomputeFilter(el);
  }

  AA.filterRegistry = {
    register,
    initAll,
    enable,
    disable,
    update,
    destroyAll,
    getStatus,
    setFilterContribution,
    clearFilterContribution,
  };
})(typeof window !== "undefined" ? window : globalThis);
