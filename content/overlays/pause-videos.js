/**
 * content/overlays/pause-videos.js
 * On-screen "Pause videos" button for ADHD (and anyone who needs a still
 * screen). Implements the OverlayModule contract (ARCHITECTURE.md §4):
 * init(ctx), enable(options), disable(), update(options), destroy().
 *
 * While enabled, a button sits in the shared bottom-right dock
 * (utils/floating-dock.js). Clicking it pauses every <video> — camera tiles
 * AND the shared screen — so nothing on screen moves; clicking again
 * resumes them. Videos start playing normally each time the module is
 * enabled; nothing is paused until the user clicks.
 *
 * Holding the pause: Meet calls play() on its own videos whenever they stop,
 * which silently undid a one-off pause(). So paused videos are marked
 * data-aa-paused and content/main-world/media-guard.js turns Meet's play()
 * calls on them into no-ops; as a backstop each is re-paused on its "play"
 * event, and a 500ms sweep picks up videos that appear later (a screen
 * share starting, a tile rebuilt). Everything it paused is resumed on
 * resume/disable()/destroy().
 *
 * Replaces the former reduce-motion.js: its UI-animation freezing was
 * removed; its pause-all-videos option became this module.
 *
 * Options shape (ARCHITECTURE.md §3): { enabled }.
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const MODULE_ID = "pauseVideos";
  const DOCK_ORDER = 10; // left of "Catch me up" (ai-recap.js, order 20)
  const SWEEP_MS = 500;
  const VIDEO_RESUME_EVENTS = ["play", "playing"];
  const REPAUSE_WINDOW_MS = 2000;
  const REPAUSE_MAX_PER_WINDOW = 20;
  const PAUSED_ATTR = "data-aa-paused"; // read by content/main-world/media-guard.js
  const LABEL_PAUSE = "Pause videos";
  const LABEL_RESUME = "Resume videos";

  let ctx = null;
  let logger = null;
  let enabled = false;
  let destroyed = false;
  let paused = false; // the user's choice via the on-screen button

  let buttonEl = null;
  let sweepTimer = null;
  const pausedByUs = new Set(); // <video> elements this module paused, so it only resumes its own
  const repauseStats = new WeakMap(); // <video> -> { count, since } re-pauses in the current window

  function getLogger() {
    if (logger) return logger;
    if (ctx && ctx.logger) return ctx.logger;
    if (AA.logger && typeof AA.logger.scope === "function") {
      return AA.logger.scope("overlays:pause-videos");
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

  // Every <video> on the page that isn't ours: camera tiles and the shared
  // screen, including ones that haven't decoded a frame yet.
  function getAllVideos() {
    try {
      return Array.from(document.querySelectorAll("video")).filter(
        (v) => v.isConnected && !v.closest("[data-aa-overlay]")
      );
    } catch (err) {
      getLogger().error?.("video lookup failed, treating as empty", err);
      return [];
    }
  }

  // ---- pausing -----------------------------------------------------------

  function repauseOnResume(event) {
    const video = event.target;
    if (!enabled || !paused || destroyed) return;
    // If Meet fights back instantly (pause -> play -> pause …), stop the
    // ping-pong for that video and let the 500ms sweep re-pause it instead.
    const now = Date.now();
    const stats = repauseStats.get(video) || { count: 0, since: now };
    if (now - stats.since > REPAUSE_WINDOW_MS) {
      stats.count = 0;
      stats.since = now;
    }
    stats.count++;
    repauseStats.set(video, stats);
    if (stats.count > REPAUSE_MAX_PER_WINDOW) return;
    try {
      video.pause();
    } catch (_) {
      /* best-effort */
    }
  }

  function pauseVideo(video) {
    if (!pausedByUs.has(video)) {
      for (const type of VIDEO_RESUME_EVENTS) video.addEventListener(type, repauseOnResume);
      pausedByUs.add(video);
    }
    // Tells content/main-world/media-guard.js to ignore Meet's own play() calls on it.
    if (!video.hasAttribute(PAUSED_ATTR)) video.setAttribute(PAUSED_ATTR, "");
    try {
      if (!video.paused) video.pause();
    } catch (_) {
      /* best-effort */
    }
  }

  function forgetVideo(video) {
    for (const type of VIDEO_RESUME_EVENTS) video.removeEventListener(type, repauseOnResume);
    video.removeAttribute(PAUSED_ATTR);
    pausedByUs.delete(video);
  }

  function pauseAllVideos() {
    const live = new Set(getAllVideos());
    for (const video of Array.from(pausedByUs)) {
      if (!live.has(video)) forgetVideo(video); // left the call — don't hold a detached node (ARCHITECTURE.md §7)
    }
    for (const video of live) pauseVideo(video); // also catches the shared screen and newly joined tiles
  }

  function resumeAllPausedVideos() {
    for (const video of Array.from(pausedByUs)) {
      forgetVideo(video);
      try {
        const playResult = video.play();
        if (playResult && typeof playResult.catch === "function") playResult.catch(() => {});
      } catch (_) {
        /* best-effort — video may be detached */
      }
    }
    pausedByUs.clear();
  }

  function startSweep() {
    stopSweep();
    sweepTimer = global.setInterval(() => {
      try {
        if (enabled && paused && !destroyed) pauseAllVideos();
      } catch (err) {
        safeReportError(err);
      }
    }, SWEEP_MS);
  }

  function stopSweep() {
    if (sweepTimer) {
      global.clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function setPaused(next) {
    paused = next;
    if (paused) {
      pauseAllVideos();
      startSweep();
    } else {
      stopSweep();
      resumeAllPausedVideos();
    }
    renderButton();
  }

  // ---- on-screen button --------------------------------------------------

  function renderButton() {
    if (!buttonEl) return;
    buttonEl.textContent = paused ? LABEL_RESUME : LABEL_PAUSE;
    buttonEl.setAttribute("aria-pressed", String(paused));
    buttonEl.style.background = paused ? "#5f6368" : "#1a73e8";
  }

  function handleButtonClick() {
    try {
      if (!enabled || destroyed) return;
      setPaused(!paused);
    } catch (err) {
      safeReportError(err);
    }
  }

  function ensureButton() {
    if (buttonEl || !AA.floatingDock) return;
    buttonEl = AA.floatingDock.createButton(LABEL_PAUSE);
    buttonEl.id = "aa-pause-videos-button";
    buttonEl.setAttribute("data-aa-overlay", MODULE_ID);
    buttonEl.addEventListener("click", handleButtonClick);
    AA.floatingDock.add(buttonEl, DOCK_ORDER);
    renderButton();
  }

  function removeButton() {
    if (!buttonEl) return;
    buttonEl.removeEventListener("click", handleButtonClick);
    AA.floatingDock?.remove(buttonEl);
    buttonEl = null;
  }

  // ---- lifecycle ---------------------------------------------------------

  function init(context) {
    try {
      ctx = context || null;
      destroyed = false;
      logger =
        (ctx && ctx.logger) ||
        (AA.logger && typeof AA.logger.scope === "function" ? AA.logger.scope("overlays:pause-videos") : console);
      getLogger().debug?.("init");
    } catch (err) {
      safeReportError(err);
    }
  }

  function enable(options) {
    try {
      if (destroyed) return;
      const opts = options || {};
      if (opts.enabled === false) {
        disable();
        return;
      }
      if (enabled) return; // already showing the button — keep the user's current pause state
      if (typeof document === "undefined" || !document.body) {
        getLogger().warn?.("document.body unavailable, no-op");
        return;
      }
      enabled = true;
      paused = false;
      ensureButton();
      getLogger().info?.("enabled");
    } catch (err) {
      safeReportError(err);
    }
  }

  function disable() {
    try {
      stopSweep();
      resumeAllPausedVideos();
      removeButton();
      paused = false;
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
      if (!enabled && opts.enabled === true) enable(opts);
    } catch (err) {
      safeReportError(err);
    }
  }

  function destroy() {
    try {
      disable();
      getLogger().info?.("destroyed");
    } catch (err) {
      safeReportError(err);
    } finally {
      ctx = null;
      logger = null;
      destroyed = true;
    }
  }

  AA.overlays = AA.overlays || {};
  AA.overlays.pauseVideos = {
    id: MODULE_ID,
    init,
    enable,
    disable,
    update,
    destroy,
  };
  AA.overlayRegistry?.register(AA.overlays.pauseVideos);
})(typeof window !== "undefined" ? window : globalThis);
