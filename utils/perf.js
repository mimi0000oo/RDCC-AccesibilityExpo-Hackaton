/**
 * utils/perf.js
 * Lightweight perf-budget instrumentation. Enforces ARCHITECTURE.md §7:
 *  - lifecycle calls (init/enable/disable/update/destroy) budgeted at <=15ms
 *  - exposes a single shared rAF scheduler so overlays never run N competing loops
 *
 * Public API: AA.perf.timeSync(label, fn), AA.perf.budgetMs,
 *             AA.perf.scheduleFrame(cb) -> unsubscribe, AA.perf.getLastReport()
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});
  const logger = AA.logger ? AA.logger.scope("perf") : console;

  const BUDGET_MS = 15;
  const lastReport = new Map();

  function timeSync(label, fn) {
    const start = performance.now();
    let result;
    try {
      result = fn();
    } finally {
      const elapsed = performance.now() - start;
      lastReport.set(label, elapsed);
      if (elapsed > BUDGET_MS) {
        logger.warn(`"${label}" took ${elapsed.toFixed(2)}ms, over ${BUDGET_MS}ms budget`);
      }
    }
    return result;
  }

  // Single shared rAF loop. Modules register per-frame callbacks here instead of
  // calling requestAnimationFrame themselves, so N overlays cost one scheduler.
  const frameCallbacks = new Set();
  let rafHandle = null;

  function tick(timestamp) {
    for (const cb of frameCallbacks) {
      try {
        cb(timestamp);
      } catch (err) {
        logger.error("frame callback threw, removing it", err);
        frameCallbacks.delete(cb);
      }
    }
    if (frameCallbacks.size > 0) {
      rafHandle = requestAnimationFrame(tick);
    } else {
      rafHandle = null;
    }
  }

  function scheduleFrame(cb) {
    frameCallbacks.add(cb);
    if (rafHandle === null) {
      rafHandle = requestAnimationFrame(tick);
    }
    return () => frameCallbacks.delete(cb);
  }

  AA.perf = {
    budgetMs: BUDGET_MS,
    timeSync,
    scheduleFrame,
    getLastReport: () => Object.fromEntries(lastReport),
  };
})(typeof window !== "undefined" ? window : globalThis);
