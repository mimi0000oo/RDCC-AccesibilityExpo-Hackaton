/**
 * content/overlays/magnifier.js
 * Cursor-follow screen magnifier ("loupe") for low-vision users. Implements
 * the OverlayModule contract (ARCHITECTURE.md §4): init(ctx), enable(options),
 * disable(), update(options), destroy(), onFrame(timestamp).
 *
 * PRIVACY (ARCHITECTURE.md §8): this module never reads video/screen pixel
 * data. It does NOT draw any <video> to a <canvas> and does NOT call
 * getImageData/toDataURL/getDisplayMedia. The "magnification" is achieved
 * purely with DOM + CSS transforms:
 *   1. Resolve the "magnifiable root" the same way content/filters/contrast.js
 *      resolves its call-area root: nearest common ancestor of
 *      ctx.meet.getVideoTiles(), falling back to document.body.
 *   2. Deep-clone that root once (`root.cloneNode(true)`) into a small fixed
 *      "lens" element appended to document.body.
 *   3. cloneNode() does not carry a live <video>'s `srcObject` (a JS
 *      property, not an HTML attribute), so the clone would otherwise show a
 *      blank frame. We walk the clone's <video> elements, match each to the
 *      original by DOM order, and copy `srcObject` across so the lens plays
 *      the exact same live MediaStream a second time — this replays an
 *      in-browser stream reference, it never samples pixels.
 *   4. Position the lens (fixed, viewport coords) and the cloned content
 *      inside it (CSS `transform: translate(...) scale(zoom)`) every frame
 *      based on the latest mouse position. Mouse tracking is a single cheap
 *      `mousemove` listener that only stores coordinates; all math happens in
 *      `onFrame`, called by overlay-registry.js's single shared rAF loop
 *      (ARCHITECTURE.md §7) — this module never calls requestAnimationFrame
 *      itself.
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const MODULE_ID = "magnifier";
  const DEFAULT_ZOOM = 2;
  const MIN_ZOOM = 1.5;
  const MAX_ZOOM = 4;
  const DEFAULT_SHAPE = "circle";
  const DEFAULT_LENS_SIZE = 220; // px diameter — independent of zoom, how much of the
  const MIN_LENS_SIZE = 120; // screen the lens itself covers, not how magnified it is
  const MAX_LENS_SIZE = 480;
  const TILE_CHECK_INTERVAL_FRAMES = 30; // ~0.5s at 60fps; keeps onFrame cheap

  let ctx = null;
  let logger = null;

  let enabled = false;
  let zoom = DEFAULT_ZOOM;
  let shape = DEFAULT_SHAPE;
  let lensSize = DEFAULT_LENS_SIZE;

  let pointerX = null;
  let pointerY = null;
  let mousemoveHandler = null;

  let lensEl = null;
  let contentEl = null;
  let clonedRootEl = null;
  let clonedVideoEls = [];
  let magnifiableRootEl = null;

  let frameCount = 0;
  let lastTileCount = -1;

  let unsubTilesChanged = null;
  let unsubScreenshareStart = null;
  let unsubScreenshareEnd = null;

  function getLogger() {
    if (logger) return logger;
    if (ctx && ctx.logger) return ctx.logger;
    if (AA.logger && typeof AA.logger.scope === "function") {
      return AA.logger.scope("overlays:magnifier");
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

  function clampZoom(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_ZOOM;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
  }

  function clampLensSize(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_LENS_SIZE;
    return Math.min(MAX_LENS_SIZE, Math.max(MIN_LENS_SIZE, n));
  }

  // Resolves the single element to magnify: the nearest common ancestor of
  // the current video tiles (same technique as content/filters/contrast.js's
  // findCallAreaRoot), falling back to document.body when no tiles/meet
  // surface are available. Never throws (ARCHITECTURE.md §6).
  function resolveMagnifiableRoot() {
    try {
      if (typeof document === "undefined") return null;
      const tiles =
        ctx && ctx.meet && typeof ctx.meet.getVideoTiles === "function" ? ctx.meet.getVideoTiles() : [];
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
      getLogger().error?.("resolveMagnifiableRoot failed, falling back to body", err);
      try {
        return document.body || document.documentElement || null;
      } catch (_) {
        return null;
      }
    }
  }

  function ensureLens() {
    if (lensEl && contentEl) return;
    try {
      lensEl = document.createElement("div");
      lensEl.setAttribute("data-aa-overlay", "magnifier");
      lensEl.style.position = "fixed";
      lensEl.style.top = "0";
      lensEl.style.left = "0";
      lensEl.style.width = lensSize + "px";
      lensEl.style.height = lensSize + "px";
      lensEl.style.overflow = "hidden";
      lensEl.style.pointerEvents = "none";
      lensEl.style.zIndex = "2147483647";
      lensEl.style.background = "#000";
      lensEl.style.boxShadow = "0 0 0 2px rgba(0,0,0,0.6), 0 4px 18px rgba(0,0,0,0.45)";
      lensEl.style.border = "3px solid rgba(255,255,255,0.92)";
      lensEl.style.visibility = "hidden"; // shown once we have a real pointer position
      lensEl.style.willChange = "transform";

      contentEl = document.createElement("div");
      contentEl.style.position = "absolute";
      contentEl.style.top = "0";
      contentEl.style.left = "0";
      contentEl.style.transformOrigin = "0 0";
      contentEl.style.willChange = "transform";
      contentEl.style.pointerEvents = "none";

      lensEl.appendChild(contentEl);
      document.body.appendChild(lensEl);
    } catch (err) {
      safeReportError(err);
    }
  }

  function applyShapeStyle() {
    if (!lensEl) return;
    try {
      lensEl.style.borderRadius = shape === "rect" ? "0" : "50%";
    } catch (err) {
      safeReportError(err);
    }
  }

  function applyLensSize() {
    if (!lensEl) return;
    try {
      lensEl.style.width = lensSize + "px";
      lensEl.style.height = lensSize + "px";
    } catch (err) {
      safeReportError(err);
    }
  }

  function pauseVideos(list) {
    for (const cv of list) {
      try {
        cv.pause();
        cv.srcObject = null;
      } catch (_) {
        /* best-effort teardown */
      }
    }
  }

  // Full teardown (disable()/destroy() only) — removes the clone and leaves
  // the lens empty. cloneContent() below deliberately does NOT call this: a
  // tear-down-then-rebuild ordering leaves contentEl empty for a frame, which
  // shows the lens's black base background through (the bug this file used to
  // have — fixed by swapping instead of clearing-then-building).
  function clearClone() {
    pauseVideos(clonedVideoEls);
    clonedVideoEls = [];
    try {
      if (clonedRootEl && clonedRootEl.parentNode) {
        clonedRootEl.parentNode.removeChild(clonedRootEl);
      }
    } catch (_) {
      /* node may already be detached */
    }
    clonedRootEl = null;
    magnifiableRootEl = null;
  }

  // Deep-clones the resolved magnifiable root and mirrors each live <video>'s
  // srcObject across (see file header). Builds the replacement clone and
  // appends it BEFORE removing the previous one, so contentEl always has at
  // least one clone attached — no frame renders the lens with nothing in it.
  // Defensive: logs and no-ops on any failure instead of throwing (ARCHITECTURE.md §6).
  function cloneContent() {
    try {
      const root = resolveMagnifiableRoot();
      if (!root || !contentEl) {
        getLogger().warn?.("no magnifiable root resolved; keeping last known clone");
        return;
      }

      const rect = root.getBoundingClientRect();
      // Deliberately keeps ids as-is: id-selector CSS (Meet's unofficial,
      // unstable classnames/ids per meet-observer.js) can be load-bearing for
      // the clone's own layout — stripping ids here once silently dropped
      // grid-column assignment on an id-selected container, collapsing a
      // 3-column layout to stacked full-width blocks. The clone is inert
      // (pointer-events: none, never queried by id) and appended after the
      // live original in document order, so document.getElementById still
      // resolves to the original — duplicate ids cost nothing here.
      const clone = root.cloneNode(true);
      clone.style.width = rect.width + "px";
      clone.style.height = rect.height + "px";
      clone.style.margin = "0";
      clone.style.pointerEvents = "none";

      const originalVideos = root.querySelectorAll("video");
      const clonedVideos = clone.querySelectorAll("video");
      const mirrored = [];
      for (let i = 0; i < clonedVideos.length; i++) {
        const cv = clonedVideos[i];
        const ov = originalVideos[i];
        try {
          cv.muted = true;
          cv.playsInline = true;
          if (ov && ov.srcObject) {
            cv.srcObject = ov.srcObject; // same live MediaStream reference, no pixel read
          }
        } catch (err) {
          getLogger().warn?.("failed to mirror a cloned video's live stream", err);
        }
        mirrored.push(cv);
      }

      const previousRootEl = clonedRootEl;
      const previousVideoEls = clonedVideoEls;

      contentEl.appendChild(clone); // new clone attached...
      clonedRootEl = clone;
      clonedVideoEls = mirrored;
      magnifiableRootEl = root;

      if (previousRootEl && previousRootEl.parentNode) {
        previousRootEl.parentNode.removeChild(previousRootEl); // ...only now is the old one removed
      }
      pauseVideos(previousVideoEls);

      // play() is async and happens after the swap on purpose: the new video
      // painting its first frame a beat late is far less visible than a gap
      // with no clone at all, and play() must run on an element that's
      // already attached to the document for some browsers to honor it.
      for (const cv of mirrored) {
        if (!cv.srcObject) continue;
        try {
          const playResult = cv.play();
          if (playResult && typeof playResult.catch === "function") playResult.catch(() => {});
        } catch (_) {
          /* best-effort */
        }
      }
    } catch (err) {
      safeReportError(err);
    }
  }

  function removeLens() {
    try {
      if (lensEl && lensEl.parentNode) {
        lensEl.parentNode.removeChild(lensEl);
      }
    } catch (_) {
      /* already detached */
    }
    lensEl = null;
    contentEl = null;
  }

  function onMouseMove(e) {
    // Intentionally only stores coordinates — all positioning math happens
    // in onFrame so this handler stays off the main-thread event budget.
    pointerX = e.clientX;
    pointerY = e.clientY;
  }

  function positionLens() {
    if (!lensEl || !contentEl || !magnifiableRootEl) return;
    if (pointerX === null || pointerY === null) return;

    const rect = magnifiableRootEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const mx = Math.min(rect.right, Math.max(rect.left, pointerX));
    const my = Math.min(rect.bottom, Math.max(rect.top, pointerY));
    const localX = mx - rect.left;
    const localY = my - rect.top;
    const lensRadius = lensSize / 2;

    // Lens itself, in viewport/fixed coords, centered on the cursor.
    lensEl.style.transform = `translate3d(${mx - lensRadius}px, ${my - lensRadius}px, 0)`;

    // Inner clone: scale(zoom) applied first (around transform-origin 0 0),
    // then translated so the point under the cursor lands at lens-local
    // (lensRadius, lensRadius) — i.e. dead center of the lens.
    contentEl.style.transform =
      `translate(${lensRadius - localX * zoom}px, ${lensRadius - localY * zoom}px) scale(${zoom})`;

    if (clonedRootEl) {
      // Keep the clone's footprint in sync with the live root's size (e.g.
      // on window/tile resize) without re-cloning.
      clonedRootEl.style.width = rect.width + "px";
      clonedRootEl.style.height = rect.height + "px";
    }

    lensEl.style.visibility = "visible";
  }

  // Screenshare starting/ending keeps the same tile count but completely
  // restructures Meet's grid (main area becomes the shared screen, cameras
  // shrink into a sidebar strip). The tile-count poll below doesn't catch
  // that, so the magnifier kept showing a stale clone misaligned with the
  // live cursor position — subscribing directly makes it reclone immediately
  // instead of waiting up to ~0.5s (or never, since the count didn't change).
  function subscribeMeetEvents() {
    try {
      if (!ctx || !ctx.meet || typeof ctx.meet.on !== "function") return;
      if (!unsubTilesChanged) unsubTilesChanged = ctx.meet.on("meet:tiles-changed", cloneContent);
      if (!unsubScreenshareStart) unsubScreenshareStart = ctx.meet.on("meet:screenshare-start", cloneContent);
      if (!unsubScreenshareEnd) unsubScreenshareEnd = ctx.meet.on("meet:screenshare-end", cloneContent);
    } catch (err) {
      safeReportError(err);
    }
  }

  function unsubscribeMeetEvents() {
    for (const unsub of [unsubTilesChanged, unsubScreenshareStart, unsubScreenshareEnd]) {
      try {
        unsub?.();
      } catch (_) {
        /* best-effort */
      }
    }
    unsubTilesChanged = null;
    unsubScreenshareStart = null;
    unsubScreenshareEnd = null;
  }

  function maybeRecloneForTileChanges() {
    try {
      const tiles =
        ctx && ctx.meet && typeof ctx.meet.getVideoTiles === "function" ? ctx.meet.getVideoTiles() : [];
      const rootStillValid = magnifiableRootEl && magnifiableRootEl.isConnected;
      if (!rootStillValid || tiles.length !== lastTileCount) {
        lastTileCount = tiles.length;
        cloneContent();
      }
    } catch (err) {
      safeReportError(err);
    }
  }

  function init(context) {
    try {
      ctx = context || null;
      logger =
        (ctx && ctx.logger) ||
        (AA.logger && typeof AA.logger.scope === "function" ? AA.logger.scope("overlays:magnifier") : console);
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

      zoom = opts.zoom !== undefined ? clampZoom(opts.zoom) : clampZoom(zoom);
      shape = opts.shape === "rect" ? "rect" : opts.shape === "circle" ? "circle" : shape || DEFAULT_SHAPE;
      lensSize = opts.size !== undefined ? clampLensSize(opts.size) : clampLensSize(lensSize);

      ensureLens();
      applyShapeStyle();
      applyLensSize();
      frameCount = 0;
      lastTileCount = -1; // deliberately NOT cloning here: cloneContent() is a
      // real DOM-cloning cost (~16ms with a few tiles) that would blow the
      // <=15ms lifecycle-call budget (ARCHITECTURE.md §7) if run synchronously
      // inside enable(). onFrame()'s existing lazy-clone check
      // (`!magnifiableRootEl`) picks it up on the very next rAF tick instead,
      // so toggling the magnifier on stays instant and the clone cost is paid
      // on a frame tick rather than blocking the enable() call.

      if (!mousemoveHandler) {
        mousemoveHandler = onMouseMove;
        window.addEventListener("mousemove", mousemoveHandler, { passive: true });
      }

      subscribeMeetEvents(); // immediate reclone on tile/screenshare changes, not just the ~0.5s poll

      enabled = true;
      getLogger().info?.(`enabled (zoom=${zoom}, shape=${shape}, size=${lensSize})`);
    } catch (err) {
      safeReportError(err);
    }
  }

  function disable() {
    try {
      if (mousemoveHandler) {
        window.removeEventListener("mousemove", mousemoveHandler);
        mousemoveHandler = null;
      }
      unsubscribeMeetEvents();
      clearClone();
      removeLens();
      pointerX = null;
      pointerY = null;
      frameCount = 0;
      lastTileCount = -1;
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
      if (opts.zoom !== undefined) zoom = clampZoom(opts.zoom);
      if (opts.shape === "circle" || opts.shape === "rect") {
        shape = opts.shape;
        if (lensEl) applyShapeStyle();
      }
      if (opts.size !== undefined) {
        lensSize = clampLensSize(opts.size);
        if (lensEl) applyLensSize();
      }

      if (!enabled) {
        if (opts.enabled === true) enable(opts);
        return;
      }

      // Lens/content already exist — update in place, no recreation/re-clone.
      getLogger().debug?.(`updated (zoom=${zoom}, shape=${shape}, size=${lensSize})`);
    } catch (err) {
      safeReportError(err);
    }
  }

  function destroy() {
    try {
      disable(); // removes listener + lens DOM + pauses cloned videos
      getLogger().info?.("destroyed");
    } catch (err) {
      safeReportError(err);
    } finally {
      ctx = null;
      logger = null;
      zoom = DEFAULT_ZOOM;
      shape = DEFAULT_SHAPE;
      lensSize = DEFAULT_LENS_SIZE;
      frameCount = 0;
      lastTileCount = -1;
    }
  }

  function onFrame(_timestamp) {
    if (!enabled || !lensEl || !contentEl) return;

    frameCount++;
    if (frameCount % TILE_CHECK_INTERVAL_FRAMES === 0 || !magnifiableRootEl) {
      maybeRecloneForTileChanges();
    }
    if (!magnifiableRootEl) return;

    positionLens();
  }

  AA.overlays = AA.overlays || {};
  AA.overlays.magnifier = {
    id: MODULE_ID,
    init,
    enable,
    disable,
    update,
    destroy,
    onFrame,
  };
  AA.overlayRegistry?.register(AA.overlays.magnifier);
})(typeof window !== "undefined" ? window : globalThis);
