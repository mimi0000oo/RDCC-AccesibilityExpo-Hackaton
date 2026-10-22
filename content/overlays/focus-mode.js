/**
 * content/overlays/focus-mode.js
 * Three independent ADHD/autism-spectrum focus aids. Implements the
 * OverlayModule contract (ARCHITECTURE.md §4): init(ctx), enable(options),
 * disable(), update(options), destroy().
 *
 * NOTE ON VERIFICATION: the two DOM-text-based features below
 * (`hideSelfView`, `hideReactions`) are, like every other Meet-DOM-reaching
 * module in this extension, built against Meet's UNOFFICIAL and UNSTABLE
 * markup (ARCHITECTURE.md §6/§7) — and this time without the ability to
 * verify against a real, live Meet call while writing them (no connected
 * browser session was available). They degrade to a reported no-op rather
 * than throwing or guessing destructively, same contract as every other
 * best-effort module here, but treat them as more likely to need a keyword
 * adjustment once tried against a real call than the rest of this codebase.
 *
 *  - `dimOthers` (speaker spotlight): dims every tile EXCEPT whoever is
 *    currently speaking, recomputed ~5x/second. Two local signals: (1) the
 *    tile's own audio via a Web Audio AnalyserNode, when its MediaStream
 *    carries an audio track; (2) otherwise — the normal case in real Meet,
 *    whose tiles are video-only (audio plays through separate <audio>
 *    elements) — how busy Meet's own speaking indicator is on each tile,
 *    measured as class/style mutations per second, no class names assumed.
 *    No network, no recording. When nobody is clearly speaking, nobody is
 *    dimmed; the last speaker stays lit through short pauses.
 *  - `hideSelfView`: finds the local user's own tile — the mirrored camera
 *    tile first, then a "(You)"/"Tu"/"Dvs." label, then the user's display
 *    name from Meet's data-self-name — and hides that <video> with a CSS
 *    opacity rule (never paused, nothing inserted into Meet's tile, so Meet's
 *    re-renders can't make it flicker). Re-checked twice a second in case
 *    Meet replaces the <video> element or the tile loads late.
 *  - `hideReactions`: hides floating emoji reactions as Meet adds them —
 *    Noto emoji images (Meet's animated reactions) and emoji-only text,
 *    together with their small sender-name bubble — via a CSS rule plus a
 *    MutationObserver on document.body (the reaction layer sits outside the
 *    tile grid). Buttons, toolbars, menus, chat and inputs are excluded, so
 *    the reaction picker itself keeps working.
 *
 * Options shape (ARCHITECTURE.md §3):
 *   { enabled, dimOthers, hideSelfView, hideReactions }
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const MODULE_ID = "focusMode";
  const SPEAKER_CHECK_MS = 200;
  const SILENCE_THRESHOLD = 8; // 0-255 scale from AnalyserNode byte data; below this, treat as silence
  const ACTIVITY_WINDOW_MS = 1000; // speaking-indicator mutations are counted over this window
  const ACTIVITY_MIN_MUTATIONS = 4; // fewer than this per window = not speaking (e.g. a hover effect)
  const SPOTLIGHT_HOLD_MS = 1500; // keep the last speaker lit through short pauses
  const DIM_CLASS = "aa-focus-dim";
  const DIM_STYLE_ID = "aa-focus-mode-style";
  const SELF_VIEW_KEYWORDS = ["(you)", "(dvs", "(tu)"]; // diacritic-stripped, lowercased
  const SELF_VIEW_EXACT_LABELS = ["you", "tu", "dvs.", "dvs", "dumneavoastra"];
  const SELF_VIEW_CHECK_MS = 500;
  const SELF_VIEW_ATTR = "data-aa-self-view-hidden";
  const SELF_VIEW_STYLE_ID = "aa-focus-self-view-style";
  const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}‍️\s]{1,8}$/u;
  const REACTION_IMG_SRC_RE = /notoemoji|\/emoji\//i;
  const REACTION_HIDDEN_ATTR = "data-aa-reaction-hidden";
  const REACTION_STYLE_ID = "aa-focus-reactions-style";
  const REACTION_BUBBLE_MAX_TEXT = 40; // emoji + a sender's name, not a whole panel
  const REACTION_SCAN_LIMIT = 400; // per added subtree — reactions are tiny
  // The reaction picker, menus, chat and inputs use emoji too — never hide those.
  const REACTION_EXCLUDE_SELECTOR = [
    "button", '[role="button"]', '[role="toolbar"]', '[role="menu"]', '[role="menuitem"]',
    '[role="dialog"]', '[role="list"]', '[role="listitem"]', '[role="textbox"]',
    '[contenteditable="true"]', "textarea", "input", "[data-aa-overlay]",
  ].join(",");

  let ctx = null;
  let logger = null;
  let enabled = false;
  let destroyed = false;

  let dimOthers = false;
  let hideSelfView = false;
  let hideReactions = false;

  // --- dimOthers: audio-level speaker spotlight -------------------------
  let audioCtx = null;
  const tileAudioNodes = new Map(); // <video> -> { source, analyser, dataArray }
  let speakerCheckTimer = null;
  let dimStyleEl = null;
  let currentlySpotlit = null; // the <video> tile currently NOT dimmed
  const tilesWithoutAudio = new WeakSet(); // tiles whose stream has no audio track
  const tileActivity = new Map(); // <video> -> { wrapper, observer, times[] } (Meet's speaking indicator)
  let lastSpeakerAt = 0;

  // --- hideSelfView -------------------------------------------------------
  let selfViewVideo = null; // the user's own <video>, currently hidden
  let selfViewStyleEl = null;
  let selfViewTimer = null;
  let selfViewMissReported = false; // report "can't find my tile" once, not every second

  // --- hideReactions --------------------------------------------------------
  let reactionObserver = null;
  let reactionStyleEl = null;

  function getLogger() {
    if (logger) return logger;
    if (ctx && ctx.logger) return ctx.logger;
    if (AA.logger && typeof AA.logger.scope === "function") {
      return AA.logger.scope("overlays:focus-mode");
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

  function normalizeText(str) {
    return (str || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  function safeGetVideoTiles() {
    try {
      if (!ctx || !ctx.meet || typeof ctx.meet.getVideoTiles !== "function") return [];
      const tiles = ctx.meet.getVideoTiles();
      return Array.isArray(tiles) ? tiles.filter(Boolean) : [];
    } catch (err) {
      getLogger().error?.("getVideoTiles failed, treating as empty", err);
      return [];
    }
  }

  // ---- dimOthers: audio-level speaker spotlight --------------------------

  function ensureDimStyleInjected() {
    if (dimStyleEl) return;
    if (typeof document === "undefined" || !document.head) return;
    const style = document.createElement("style");
    style.id = DIM_STYLE_ID;
    style.setAttribute("data-aa-overlay", MODULE_ID);
    style.textContent = `.${DIM_CLASS} { filter: brightness(0.35) saturate(0.7) !important; transition: filter 200ms ease; }`;
    document.head.appendChild(style);
    dimStyleEl = style;
  }

  function removeDimStyle() {
    if (dimStyleEl && dimStyleEl.parentNode) dimStyleEl.parentNode.removeChild(dimStyleEl);
    dimStyleEl = null;
  }

  // Meet's tiles are WebRTC MediaStreams (video.srcObject), not file
  // sources — createMediaStreamSource(stream) is the correct tap for that,
  // NOT createMediaElementSource(videoEl). Confirmed empirically:
  // createMediaElementSource on a MediaStream-backed <video> read silence
  // from the AnalyserNode no matter the actual signal, while
  // createMediaStreamSource on the same stream read it correctly. It also
  // doesn't redirect/mute the element's own output the way
  // createMediaElementSource does, so no destination reconnect is needed.
  function ensureAudioNodeFor(tile) {
    if (tileAudioNodes.has(tile)) return tileAudioNodes.get(tile);
    if (tilesWithoutAudio.has(tile)) return null;
    // Real Meet plays everyone's audio through separate <audio> elements, so
    // tile streams are usually video-only — remember that instead of
    // retrying (and reporting an error) 5 times a second per tile.
    const stream = tile.srcObject;
    if (!stream || typeof stream.getAudioTracks !== "function" || stream.getAudioTracks().length === 0) {
      tilesWithoutAudio.add(tile);
      return null;
    }
    try {
      if (!audioCtx) audioCtx = new (global.AudioContext || global.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(tile.srcObject);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const entry = { source, analyser, dataArray: new Uint8Array(analyser.frequencyBinCount) };
      tileAudioNodes.set(tile, entry);
      return entry;
    } catch (err) {
      safeReportError(err);
      return null;
    }
  }

  function averageVolume(entry) {
    entry.analyser.getByteTimeDomainData(entry.dataArray);
    let sumDeviation = 0;
    for (let i = 0; i < entry.dataArray.length; i++) {
      sumDeviation += Math.abs(entry.dataArray[i] - 128);
    }
    return sumDeviation / entry.dataArray.length;
  }

  function applySpotlight(tiles, loudest) {
    if (currentlySpotlit === loudest) return;
    for (const tile of tiles) {
      if (tile === loudest) tile.classList.remove(DIM_CLASS);
      else tile.classList.add(DIM_CLASS);
    }
    currentlySpotlit = loudest;
  }

  function clearSpotlight(tiles) {
    for (const tile of tiles) tile.classList.remove(DIM_CLASS);
    currentlySpotlit = null;
  }

  // ---- speaker signal 2: Meet's own speaking indicator -------------------
  // While someone talks, Meet animates a sound-level indicator / highlight
  // on their tile by swapping classes and inline styles many times a
  // second. Counting those mutations per tile finds the speaker without
  // depending on Meet's (obfuscated, changing) class names or UI language.
  function ensureActivityTracker(video, tileSet) {
    const existing = tileActivity.get(video);
    if (existing && existing.wrapper.isConnected && existing.wrapper.contains(video)) return existing;
    if (existing) existing.observer.disconnect();
    const wrapper = tileWrapperFor(video, tileSet);
    const entry = { wrapper, observer: null, times: [] };
    entry.observer = new MutationObserver((mutations) => {
      const now = Date.now();
      for (const m of mutations) {
        const target = m.target;
        if (target === video || target.nodeType !== Node.ELEMENT_NODE) continue; // our own dim class / Meet's video
        if (target.closest("[data-aa-overlay]")) continue;
        entry.times.push(now);
      }
    });
    entry.observer.observe(wrapper, {
      attributes: true,
      attributeFilter: ["class", "style"],
      childList: true,
      subtree: true,
    });
    tileActivity.set(video, entry);
    return entry;
  }

  function recentActivity(entry, now) {
    const cutoff = now - ACTIVITY_WINDOW_MS;
    while (entry.times.length && entry.times[0] < cutoff) entry.times.shift();
    return entry.times.length;
  }

  function teardownActivityTrackers() {
    for (const entry of tileActivity.values()) entry.observer.disconnect();
    tileActivity.clear();
  }

  function pickSpeakerByActivity(tiles) {
    const tileSet = new Set(tiles);
    const now = Date.now();
    for (const [video, entry] of tileActivity) {
      if (!tileSet.has(video)) {
        entry.observer.disconnect();
        tileActivity.delete(video);
      }
    }
    let best = null;
    let bestCount = 0;
    let secondCount = 0;
    for (const tile of tiles) {
      const count = recentActivity(ensureActivityTracker(tile, tileSet), now);
      if (count > bestCount) {
        secondCount = bestCount;
        bestCount = count;
        best = tile;
      } else if (count > secondCount) {
        secondCount = count;
      }
    }
    // Needs steady activity AND a clear lead, so a one-off hover effect on a
    // tile or two people talking over each other doesn't bounce the spotlight.
    if (bestCount >= ACTIVITY_MIN_MUTATIONS && bestCount > secondCount * 1.5) return best;
    return null;
  }

  function checkSpeakers() {
    try {
      if (!enabled || !dimOthers || destroyed) return;
      const tiles = safeGetVideoTiles();
      if (tiles.length < 2) {
        clearSpotlight(tiles);
        return;
      }
      // Signal 1: tile audio, where the stream carries it.
      let loudest = null;
      let loudestVolume = SILENCE_THRESHOLD;
      for (const tile of tiles) {
        const entry = ensureAudioNodeFor(tile);
        if (!entry) continue;
        const volume = averageVolume(entry);
        if (volume > loudestVolume) {
          loudestVolume = volume;
          loudest = tile;
        }
      }
      // Signal 2: Meet's speaking indicator (real Meet tiles have no audio).
      if (!loudest) loudest = pickSpeakerByActivity(tiles);

      const now = Date.now();
      if (loudest) {
        lastSpeakerAt = now;
        applySpotlight(tiles, loudest);
      } else if (currentlySpotlit && tiles.includes(currentlySpotlit) && now - lastSpeakerAt < SPOTLIGHT_HOLD_MS) {
        // Brief pause between words — keep the current speaker lit instead of flickering.
      } else {
        clearSpotlight(tiles);
      }
    } catch (err) {
      safeReportError(err);
    }
  }

  function startSpeakerChecks() {
    stopSpeakerChecks();
    ensureDimStyleInjected();
    speakerCheckTimer = global.setInterval(checkSpeakers, SPEAKER_CHECK_MS);
  }

  function stopSpeakerChecks() {
    if (speakerCheckTimer) {
      global.clearInterval(speakerCheckTimer);
      speakerCheckTimer = null;
    }
    teardownActivityTrackers();
    clearSpotlight(safeGetVideoTiles());
    removeDimStyle();
  }

  function teardownAudioGraph() {
    for (const entry of tileAudioNodes.values()) {
      try {
        entry.source.disconnect();
        entry.analyser.disconnect();
      } catch (_) {
        /* best-effort */
      }
    }
    tileAudioNodes.clear();
    if (audioCtx) {
      try {
        audioCtx.close();
      } catch (_) {
        /* best-effort */
      }
      audioCtx = null;
    }
  }

  // ---- hideSelfView --------------------------------------------------------

  // The tile's own wrapper: climb from the <video> while the ancestor holds no
  // other tile and isn't much bigger than the video (so a lone tile in a
  // 1-person call doesn't climb all the way up to the whole call area).
  function tileWrapperFor(video, tileSet) {
    const videoRect = video.getBoundingClientRect();
    const videoArea = Math.max(1, videoRect.width * videoRect.height);
    let wrapper = video.parentElement || video;
    for (let hops = 0; hops < 6; hops++) {
      const next = wrapper.parentElement;
      if (!next || next === document.body) break;
      const hasOtherTile = Array.from(next.querySelectorAll("video")).some((v) => v !== video && tileSet.has(v));
      if (hasOtherTile) break;
      const rect = next.getBoundingClientRect();
      if (rect.width * rect.height > videoArea * 1.6) break;
      wrapper = next;
    }
    return wrapper;
  }

  // Meet shows the local camera mirrored (scaleX(-1) / rotateY(180deg)) on
  // the <video> or a close ancestor — the most reliable "this is me" signal,
  // since it doesn't depend on any label text or UI language.
  function isMirrored(video) {
    let node = video;
    for (let hops = 0; hops < 4 && node && node !== document.body; hops++, node = node.parentElement) {
      const transform = getComputedStyle(node).transform;
      if (!transform || transform === "none") continue;
      const match = transform.match(/^matrix(3d)?\(([^,]+)/);
      if (match && parseFloat(match[2]) < 0) return true;
    }
    return false;
  }

  function hasSelfLabel(wrapper) {
    const labels = [wrapper.getAttribute("aria-label")];
    for (const el of wrapper.querySelectorAll("[aria-label], span, div")) {
      if (el.closest("[data-aa-overlay]")) continue;
      labels.push(el.getAttribute("aria-label"), el.children.length === 0 ? el.textContent : null);
    }
    return labels.some((raw) => {
      const text = normalizeText(raw).trim();
      if (!text || text.length > 80) return false;
      return SELF_VIEW_KEYWORDS.some((kw) => text.includes(kw)) || SELF_VIEW_EXACT_LABELS.includes(text);
    });
  }

  // Meet puts the signed-in user's display name in a data-self-name attribute.
  function selfDisplayName() {
    const el = document.querySelector("[data-self-name]");
    return el ? normalizeText(el.getAttribute("data-self-name")).trim() : "";
  }

  // Tries, in order: the mirrored tile, a tile labeled "(You)"/"Tu"/"Dvs.",
  // then a tile showing the user's own display name. A signal only counts
  // when it picks out exactly one tile, so a guess never hides someone else.
  function findSelfViewTile(tiles) {
    try {
      const tileSet = new Set(tiles);
      const entries = tiles.map((video) => ({ video, wrapper: tileWrapperFor(video, tileSet) }));
      const name = selfDisplayName();
      const strategies = [
        (e) => isMirrored(e.video),
        (e) => hasSelfLabel(e.wrapper),
        (e) => !!name && normalizeText(e.wrapper.textContent).includes(name),
      ];
      for (const matches of strategies) {
        const hits = entries.filter(matches);
        if (hits.length === 1) return hits[0];
      }
      return null;
    } catch (err) {
      safeReportError(err);
      return null;
    }
  }

  function ensureSelfViewStyleInjected() {
    if (selfViewStyleEl) return;
    if (typeof document === "undefined" || !document.head) return;
    const style = document.createElement("style");
    style.id = SELF_VIEW_STYLE_ID;
    style.setAttribute("data-aa-overlay", MODULE_ID);
    style.textContent = `video[${SELF_VIEW_ATTR}] { opacity: 0 !important; }`;
    document.head.appendChild(style);
    selfViewStyleEl = style;
  }

  // Hides the user's own <video> through a stylesheet rule keyed on an
  // attribute, instead of inserting a cover element into the tile: Meet
  // re-renders its tiles constantly and drops foreign children, which made
  // a cover flicker. The <video> element itself survives those re-renders,
  // so the tile just looks like "camera off" and stays that way.
  function applyHideSelfView() {
    if (selfViewVideo && selfViewVideo.isConnected) {
      if (!selfViewVideo.hasAttribute(SELF_VIEW_ATTR)) selfViewVideo.setAttribute(SELF_VIEW_ATTR, "");
      return;
    }
    removeHideSelfView(); // the old <video> is gone — Meet rebuilt the tile
    const self = findSelfViewTile(safeGetVideoTiles());
    if (!self) {
      if (!selfViewMissReported) {
        selfViewMissReported = true;
        safeReportError(new Error("focus mode: couldn't identify the local user's own tile yet — will keep checking"));
      }
      return;
    }
    try {
      ensureSelfViewStyleInjected();
      self.video.setAttribute(SELF_VIEW_ATTR, "");
      selfViewVideo = self.video;
      selfViewMissReported = false;
    } catch (err) {
      safeReportError(err);
    }
  }

  // Meet loads tiles after join and re-renders them on layout changes, so a
  // one-shot attempt isn't enough: re-check every second while the option is on.
  function startSelfViewChecks() {
    stopSelfViewChecks();
    applyHideSelfView();
    selfViewTimer = global.setInterval(() => {
      try {
        if (enabled && hideSelfView && !destroyed) applyHideSelfView();
      } catch (err) {
        safeReportError(err);
      }
    }, SELF_VIEW_CHECK_MS);
  }

  function stopSelfViewChecks() {
    if (selfViewTimer) {
      global.clearInterval(selfViewTimer);
      selfViewTimer = null;
    }
    removeHideSelfView();
    removeSelfViewStyle();
    selfViewMissReported = false;
  }

  function removeHideSelfView() {
    if (!selfViewVideo) return;
    try {
      selfViewVideo.removeAttribute(SELF_VIEW_ATTR);
    } catch (_) {
      /* best-effort — node may already be detached */
    }
    selfViewVideo = null;
  }

  function removeSelfViewStyle() {
    if (selfViewStyleEl && selfViewStyleEl.parentNode) selfViewStyleEl.parentNode.removeChild(selfViewStyleEl);
    selfViewStyleEl = null;
  }

  // ---- hideReactions ---------------------------------------------------

  // Meet draws reactions as animated Noto emoji images (fonts.gstatic.com
  // .../notoemoji/...) floating in their own layer above the call — often
  // with the sender's name under the emoji — not as plain emoji text inside
  // the tile grid. The reaction PICKER uses the same images, but inside
  // buttons/toolbars, which are excluded so the user can still send reactions.
  function isExcludedUi(el) {
    return !!el.closest(REACTION_EXCLUDE_SELECTOR);
  }

  function isEmojiImage(el) {
    if (el.tagName !== "IMG") return false;
    const src = el.getAttribute("src") || "";
    if (REACTION_IMG_SRC_RE.test(src)) return true;
    const alt = (el.getAttribute("alt") || "").trim();
    return !!alt && EMOJI_ONLY_RE.test(alt);
  }

  function isEmojiTextLeaf(el) {
    if (el.children.length > 0) return false;
    const text = (el.textContent || "").trim();
    return !!text && EMOJI_ONLY_RE.test(text);
  }

  // Climb from the emoji to its small floating bubble (emoji + sender name)
  // so the name label disappears too — but never past anything holding a
  // video or more than a name's worth of text.
  function reactionBubbleFor(el) {
    let target = el;
    for (let hops = 0; hops < 4; hops++) {
      const parent = target.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (isExcludedUi(parent) || parent.querySelector("video")) break;
      if ((parent.textContent || "").trim().length > REACTION_BUBBLE_MAX_TEXT) break;
      target = parent;
    }
    return target;
  }

  function hideReactionNode(el) {
    const target = reactionBubbleFor(el);
    if (target.hasAttribute(REACTION_HIDDEN_ATTR)) return;
    target.setAttribute(REACTION_HIDDEN_ATTR, "");
    target.style.setProperty("display", "none", "important");
  }

  function scanForReactions(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.closest("[data-aa-overlay]") || isExcludedUi(root)) return;
    const candidates = [root, ...root.querySelectorAll("img, span, div")];
    for (const el of candidates.slice(0, REACTION_SCAN_LIMIT)) {
      if (el.hasAttribute(REACTION_HIDDEN_ATTR) || isExcludedUi(el)) continue;
      if (isEmojiImage(el) || isEmojiTextLeaf(el)) hideReactionNode(el);
    }
  }

  function handleReactionMutations(mutations) {
    try {
      if (!enabled || !hideReactions || destroyed) return;
      for (const mutation of mutations) {
        if (mutation.type === "attributes") scanForReactions(mutation.target);
        else for (const node of mutation.addedNodes) scanForReactions(node);
      }
    } catch (err) {
      safeReportError(err);
    }
  }

  // Instant first line of defense: hides the emoji images themselves via CSS
  // before the MutationObserver callback even runs, so nothing flashes.
  function ensureReactionStyleInjected() {
    if (reactionStyleEl || typeof document === "undefined" || !document.head) return;
    const style = document.createElement("style");
    style.id = REACTION_STYLE_ID;
    style.setAttribute("data-aa-overlay", MODULE_ID);
    style.textContent =
      `img[src*="notoemoji"]:not(:is(${REACTION_EXCLUDE_SELECTOR}) *) { visibility: hidden !important; }`;
    document.head.appendChild(style);
    reactionStyleEl = style;
  }

  // Observes document.body rather than the tiles' container (unlike
  // ARCHITECTURE.md §7's default): Meet's reaction layer sits outside the
  // tile grid, and the tiles may not exist yet when the option is turned on.
  // The callback only inspects the nodes each mutation adds, so it stays cheap.
  function startReactionObserver() {
    stopReactionObserver();
    if (typeof document === "undefined" || !document.body) return;
    try {
      ensureReactionStyleInjected();
      scanForReactions(document.body);
      reactionObserver = new MutationObserver(handleReactionMutations);
      reactionObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "alt"],
      });
    } catch (err) {
      safeReportError(err);
    }
  }

  function stopReactionObserver() {
    if (reactionObserver) {
      try {
        reactionObserver.disconnect();
      } catch (_) {
        /* best-effort */
      }
      reactionObserver = null;
    }
    if (reactionStyleEl && reactionStyleEl.parentNode) reactionStyleEl.parentNode.removeChild(reactionStyleEl);
    reactionStyleEl = null;
    if (typeof document !== "undefined") {
      for (const el of document.querySelectorAll(`[${REACTION_HIDDEN_ATTR}]`)) {
        el.removeAttribute(REACTION_HIDDEN_ATTR);
        el.style.removeProperty("display");
      }
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  function applyOptions(opts) {
    const nextDimOthers = !!opts.dimOthers;
    const nextHideSelfView = !!opts.hideSelfView;
    const nextHideReactions = !!opts.hideReactions;

    if (nextDimOthers !== dimOthers) {
      dimOthers = nextDimOthers;
      if (dimOthers) startSpeakerChecks();
      else stopSpeakerChecks();
    }
    if (nextHideSelfView !== hideSelfView) {
      hideSelfView = nextHideSelfView;
      if (hideSelfView) startSelfViewChecks();
      else stopSelfViewChecks();
    }
    if (nextHideReactions !== hideReactions) {
      hideReactions = nextHideReactions;
      if (hideReactions) startReactionObserver();
      else stopReactionObserver();
    }
  }

  function init(context) {
    try {
      ctx = context || null;
      destroyed = false;
      logger =
        (ctx && ctx.logger) ||
        (AA.logger && typeof AA.logger.scope === "function" ? AA.logger.scope("overlays:focus-mode") : console);
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
      enabled = true;
      applyOptions(opts);
      getLogger().info?.("enabled");
    } catch (err) {
      safeReportError(err);
    }
  }

  function disable() {
    try {
      enabled = false;
      stopSpeakerChecks();
      teardownAudioGraph();
      stopSelfViewChecks();
      stopReactionObserver();
      dimOthers = false;
      hideSelfView = false;
      hideReactions = false;
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
      if (!enabled) {
        if (opts.enabled === true) enable(opts);
        return;
      }
      applyOptions({ dimOthers, hideSelfView, hideReactions, ...opts });
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
  AA.overlays.focusMode = {
    id: MODULE_ID,
    init,
    enable,
    disable,
    update,
    destroy,
  };
  AA.overlayRegistry?.register(AA.overlays.focusMode);
})(typeof window !== "undefined" ? window : globalThis);
