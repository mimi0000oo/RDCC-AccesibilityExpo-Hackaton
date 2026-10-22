/**
 * content/overlays/ai-recap.js
 * On-demand AI "catch me up" recap for ADHD/autism focus lapses. Implements
 * the OverlayModule contract (ARCHITECTURE.md §4): init(ctx), enable(options),
 * disable(), update(options), destroy().
 *
 * 100% local, no network, no API key: when the user clicks the floating
 * "Catch me up" button, the last `windowSeconds` of speech THIS MODULE
 * scraped from Meet's own captions is summarized ON THIS DEVICE —
 *   1. Chrome's built-in Summarizer API (Gemini Nano, on-device) when the
 *      browser/hardware supports it — may download the model once on first
 *      use, then runs offline;
 *   2. otherwise a local extractive summary (picks the most informative
 *      captioned sentences by word frequency) — always available.
 * Replaced an earlier Hugging Face Inference API call, which sent captions
 * off-device and stopped working once the account's credits ran out.
 * Deliberately ON-DEMAND, not periodic: an earlier automatic/recurring version of a
 * similar recap feature turned out to fail silently and felt intrusive —
 * one explicit click, one request, one visible result (or one visible
 * error) is easier to reason about and impossible to miss.
 *
 * Reads Meet's on-screen caption box (the "Captions"/"Subtitrări" region,
 * or visually: avatar + big text near the bottom) — never Meet's
 * screen-reader [aria-live] announcer, which only gets fragments and system
 * messages. Each snapshot is merged into one word list, so every spoken word
 * is kept once in its latest corrected form. It does NOT depend on or
 * modify live-captions.js; it just assumes Meet's own captions are on.
 *
 * Options shape: { enabled, windowSeconds: number }.
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const MODULE_ID = "aiRecap";
  const BUTTON_ID = "aa-ai-recap-button";
  const PANEL_ID = "aa-ai-recap-panel";
  const DOCK_ORDER = 20; // right of "Pause videos" (pause-videos.js, order 10)
  const POLL_MS = 400;
  const BUFFER_MAX_MS = 10 * 60 * 1000; // never keep more than 10 min of scraped lines
  const MIN_CHARS_TO_SUMMARIZE = 30;
  const EXTRACTIVE_MAX_SENTENCES = 3;
  const DUPLICATE_SIMILARITY = 0.6; // key points sharing this much vocabulary count as the same idea
  const MIN_KEY_POINT_WORDS = 6; // shorter pieces are fragments, not ideas
  const MAX_SENTENCE_WORDS = 40; // unpunctuated runs longer than this are split
  const MAX_KEY_POINT_WORDS = 10; // a key point is a short gist, never the whole caption sentence
  const MIN_CLAUSE_WORDS = 3; // shorter clauses can't stand on their own as a key point
  const MAX_TOPICS = 4;
  const OVERLAP_LOOKBACK_WORDS = 300; // how far back new captions are compared for repeats
  const MIN_OVERLAP_WORDS = 3; // shortest word run treated as "the same text again"
  const REVISION_MAX_WORDS = 8; // Meet corrects at most the last few words of a caption
  // Meet's speaker label for a shared tab's audio, when it's not marked up separately.
  const SPEAKER_PREFIX_RE = /\b(?:Prezentarea utilizatorului|Presentation (?:by|from)) \S+|\S+ \((?:Presentation|Prezentare)\)/gi;
  // English only: captions are expected in English and the summary is written in English.
  const SUMMARIZER_OPTIONS = {
    type: "key-points",
    format: "plain-text",
    length: "short",
    expectedInputLanguages: ["en"],
    outputLanguage: "en",
  };
  const AVAILABILITY_TIMEOUT_MS = 3000;
  const CREATE_TIMEOUT_MS = 5000;
  const SUMMARIZE_TIMEOUT_MS = 15000;

  // Common English + Romanian filler words, ignored when scoring sentences.
  const STOPWORDS = new Set((
    "the a an and or but so of to in on at for with from by is are was were be been it this that " +
    "these those i you he she we they me him her us them my your our their its as if then than " +
    "just like yeah yes no not do does did have has had will would can could should okay ok um uh " +
    "si sau dar de la in pe cu din pentru ca este sunt era au am ai a fi un o unei unui care ce " +
    "eu tu el ea noi voi ei ele nu da mai asa deci acum doar foarte sa se il le lui"
  ).split(" "));

  // Meet's on-screen caption box is a landmark region labelled "Captions"
  // (Romanian "Subtitrări", Spanish "Subtítulos", …). Deliberately NOT the
  // page's [aria-live] regions: those are Meet's screen-reader announcer —
  // they get system messages ("Subtitrările live au fost dezactivate") and
  // only small fragments of each caption, which made the recap read like
  // random words.
  const CAPTION_CONTAINER_SELECTORS = [
    '[role="region"][aria-label*="caption" i]',
    '[role="region"][aria-label*="subtitr" i]',
    '[role="region"][aria-label*="subtítul" i]',
    '[role="region"][aria-label*="untertitel" i]',
    ".a4cQT",
  ];
  const CAPTION_MIN_FONT_PX = 16; // the visual fallback only accepts big, caption-sized text

  // Meet renders its caption settings (language list, font size, …) inside or
  // next to the caption area. Anything matching these is UI, not speech.
  const NON_SPEECH_SELECTOR = [
    "button", "select", "input", "i", "svg",
    '[role="button"]', '[role="menu"]', '[role="menuitem"]', '[role="menuitemradio"]',
    '[role="listbox"]', '[role="option"]', '[role="radio"]', '[role="radiogroup"]',
    '[role="combobox"]', '[role="dialog"]', '[role="tooltip"]',
    '[class*="material"]', '[class*="symbol"]',
  ].join(",");

  let ctx = null;
  let logger = null;
  let enabled = false;
  let destroyed = false;
  let windowSeconds = 120;

  let pollTimer = null;
  let transcriptWords = []; // { w, norm, ts } — every captioned word once, oldest first
  let blockStart = 0; // index in transcriptWords where the caption block on screen begins

  let buttonEl = null;
  let panelEl = null;
  let requestInFlight = false;
  let summarizer = null; // cached on-device Summarizer instance, if the browser has one
  let summarizerPending = null; // in-flight Summarizer.create(), possibly downloading the model

  function getLogger() {
    if (logger) return logger;
    if (ctx && ctx.logger) return ctx.logger;
    if (AA.logger && typeof AA.logger.scope === "function") {
      return AA.logger.scope("overlays:ai-recap");
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

  // ---- scraping Meet's own captions (buffer only, no UI of its own) -----

  function findCaptionContainer() {
    for (const selector of CAPTION_CONTAINER_SELECTORS) {
      try {
        const matches = document.querySelectorAll(selector);
        for (const el of matches) {
          if (el.closest("[data-aa-overlay]")) continue; // never pick up our own button/panel
          if (el.closest('[role="menu"],[role="listbox"],[role="dialog"]')) continue; // a settings menu, not captions
          if (el.isConnected) return el;
        }
      } catch (_) {
        /* invalid selector in this Chrome version — try the next */
      }
    }
    return findCaptionBlockVisually();
  }

  // Fallback when Meet's markup changes: a caption block is a speaker avatar
  // next to big text, in the lower part of the screen, outside the video
  // tiles. Returns the closest ancestor of such an avatar that holds the text.
  function findCaptionBlockVisually() {
    const viewportHeight = global.innerHeight || 0;
    for (const img of document.querySelectorAll("img")) {
      if (img.closest("[data-aa-overlay], button, [role='button'], [aria-live]")) continue;
      const rect = img.getBoundingClientRect();
      if (!rect.width || rect.top < viewportHeight * 0.4) continue;
      let node = img.parentElement;
      for (let hops = 0; hops < 4 && node && node !== document.body; hops++, node = node.parentElement) {
        if (node.querySelector("video")) break;
        const text = (node.textContent || "").trim();
        if (text.length < 40) continue;
        const bigText = Array.from(node.querySelectorAll("div, span")).some(
          (el) => el.children.length === 0 && (el.textContent || "").trim().length >= 20 &&
            parseFloat(getComputedStyle(el).fontSize) >= CAPTION_MIN_FONT_PX
        );
        if (bigText) return node.parentElement || node; // include sibling blocks of other speakers
      }
    }
    return null;
  }

  // Caption text only: drops Meet's menus, buttons and icon ligatures
  // ("format_size") that live in the same container.
  function extractSpokenText(container) {
    const clone = container.cloneNode(true);
    for (const el of clone.querySelectorAll(NON_SPEECH_SELECTOR)) el.remove();
    for (const el of clone.querySelectorAll("[aria-live]")) el.remove(); // screen-reader announcer, not the visible captions
    for (const el of clone.querySelectorAll("*")) {
      if (isSpeakerLabel(el)) el.remove();
    }
    const text = (clone.textContent || "").replace(SPEAKER_PREFIX_RE, " ").replace(/\s+/g, " ").trim();
    return looksLikeUiText(text) ? "" : text;
  }

  // Meet heads each caption block with the speaker's avatar and name (for a
  // shared tab's audio: "Prezentarea utilizatorului mimi0714"). Those names
  // got glued onto the spoken sentence, so drop a short, unpunctuated leaf
  // label whose nearby container holds the avatar image and nothing more
  // than that label — never a container that also holds the speech itself.
  function isSpeakerLabel(el) {
    if (el.children.length > 0) return false;
    const text = (el.textContent || "").trim();
    if (!text || text.length > 60 || text.split(/\s+/).length > 6 || /[.!?,]/.test(text)) return false;
    for (let node = el.parentElement, hops = 0; node && hops < 2; node = node.parentElement, hops++) {
      if (!node.querySelector("img")) continue;
      return (node.textContent || "").trim().length <= text.length + 2;
    }
    return false;
  }

  // Last line of defense for menu text that isn't marked up as a menu, e.g.
  // the caption-language list: "Slovenă (Slovenia)BETASotho de Nord (Africa de Sud)BETA…".
  function looksLikeUiText(text) {
    if (!text) return false;
    if ((text.match(/BETA/g) || []).length >= 2) return true;
    if ((text.match(/\([^)]{2,40}\)/g) || []).length >= 4) return true;
    if (/\b[a-z]+_[a-z_]+\b/.test(text)) return true; // Material icon names like format_size
    return false;
  }

  function normalizeWord(word) {
    return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  }

  function makeWord(word, ts) {
    return { w: word, norm: normalizeWord(word), ts };
  }

  function sameWords(a, b) {
    return a.length === b.length && a.every((w, i) => w === b[i]);
  }

  // Replaces transcriptWords from index `from` with `next`, keeping the
  // original timestamp of every word that didn't change.
  function replaceFrom(from, next, now) {
    const old = transcriptWords.slice(from);
    const merged = next.map((word, i) =>
      old[i] && old[i].norm === normalizeWord(word) ? old[i] : makeWord(word, now)
    );
    transcriptWords = transcriptWords.slice(0, from).concat(merged);
  }

  // Meet's caption box is a live, rolling view: words are appended while
  // someone talks, recent words get corrected ("Sol" -> "solar"), and old
  // lines scroll off the top. Each snapshot is merged into one word list so
  // every spoken word is stored exactly once, in its latest corrected form:
  //   A. same caption block, grown or corrected -> replace the block;
  //   B. block scrolled (front words gone)       -> align on overlap, keep only new words;
  //   C. nothing new                             -> ignore;
  //   D. a new, unrelated block                  -> append it.
  function mergeSnapshot(text) {
    const next = text.split(/\s+/).filter(Boolean);
    if (!next.length) return;
    const nextNorm = next.map(normalizeWord);
    const now = Date.now();
    const words = transcriptWords;

    if (!words.length) {
      blockStart = 0;
      transcriptWords = next.map((w) => makeWord(w, now));
      return;
    }

    // A. The current block still starts the same way.
    const block = words.slice(blockStart).map((x) => x.norm);
    const prefixLen = Math.min(MIN_OVERLAP_WORDS, block.length);
    if (prefixLen > 0 && next.length >= prefixLen && sameWords(block.slice(0, prefixLen), nextNorm.slice(0, prefixLen))) {
      replaceFrom(blockStart, next, now);
      return;
    }

    // B. Find the latest few words we already have inside the snapshot,
    // allowing the last REVISION_MAX_WORDS words to have been corrected.
    const minEnd = Math.max(MIN_OVERLAP_WORDS, words.length - REVISION_MAX_WORDS);
    for (let end = words.length; end >= minEnd; end--) {
      const anchor = words.slice(end - MIN_OVERLAP_WORDS, end).map((x) => x.norm);
      for (let i = nextNorm.length - MIN_OVERLAP_WORDS; i >= 0; i--) {
        if (!sameWords(anchor, nextNorm.slice(i, i + MIN_OVERLAP_WORDS))) continue;
        replaceFrom(end, next.slice(i + MIN_OVERLAP_WORDS), now);
        blockStart = Math.max(0, end - MIN_OVERLAP_WORDS - i); // where this snapshot begins in our list
        return;
      }
    }

    // C. Already have all of it.
    const recent = ` ${words.slice(-OVERLAP_LOOKBACK_WORDS).map((x) => x.norm).join(" ")} `;
    if (recent.includes(` ${nextNorm.join(" ")} `)) return;

    // D. Something new (another speaker, or captions resumed).
    blockStart = words.length;
    transcriptWords = words.concat(next.map((w) => makeWord(w, now)));
  }

  function pruneTranscript() {
    const cutoff = Date.now() - BUFFER_MAX_MS;
    let drop = 0;
    while (drop < transcriptWords.length && transcriptWords[drop].ts < cutoff) drop++;
    if (!drop) return;
    transcriptWords = transcriptWords.slice(drop);
    blockStart = Math.max(0, blockStart - drop);
  }

  function poll() {
    try {
      const container = findCaptionContainer();
      if (!container) return;
      mergeSnapshot(extractSpokenText(container));
      pruneTranscript();
    } catch (err) {
      safeReportError(err);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = global.setInterval(poll, POLL_MS);
    poll();
  }

  function stopPolling() {
    if (pollTimer) {
      global.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function recentTranscriptText() {
    const cutoff = Date.now() - windowSeconds * 1000;
    return transcriptWords
      .filter((word) => word.ts >= cutoff)
      .map((word) => word.w)
      .join(" ")
      .trim();
  }

  // ---- floating button + result panel ------------------------------------

  function ensureUiInjected() {
    if (buttonEl) return;
    if (typeof document === "undefined" || !document.body) return;

    // Lives in the shared bottom-right dock (utils/floating-dock.js), next to
    // pause-videos.js's button, so the two never overlap.
    buttonEl = AA.floatingDock ? AA.floatingDock.createButton("Catch me up") : document.createElement("button");
    buttonEl.id = BUTTON_ID;
    buttonEl.type = "button";
    buttonEl.setAttribute("data-aa-overlay", MODULE_ID);
    buttonEl.textContent = "Catch me up";
    buttonEl.addEventListener("click", handleButtonClick);
    if (AA.floatingDock) AA.floatingDock.add(buttonEl, DOCK_ORDER);
    else document.body.appendChild(buttonEl);

    const panelBottom = AA.floatingDock ? AA.floatingDock.PANEL_BOTTOM_PX : 72;
    panelEl = document.createElement("div");
    panelEl.id = PANEL_ID;
    panelEl.setAttribute("data-aa-overlay", MODULE_ID);
    // max-height + overflow-y so a long recap scrolls inside the panel
    // instead of growing past the top of the viewport and getting clipped
    // (it's anchored via `bottom`, so unbounded height grew upward,
    // off-screen). pointer-events toggles with visibility in showPanel() —
    // it has to be interactive while shown so the scrollbar/wheel works.
    panelEl.style.cssText =
      `position:fixed;bottom:${panelBottom}px;right:24px;z-index:2147483646;` +
      "width:min(440px, calc(100vw - 48px));max-height:min(70vh, calc(100vh - 100px));overflow-y:auto;" +
      "background:rgba(255,255,255,0.98);color:#1f1f1f;border:1px solid #dadce0;" +
      "border-radius:10px;padding:14px 16px;font:15px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;white-space:pre-line;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.25);opacity:0;transition:opacity 180ms ease;pointer-events:none;";
    document.body.appendChild(panelEl);
  }

  function removeUi() {
    if (buttonEl && AA.floatingDock) AA.floatingDock.remove(buttonEl);
    else if (buttonEl && buttonEl.parentNode) buttonEl.parentNode.removeChild(buttonEl);
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    buttonEl = null;
    panelEl = null;
  }

  function showPanel(text) {
    if (!panelEl) return;
    panelEl.textContent = text;
    panelEl.style.opacity = text ? "1" : "0";
    // Only interactive while actually shown — a long recap needs to be
    // scrollable (overflow-y:auto above), but an invisible panel shouldn't
    // sit there eating clicks/wheel events meant for Meet underneath it.
    panelEl.style.pointerEvents = text ? "auto" : "none";
  }

  // ---- summarizing (on-device only) --------------------------------------

  // Rejects if `promise` hasn't settled within `ms`, so a stuck browser API
  // can never leave the panel on "Summarizing…" forever.
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = global.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => global.clearTimeout(timer));
  }

  // Starts creating the on-device summarizer without blocking the click: if
  // the model still has to download, that happens in the background and a
  // later click uses it once it's ready.
  function startSummarizerCreate(Api) {
    if (summarizerPending) return;
    const pending = Api.create({
      ...SUMMARIZER_OPTIONS,
      sharedContext:
        "Live captions from a video meeting, for someone who lost focus for a moment. " +
        "Rephrase what was just discussed as very short points of a few words each — never copy whole sentences.",
    })
      .then((instance) => {
        // Ignore a create() that finishes after disable() or after it was abandoned.
        if (enabled && summarizerPending === pending) summarizer = instance;
        else if (instance && typeof instance.destroy === "function") instance.destroy();
      })
      .catch((err) => getLogger().warn?.("on-device summarizer could not be created", err))
      .finally(() => {
        if (summarizerPending === pending) summarizerPending = null;
      });
    summarizerPending = pending;
  }

  // Chrome's built-in Summarizer API (Gemini Nano). Returns null whenever it
  // isn't ready right now (older Chrome, unsupported hardware/language, model
  // still downloading, or too slow) so the caller falls back to the
  // extractive summary instead of waiting.
  async function summarizeOnDevice(transcript) {
    const Api = global.Summarizer;
    if (!Api || typeof Api.create !== "function") return null;
    try {
      if (!summarizer) {
        const availability =
          typeof Api.availability === "function"
            ? await withTimeout(Api.availability(SUMMARIZER_OPTIONS), AVAILABILITY_TIMEOUT_MS, "availability")
            : "available";
        if (availability === "unavailable") return null;
        startSummarizerCreate(Api);
        if (availability !== "available" || !summarizerPending) return null;
        try {
          await withTimeout(summarizerPending, CREATE_TIMEOUT_MS, "create");
        } catch (err) {
          // The model is already downloaded, so a create() this slow is stuck —
          // abandon it so the next click starts a fresh one.
          summarizerPending = null;
          throw err;
        }
        if (!summarizer) return null;
      }
      const summary = await withTimeout(summarizer.summarize(transcript), SUMMARIZE_TIMEOUT_MS, "summarize");
      return typeof summary === "string" && summary.trim() ? summary.trim() : null;
    } catch (err) {
      getLogger().warn?.("on-device summarizer not ready, using local fallback", err);
      return null;
    }
  }

  function splitSentences(transcript) {
    // Meet adds punctuation to most captions; only very long unpunctuated
    // runs are cut (at 40 words, so real sentences stay whole) so a single
    // run can't swallow the whole summary.
    const pieces = transcript.match(/[^.!?]+[.!?]*/g) || [transcript];
    const sentences = [];
    for (const piece of pieces) {
      const words = piece.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += MAX_SENTENCE_WORDS) {
        const chunk = words.slice(i, i + MAX_SENTENCE_WORDS).join(" ");
        if (chunk.split(" ").length >= 3) sentences.push(chunk);
      }
    }
    return sentences;
  }

  function tokenize(sentence) {
    return (sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(
      (w) => w.length > 2 && !STOPWORDS.has(w)
    );
  }

  // Spoken filler that carries no meaning, removed before a sentence is shortened.
  const FILLER_RE = new RegExp(
    "(?<![\\p{L}\\p{N}'])(?:you know|i mean|kind of|sort of|basically|actually|literally|honestly|obviously|" +
      "to be honest|let's say|um+|uh+|hmm+|so yeah|you see|i guess|i suppose|" +
      "de fapt|să zicem|cum să zic|adică)(?![\\p{L}\\p{N}']),?\\s*",
    "giu"
  );
  // Openers that only announce the point ("I think that …", "So, …").
  const PREAMBLE_RE = new RegExp(
    "^(?:(?:so|and|but|well|okay|ok|right|now|yeah|yes|also|then|alright|because|since|which|although|whereas|" +
      "deci|și|dar|bine|da|deoarece|iar)(?![\\p{L}\\p{N}'])[,\\s]*|" +
      "(?:i|we) (?:think|believe|feel|guess|would say|wanted to say|want to say|would like to say)(?: that)?\\s+|" +
      "(?:what|the thing) (?:i|we) (?:want|wanted|need) to (?:say|mention) is(?: that)?\\s+|" +
      "what (?:i|we|you) (?:need|have|want) to do is\\s+|" +
      "the (?:thing|point|idea) is(?: that)?\\s+|it(?:'s| is) important (?:to note )?that\\s+|" +
      "as (?:i|we) said,?\\s+|you can see (?:that|here)\\s+|(?:eu )?cred că\\s+)",
    "iu"
  );
  // Clause boundaries a long sentence can be cut at without losing its meaning.
  const CLAUSE_SPLIT_RE = /\s*[,;:–—]\s+|\s+-\s+|\s+(?=(?:because|since|although|whereas|which|so that|but|and then|deoarece|pentru că|iar|dar)\b)/i;

  // Turns one captioned sentence into a short gist: filler and openers are
  // dropped, only the most informative clause is kept, and that clause is cut
  // down to its densest MAX_KEY_POINT_WORDS-word stretch.
  function condenseSentence(sentence, weight) {
    let text = sentence.replace(FILLER_RE, "").replace(/\s+/g, " ").trim();
    for (let prev = ""; prev !== text; ) {
      prev = text;
      text = text.replace(PREAMBLE_RE, "").trim();
    }
    text = text.replace(/[.!?…]+$/, "");

    const clauseScore = (c) => tokenize(c).reduce((sum, w) => sum + weight(w), 0);
    const clauses = text.split(CLAUSE_SPLIT_RE).map((c) => c.replace(PREAMBLE_RE, "").trim())
      .filter((c) => c.split(/\s+/).length >= MIN_CLAUSE_WORDS);
    if (clauses.length > 1) text = clauses.reduce((best, c) => (clauseScore(c) > clauseScore(best) ? c : best));

    // Keep the start (who does what) and cut the tail, at an "and"/"or" when
    // there is one, so the gist doesn't lose its subject.
    let words = text.split(/\s+/).filter(Boolean);
    let cut = false;
    if (words.length > MAX_KEY_POINT_WORDS) {
      words = words.slice(0, MAX_KEY_POINT_WORDS);
      for (let i = words.length - 1; i >= MIN_CLAUSE_WORDS + 1; i--) {
        if (/^(?:and|or|but|și|sau|dar)$/i.test(words[i])) {
          words = words.slice(0, i);
          break;
        }
      }
      cut = true;
    }
    // A gist shouldn't end on "to", "the", "and", … after being cut.
    while (words.length > MIN_CLAUSE_WORDS && STOPWORDS.has(normalizeWord(words[words.length - 1]))) {
      words.pop();
      cut = true;
    }
    const gist = words.join(" ").replace(/[,;:]+$/, "");
    return gist ? gist.charAt(0).toUpperCase() + gist.slice(1) + (cut ? "…" : "") : "";
  }

  // The few content words (or word pairs said together) repeated most in the
  // window — a one-line "what is this about" before the key points.
  function extractTopics(sentences, freq) {
    const pairs = new Map();
    for (const s of sentences) {
      const words = (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
      for (let i = 0; i + 1 < words.length; i++) {
        const [a, b] = [words[i], words[i + 1]];
        if (a.length > 2 && b.length > 2 && !STOPWORDS.has(a) && !STOPWORDS.has(b)) {
          pairs.set(`${a} ${b}`, (pairs.get(`${a} ${b}`) || 0) + 1);
        }
      }
    }
    const candidates = [
      ...[...pairs].filter(([, n]) => n >= 2).map(([t, n]) => ({ t, n: n * 1.5 })),
      ...[...freq].filter(([, n]) => n >= 2).map(([t, n]) => ({ t, n })),
    ].sort((a, b) => b.n - a.n);
    const topics = [];
    for (const { t } of candidates) {
      if (topics.some((p) => p.includes(t) || t.includes(p))) continue;
      topics.push(t);
      if (topics.length === MAX_TOPICS) break;
    }
    return topics;
  }

  // Classic frequency-based extractive summary: score each sentence by how
  // many of the conversation's most-repeated content words it contains, keep
  // the top few in the order they were said, and shorten each to its gist.
  // Returns { topics, points }.
  function summarizeExtractive(transcript) {
    // Fragments like "the way things are." aren't ideas; prefer full sentences.
    const all = splitSentences(transcript);
    const full = all.filter((s) => s.split(/\s+/).length >= MIN_KEY_POINT_WORDS);
    const sentences = full.length ? full : all;

    const freq = new Map();
    for (const s of sentences) for (const w of tokenize(s)) freq.set(w, (freq.get(w) || 0) + 1);
    const maxFreq = Math.max(1, ...freq.values());
    const weight = (w) => (freq.get(w) || 0) / maxFreq;
    const topics = extractTopics(sentences, freq);
    const condense = (list) => [...new Set(list.map((s) => condenseSentence(s, weight)).filter(Boolean))];
    if (sentences.length <= 1) return { topics, points: condense(sentences) };

    const scored = sentences.map((s, index) => {
      const tokens = tokenize(s);
      const score = tokens.reduce((sum, w) => sum + freq.get(w) / maxFreq, 0) / Math.sqrt(tokens.length || 1);
      return { s, index, score };
    });
    // Best-scoring first, skipping any sentence that mostly repeats one
    // already picked, so the key points are actually different ideas.
    const picked = [];
    for (const entry of scored.sort((a, b) => b.score - a.score)) {
      const tokens = new Set(tokenize(entry.s));
      const repeats = picked.some((p) => similarity(tokens, p.tokens) >= DUPLICATE_SIMILARITY);
      if (repeats) continue;
      picked.push({ ...entry, tokens });
      if (picked.length === EXTRACTIVE_MAX_SENTENCES) break;
    }
    return { topics, points: condense(picked.sort((a, b) => a.index - b.index).map((entry) => entry.s)) };
  }

  // Both summaries end up as one look: optional "Topics:" line, then bullets.
  function formatRecap(topics, points) {
    const lines = [];
    if (topics.length) lines.push("Topics: " + topics.join(", "));
    if (points.length) lines.push("Key points:\n• " + points.join("\n• "));
    return lines.join("\n");
  }

  // The Summarizer's "key-points" output is a plain-text list ("* …", "- …");
  // re-bullet it to match the local summary.
  function formatOnDeviceSummary(summary) {
    const points = summary.split(/\n+/).map((l) => l.replace(/^\s*(?:[*•-]|\d+[.)])\s*/, "").trim()).filter(Boolean);
    return points.length > 1 ? formatRecap([], points) : summary;
  }

  // Share of words two sentences have in common (Jaccard index, 0–1).
  function similarity(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / (a.size + b.size - shared);
  }

  async function handleButtonClick() {
    if (requestInFlight) return;
    const transcript = recentTranscriptText();
    if (transcript.length < MIN_CHARS_TO_SUMMARIZE) {
      showPanel(`Not enough recent speech captured (last ${windowSeconds}s) — make sure Meet's captions are on.`);
      return;
    }

    requestInFlight = true;
    try {
      showPanel("Summarizing…");
      const aiSummary = await summarizeOnDevice(transcript);
      if (aiSummary) {
        showPanel(formatOnDeviceSummary(aiSummary));
        return;
      }
      const { topics, points } = summarizeExtractive(transcript);
      showPanel(points.length ? formatRecap(topics, points) : "No summary available yet.");
    } catch (err) {
      getLogger().warn?.("recap failed", err);
      showPanel("Recap unavailable — please try again.");
      safeReportError(err);
    } finally {
      requestInFlight = false;
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  function init(context) {
    try {
      ctx = context || null;
      destroyed = false;
      logger =
        (ctx && ctx.logger) ||
        (AA.logger && typeof AA.logger.scope === "function" ? AA.logger.scope("overlays:ai-recap") : console);
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
      windowSeconds = Number(opts.windowSeconds) || windowSeconds;
      transcriptWords = [];
      blockStart = 0;
      ensureUiInjected();
      startPolling();
      enabled = true;
      getLogger().info?.(`enabled (window ${windowSeconds}s)`);
    } catch (err) {
      safeReportError(err);
    }
  }

  function disable() {
    try {
      enabled = false;
      stopPolling();
      removeUi();
      transcriptWords = [];
      blockStart = 0;
      if (summarizer && typeof summarizer.destroy === "function") summarizer.destroy();
      summarizer = null;
      summarizerPending = null;
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
      if (opts.windowSeconds != null && Number(opts.windowSeconds) !== windowSeconds) {
        windowSeconds = Number(opts.windowSeconds);
      }
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
  AA.overlays.aiRecap = {
    id: MODULE_ID,
    init,
    enable,
    disable,
    update,
    destroy,
  };
  AA.overlayRegistry?.register(AA.overlays.aiRecap);
})(typeof window !== "undefined" ? window : globalThis);
