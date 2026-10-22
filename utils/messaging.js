/**
 * utils/messaging.js
 * Typed in-page event bus (content <-> content) PLUS a thin wrapper over
 * chrome.runtime messaging (content <-> popup <-> background).
 * Event names are namespaced "source:event" per ARCHITECTURE.md §5.
 *
 * Public API:
 *   AA.messaging.emit(event, payload)
 *   AA.messaging.on(event, cb) -> unsubscribe
 *   AA.messaging.broadcastRuntime(event, payload)  // chrome.runtime.sendMessage
 *   AA.messaging.onRuntime(cb) -> unsubscribe      // chrome.runtime.onMessage
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});
  const logger = AA.logger ? AA.logger.scope("messaging") : console;

  const listeners = new Map(); // event -> Set<cb>

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch (err) {
        logger.error(`listener for "${event}" threw`, err);
      }
    }
  }

  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event)?.delete(cb);
  }

  function hasRuntime() {
    return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
  }

  function broadcastRuntime(event, payload) {
    if (!hasRuntime()) return;
    try {
      chrome.runtime.sendMessage({ event, payload }, () => {
        // Swallow "no receiver" errors — popup/background may not be open.
        void chrome.runtime.lastError;
      });
    } catch (err) {
      logger.debug("broadcastRuntime failed (receiver likely closed)", err);
    }
  }

  function onRuntime(cb) {
    if (!hasRuntime() || !chrome.runtime.onMessage) return () => {};
    const listener = (message, sender, sendResponse) => {
      try {
        cb(message, sender, sendResponse);
      } catch (err) {
        logger.error("onRuntime handler threw", err);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }

  AA.messaging = { emit, on, broadcastRuntime, onRuntime };
})(typeof window !== "undefined" ? window : globalThis);
