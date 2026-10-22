/**
 * utils/logger.js
 * Scoped console logger. Never logs user content, PII, or Meet participant data —
 * only module lifecycle / perf / error metadata. Verbose levels are dev-only.
 *
 * Public API: AA.logger.scope(name) -> { debug, info, warn, error }
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  let currentLevel = LEVELS.info;

  function setLevel(level) {
    if (level in LEVELS) currentLevel = LEVELS[level];
  }

  function scope(name) {
    const prefix = `[MeetAssist:${name}]`;
    return {
      debug: (...args) => {
        if (currentLevel <= LEVELS.debug) console.debug(prefix, ...args);
      },
      info: (...args) => {
        if (currentLevel <= LEVELS.info) console.info(prefix, ...args);
      },
      warn: (...args) => {
        if (currentLevel <= LEVELS.warn) console.warn(prefix, ...args);
      },
      error: (...args) => {
        if (currentLevel <= LEVELS.error) console.error(prefix, ...args);
      },
    };
  }

  AA.logger = { scope, setLevel };
})(typeof window !== "undefined" ? window : globalThis);
