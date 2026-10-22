/**
 * content/overlays/custom-hotkeys.js
 * Custom keyboard shortcuts for motor disabilities / reduced mobility —
 * trigger Meet's own mic/camera/leave-call buttons without needing to aim a
 * pointer at a small on-screen target. Implements the OverlayModule contract
 * (ARCHITECTURE.md §4): init(ctx), enable(options), disable(), update(options),
 * destroy().
 *
 * Clicks Meet's REAL buttons by matching their `aria-label` (Meet keeps these
 * for its own accessibility support, so they're the most stable hook
 * available — still unofficial/unstable like everything else that reaches
 * into Meet's DOM, ARCHITECTURE.md §6/§7, so every lookup degrades to a
 * silent no-op instead of throwing if Meet's markup ever changes). Keyword
 * lists are multilingual (English + Romanian, Meet's UI language follows the
 * user's Google account/browser locale, not this extension's) and compared
 * with diacritics stripped, so "Microfon"/"Dezactivează microfonul" match
 * just as well as "Microphone"/"Turn off microphone". The mic button also
 * gets a locale-independent fallback: Meet marks it with a `data-is-muted`
 * attribute regardless of UI language.
 *
 * Options shape: { enabled, toggleMicKey, toggleCameraKey, hangUpKey }, each
 * a combo string like "alt+m" (modifier names + a single key, '+'-joined,
 * case-insensitive, order-insensitive). Matched against BOTH `event.key` and
 * `event.code` (so e.g. AltGr/international layouts that remap `key` under
 * Alt still match on the physical key).
 *
 * Deliberately ignores keystrokes while focus is in an editable field (chat
 * box, renamed-tile input, ...) so a shortcut never hijacks normal typing.
 * Shows a brief on-screen toast when a bound key is pressed but no matching
 * Meet control could be found — silent failure here is indistinguishable
 * from "the shortcut doesn't work at all", which is worse than a visible
 * "couldn't find that button" message.
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const MODULE_ID = "customHotkeys";

  const ACTIONS = [
    {
      optionKey: "toggleMicKey",
      actionLabel: "mic",
      attrSelector: "[data-is-muted]",
      labelKeywords: ["microphone", "microfon", "mikrofon"],
    },
    {
      optionKey: "toggleCameraKey",
      actionLabel: "camera",
      attrSelector: null,
      labelKeywords: ["camera", "kamera"],
    },
    {
      optionKey: "hangUpKey",
      actionLabel: "leave call",
      attrSelector: null,
      // Stems, not full words — Romanian Meet may phrase this as
      // "Părăsiți apelul" (formal) rather than "Părăsește apelul" (the
      // form originally guessed here), and those only share a PREFIX once
      // diacritics are stripped ("parasiti" vs "paraseste"), not the whole
      // word. "paras"/"inchei" match either conjugation.
      labelKeywords: ["leave call", "end call", "hang up", "paras", "inchei", "iesi"],
    },
  ];

  let ctx = null;
  let logger = null;
  let enabled = false;
  let destroyed = false;
  let bindings = {}; // optionKey -> canonical combo string ("alt+m")
  let keydownHandler = null;

  function getLogger() {
    if (logger) return logger;
    if (ctx && ctx.logger) return ctx.logger;
    if (AA.logger && typeof AA.logger.scope === "function") {
      return AA.logger.scope("overlays:custom-hotkeys");
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

  // Canonicalizes a combo string so "Alt+M" / "m+alt" / " alt + m " all
  // compare equal: lowercase, trim, drop empties, sort parts.
  function canonicalCombo(str) {
    if (!str || typeof str !== "string") return "";
    return str
      .toLowerCase()
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean)
      .sort()
      .join("+");
  }

  // Strips diacritics (NFD + drop combining marks) and lowercases, so
  // "Microfon"/"Părăsește" compare cleanly against plain-ASCII keywords.
  function normalizeText(str) {
    return (str || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  function comboPartsFromEvent(event) {
    const mods = [];
    if (event.ctrlKey) mods.push("ctrl");
    if (event.altKey) mods.push("alt");
    if (event.shiftKey) mods.push("shift");
    if (event.metaKey) mods.push("meta");
    return mods;
  }

  // Returns both a `key`-based combo and a `code`-based combo for the same
  // keydown — some layouts (AltGr/international) remap `event.key` under a
  // modifier to something unexpected, while `event.code` always reflects the
  // physical key pressed. Checking both makes bindings layout-resilient.
  function combosFromEvent(event) {
    const mods = comboPartsFromEvent(event);
    const key = (event.key || "").toLowerCase();
    const code = (event.code || "").replace(/^Key/, "").toLowerCase();
    const combos = [];
    if (key && !["control", "alt", "shift", "meta"].includes(key)) {
      combos.push([...mods, key].sort().join("+"));
    }
    if (code && code !== key) {
      combos.push([...mods, code].sort().join("+"));
    }
    return combos;
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function showToast(text) {
    try {
      if (typeof document === "undefined" || !document.body) return;
      const toast = document.createElement("div");
      toast.setAttribute("data-aa-overlay", MODULE_ID);
      toast.textContent = text;
      toast.style.cssText =
        "position:fixed;bottom:16px;left:16px;z-index:2147483647;" +
        "background:#3c1414;color:#fff;font:600 13px sans-serif;" +
        "padding:10px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);" +
        "pointer-events:none;opacity:1;transition:opacity 400ms ease;";
      document.body.appendChild(toast);
      global.setTimeout(() => {
        toast.style.opacity = "0";
        global.setTimeout(() => toast.remove(), 450);
      }, 2200);
    } catch (err) {
      safeReportError(err);
    }
  }

  // Checked in order: aria-label (Meet's primary accessible name), then
  // data-tooltip/title (some Meet controls expose their name only as a
  // hover tooltip rather than aria-label) — broadens the match surface
  // without assuming any one attribute is always present.
  const LABEL_ATTRS = ["aria-label", "data-tooltip", "title"];

  // A broad keyword like "camera" can also match a settings panel's "Choose
  // a camera" dropdown or a "Camera settings" menu item, not just the
  // toolbar's toggle button — those live inside a menu/listbox/dialog, the
  // toolbar toggle never does. Same exclusion technique focus-mode.js and
  // ai-recap.js already use for this exact class of false-positive match.
  const SETTINGS_UI_EXCLUDE_SELECTOR = [
    '[role="menu"]', '[role="menuitem"]', '[role="menuitemradio"]',
    '[role="listbox"]', '[role="option"]', '[role="dialog"]', '[role="combobox"]',
  ].join(",");

  function clickMeetControl(action) {
    try {
      if (typeof document === "undefined") return false;
      if (action.attrSelector) {
        const byAttr = document.querySelector(action.attrSelector);
        if (byAttr) {
          byAttr.click();
          return true;
        }
      }
      const selector = LABEL_ATTRS.map((attr) => `[${attr}]`).join(",");
      const candidates = document.querySelectorAll(selector);
      for (const el of candidates) {
        if (el.closest(SETTINGS_UI_EXCLUDE_SELECTOR)) continue;
        for (const attr of LABEL_ATTRS) {
          const raw = el.getAttribute(attr);
          if (!raw) continue;
          const label = normalizeText(raw);
          if (action.labelKeywords.some((kw) => label.includes(kw))) {
            el.click();
            return true;
          }
        }
      }
      return false;
    } catch (err) {
      safeReportError(err);
      return false;
    }
  }

  function handleKeydown(event) {
    try {
      if (!enabled || destroyed) return;
      if (isEditableTarget(event.target)) return;
      const combos = combosFromEvent(event);
      if (combos.length === 0) return;
      for (const action of ACTIONS) {
        const bound = bindings[action.optionKey];
        if (bound && combos.includes(bound)) {
          event.preventDefault();
          event.stopPropagation();
          const clicked = clickMeetControl(action);
          if (!clicked) {
            getLogger().warn?.(`no matching Meet control found for "${action.optionKey}"`);
            showToast(`Couldn't find the ${action.actionLabel} button on this page.`);
          }
          return;
        }
      }
    } catch (err) {
      safeReportError(err);
    }
  }

  function applyBindings(options) {
    bindings = {};
    for (const action of ACTIONS) {
      const combo = canonicalCombo(options[action.optionKey]);
      if (combo) bindings[action.optionKey] = combo;
    }
  }

  function init(context) {
    try {
      ctx = context || null;
      destroyed = false;
      logger =
        (ctx && ctx.logger) ||
        (AA.logger && typeof AA.logger.scope === "function" ? AA.logger.scope("overlays:custom-hotkeys") : console);
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
      applyBindings(opts);
      if (!keydownHandler) {
        keydownHandler = handleKeydown;
        document.addEventListener("keydown", keydownHandler, true);
      }
      enabled = true;
      getLogger().info?.("enabled", bindings);
    } catch (err) {
      safeReportError(err);
    }
  }

  function disable() {
    try {
      enabled = false;
      if (keydownHandler) {
        document.removeEventListener("keydown", keydownHandler, true);
        keydownHandler = null;
      }
      bindings = {};
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
      applyBindings(opts);
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
  AA.overlays.customHotkeys = {
    id: MODULE_ID,
    init,
    enable,
    disable,
    update,
    destroy,
  };
  AA.overlayRegistry?.register(AA.overlays.customHotkeys);
})(typeof window !== "undefined" ? window : globalThis);
