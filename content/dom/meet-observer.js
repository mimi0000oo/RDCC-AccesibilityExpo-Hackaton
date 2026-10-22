/**
 * content/dom/meet-observer.js
 * Detects Google Meet's call surface: video tiles, the active screenshare
 * tile, and light/dark theme. Meet's DOM/class names are unstable and
 * unofficial, so detection is heuristic and defensive by design — it must
 * degrade gracefully (empty results) rather than throw, per ARCHITECTURE.md §6.
 *
 * Public API: AA.meetObserver.start() / stop() -> MeetSurface
 *   MeetSurface: getVideoTiles(), getScreenshareNode(), getTheme(), on(event, cb)
 * Events emitted via AA.messaging: meet:tiles-changed, meet:screenshare-start,
 *   meet:screenshare-end, meet:theme-changed
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});
  const logger = AA.logger ? AA.logger.scope("meet-observer") : console;
  const messaging = AA.messaging;

  const DEBOUNCE_MS = 150;
  // Screenshare tiles are reliably much wider than camera tiles in Meet's grid.
  const SCREENSHARE_MIN_ASPECT = 1.6;
  const SCREENSHARE_MIN_WIDTH_PX = 480;

  let mutationObserver = null;
  let debounceHandle = null;
  let rootEl = null;
  let lastTileCount = 0;
  let lastScreenshareNode = null;
  let lastTheme = null;

  // Modules that clone live DOM (e.g. magnifier.js, which mirrors <video>
  // srcObject into a cloned lens) append their clone into the document, which
  // would otherwise make this very query pick its own injected videos back up
  // as "participant tiles" — a feedback loop (clone gets detected as a tile,
  // which balloons the next clone's root, which clones more, ...). Every
  // overlay/filter container tags itself with data-aa-overlay, so excluding
  // anything inside one closes that loop at the source.
  function getVideoTiles() {
    try {
      return Array.from(document.querySelectorAll("video")).filter(
        (v) => v.isConnected && v.videoWidth > 0 && v.videoHeight > 0 && !v.closest("[data-aa-overlay]")
      );
    } catch (err) {
      logger.error("getVideoTiles failed", err);
      return [];
    }
  }

  function getScreenshareNode() {
    try {
      const tiles = getVideoTiles();
      let best = null;
      for (const tile of tiles) {
        const aspect = tile.videoWidth / tile.videoHeight;
        if (aspect >= SCREENSHARE_MIN_ASPECT && tile.clientWidth >= SCREENSHARE_MIN_WIDTH_PX) {
          if (!best || tile.clientWidth > best.clientWidth) best = tile;
        }
      }
      return best;
    } catch (err) {
      logger.error("getScreenshareNode failed", err);
      return null;
    }
  }

  function getTheme() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const match = bg.match(/\d+/g);
      if (!match) return "dark"; // Meet defaults to dark
      const [r, g, b] = match.map(Number);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance > 0.5 ? "light" : "dark";
    } catch (err) {
      logger.error("getTheme failed", err);
      return "dark";
    }
  }

  // Finds the narrowest stable ancestor containing all current video tiles,
  // so MutationObserver never has to watch document.body (ARCHITECTURE.md §7).
  function findObservationRoot() {
    const tiles = getVideoTiles();
    if (tiles.length === 0) return document.body;
    let common = tiles[0].parentElement;
    for (const tile of tiles.slice(1)) {
      while (common && !common.contains(tile)) {
        common = common.parentElement;
      }
    }
    return common || document.body;
  }

  function checkForChanges() {
    try {
      const tiles = getVideoTiles();
      if (tiles.length !== lastTileCount) {
        lastTileCount = tiles.length;
        messaging?.emit("meet:tiles-changed", { count: tiles.length, tiles });
      }

      const screenshare = getScreenshareNode();
      if (screenshare !== lastScreenshareNode) {
        if (screenshare && !lastScreenshareNode) {
          messaging?.emit("meet:screenshare-start", { node: screenshare });
        } else if (!screenshare && lastScreenshareNode) {
          messaging?.emit("meet:screenshare-end", {});
        }
        lastScreenshareNode = screenshare;
      }

      const theme = getTheme();
      if (theme !== lastTheme) {
        lastTheme = theme;
        messaging?.emit("meet:theme-changed", { theme });
      }

      // Re-root the observer if Meet re-renders the call grid under a new container.
      const newRoot = findObservationRoot();
      if (newRoot !== rootEl) {
        rebind(newRoot);
      }
    } catch (err) {
      logger.error("checkForChanges failed", err);
    }
  }

  function scheduleCheck() {
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(checkForChanges, DEBOUNCE_MS);
  }

  function rebind(newRoot) {
    if (mutationObserver) mutationObserver.disconnect();
    rootEl = newRoot;
    mutationObserver = new MutationObserver(scheduleCheck);
    mutationObserver.observe(rootEl, { childList: true, subtree: true });
  }

  function start() {
    try {
      rootEl = findObservationRoot();
      mutationObserver = new MutationObserver(scheduleCheck);
      mutationObserver.observe(rootEl, { childList: true, subtree: true });
      checkForChanges();
      logger.info("started, observing root:", rootEl === document.body ? "document.body (fallback)" : rootEl.tagName);
    } catch (err) {
      logger.error("start failed", err);
    }
    return surface;
  }

  function stop() {
    try {
      if (mutationObserver) mutationObserver.disconnect();
      if (debounceHandle) clearTimeout(debounceHandle);
      mutationObserver = null;
      debounceHandle = null;
    } catch (err) {
      logger.error("stop failed", err);
    }
  }

  const surface = {
    getVideoTiles,
    getScreenshareNode,
    getTheme,
    on: (event, cb) => messaging?.on(event, cb) || (() => {}),
  };

  AA.meetObserver = { start, stop, surface };
})(typeof window !== "undefined" ? window : globalThis);
