/**
 * ui/popup/popup.js
 * Preference UI (ARCHITECTURE.md §9 step 5). Runs in the extension popup
 * page, which loads utils/logger.js, utils/storage.js, utils/messaging.js
 * before this file (see popup.html) — so it talks to AA.storage exactly the
 * way content-main.js does, never touching chrome.storage directly
 * (ARCHITECTURE.md §3).
 *
 * The ONLY UI is the condition menu (CONDITIONS below): a flat list of
 * disability/condition names. Clicking one expands an inline panel with
 * exactly the relevant module toggle(s) and their fields, pre-applied to
 * sensible defaults — every toggle/slider writes the same AA.storage
 * profile (see `instancesByKey`). Every condition from the original brief
 * is listed, including ones this extension can't fully serve — those show
 * an honest note instead of silently doing nothing or being hidden (see
 * ARCHITECTURE.md §8's note on what's out of scope and why: anything
 * requiring reading structure out of a shared screen's video pixels — OCR,
 * table/number detection — isn't reliable enough locally to offer honestly).
 */
(function () {
  "use strict";

  const AA = (window.AA = window.AA || {});

  const MODULE_CONFIGS = [
    {
      key: "contrast",
      registry: "filters",
      label: "High contrast",
      fields: [
        {
          type: "select",
          key: "level",
          label: "Level",
          options: [
            { value: "high", label: "High" },
            { value: "max", label: "Max" },
            { value: "custom", label: "Custom" },
          ],
        },
        { type: "range", key: "amount", label: "Contrast amount (Custom level)", min: 1, max: 3, step: 0.1, unit: "x" },
        { type: "range", key: "saturate", label: "Saturation (Custom level)", min: 0.5, max: 2, step: 0.05, unit: "x" },
      ],
    },
    {
      key: "colorblind",
      registry: "filters",
      label: "Color-blind correction",
      fields: [
        {
          type: "select",
          key: "mode",
          label: "Mode",
          options: [
            { value: "protanopia", label: "Protanopia" },
            { value: "deuteranopia", label: "Deuteranopia" },
            { value: "tritanopia", label: "Tritanopia" },
          ],
        },
        { type: "range", key: "intensity", label: "Correction strength", min: 0, max: 100, step: 5, unit: "%" },
      ],
    },
    {
      key: "inversion",
      registry: "filters",
      label: "Color inversion / dimming",
      fields: [
        { type: "checkbox", key: "invertColors", label: "Invert colors" },
        { type: "checkbox", key: "smart", label: "Smart (skip video/images, invert only)" },
        { type: "range", key: "brightness", label: "Dim brightness", min: 0.3, max: 1, step: 0.05, unit: "x" },
      ],
    },
    {
      key: "readingRuler",
      registry: "overlays",
      label: "Reading ruler",
      fields: [
        { type: "range", key: "height", label: "Height", min: 20, max: 200, step: 4, unit: "px" },
        { type: "range", key: "opacity", label: "Dim opacity", min: 0, max: 1, step: 0.05 },
      ],
    },
    {
      key: "magnifier",
      registry: "overlays",
      label: "Magnifier",
      fields: [
        { type: "range", key: "zoom", label: "Zoom", min: 1.5, max: 4, step: 0.1, unit: "x" },
        { type: "range", key: "size", label: "Lens size", min: 120, max: 480, step: 20, unit: "px" },
        {
          type: "select",
          key: "shape",
          label: "Shape",
          options: [
            { value: "circle", label: "Circle" },
            { value: "rect", label: "Rectangle" },
          ],
        },
      ],
    },
    {
      key: "pauseVideos",
      registry: "overlays",
      label: "\"Pause videos\" button (on screen — freezes every video, including a shared screen)",
      fields: [],
    },
    {
      key: "focusMode",
      registry: "overlays",
      label: "Focus mode",
      fields: [
        { type: "checkbox", key: "dimOthers", label: "Dim everyone except whoever's speaking" },
        { type: "checkbox", key: "hideSelfView", label: "Hide my own camera tile" },
        { type: "checkbox", key: "hideReactions", label: "Hide floating emoji reactions" },
      ],
    },
    {
      key: "liveCaptions",
      registry: "overlays",
      label: "Live captions (local — turns on Meet's own captions)",
      fields: [],
    },
    {
      key: "aiRecap",
      registry: "overlays",
      label: "AI \"Catch me up\" (local — summarized on this device)",
      fields: [{ type: "range", key: "windowSeconds", label: "Recap window", min: 30, max: 300, step: 30, unit: "s" }],
    },
    {
      key: "customHotkeys",
      registry: "overlays",
      label: "Custom hotkeys",
      fields: [
        { type: "text", key: "toggleMicKey", label: "Toggle mic", placeholder: "alt+m" },
        { type: "text", key: "toggleCameraKey", label: "Toggle camera", placeholder: "alt+c" },
        { type: "text", key: "hangUpKey", label: "Leave call", placeholder: "alt+h" },
      ],
    },
  ];

  const MODULE_CONFIG_BY_KEY = new Map(MODULE_CONFIGS.map((c) => [c.key, c]));

  // Flat list of disability/condition buttons shown by NAME ONLY. Clicking
  // one expands a panel with the real module toggle(s) that apply (`preset`
  // turns them on with sensible defaults) plus an honest `note` about
  // anything from the original brief this extension can't serve locally yet
  // (OCR, audio EQ, voice navigation, ...). `preset` only lists keys to turn
  // ON — applying one never touches unrelated modules. Every module,
  // including live captions, is fully local — no AI, no network calls —
  // see ARCHITECTURE.md §8.
  const CONDITIONS = [
    {
      id: "dyslexia",
      label: "Dyslexia",
      preset: {
        readingRuler: { enabled: true, height: 48, opacity: 0.85 },
      },
      note: "Turns on the reading ruler. OCR text extraction and increasing text spacing INSIDE a shared screen aren't possible locally — a shared screen is video, not editable text.",
    },
    {
      id: "adhd",
      label: "ADHD",
      preset: {
        pauseVideos: { enabled: true },
        focusMode: { enabled: true, dimOthers: true, hideSelfView: true, hideReactions: true },
        liveCaptions: { enabled: true },
        aiRecap: { enabled: true, windowSeconds: 120 },
      },
      note: "Adds two buttons in the bottom-right corner of the call: \"Pause videos\" freezes every video, including a shared screen, until you click it again, and \"Catch me up\" summarizes the last 2 minutes of captioned speech whenever you lose the thread (made on this device — Chrome's built-in AI when available, otherwise a local key-points summary). Also dims everyone except whoever's currently speaking, hides your own camera tile and floating emoji reactions, and turns on Meet's own captions — all fully local, nothing is sent anywhere.",
    },
    {
      id: "autism",
      label: "Autism (ASD)",
      preset: {
        pauseVideos: { enabled: true },
        focusMode: { enabled: true, dimOthers: false, hideSelfView: false, hideReactions: true },
        liveCaptions: { enabled: true },
        aiRecap: { enabled: true, windowSeconds: 120 },
      },
      note: "Adds two buttons in the bottom-right corner of the call for moments of sensory overload: \"Pause videos\" freezes every video, including a shared screen, until you click it again, and \"Catch me up\" summarizes the last 2 minutes of captioned speech (made on this device — nothing is sent anywhere). Also hides floating emoji reactions and turns on Meet's own captions — all fully local. Toning down harsh colors and a dedicated sensory mode don't exist yet as separate modules — leave the contrast/color filters below off for the calmest look. Speaker-dimming and self-view hiding are available in the card below if you want them too.",
    },
    {
      id: "dyscalculia",
      label: "Dyscalculia",
      preset: {
        magnifier: { enabled: true, zoom: 2, size: 280, shape: "rect" },
        readingRuler: { enabled: true, height: 48, opacity: 0.85 },
      },
      note: "A rectangular magnifier to enlarge numbers and a reading ruler to keep your place along a row of figures or a table. Highlighting rows/columns inside a SHARED screen isn't possible — that's someone else's video, not editable text.",
    },
    {
      id: "dysgraphia",
      label: "Dysgraphia",
      preset: {
        liveCaptions: { enabled: true },
        aiRecap: { enabled: true, windowSeconds: 120 },
      },
      note: "Takes the pressure off note-taking: turns on Meet's own captions so you can follow without writing things down, and adds a \"Catch me up\" button that summarizes the last 2 minutes of captioned speech (made on this device — nothing is sent anywhere). Dictating into chat isn't available locally yet.",
    },
    {
      id: "low-vision",
      label: "Low vision",
      preset: {
        magnifier: { enabled: true, zoom: 2.5, size: 260, shape: "circle" },
        contrast: { enabled: true, level: "high" },
      },
      note: "Dynamic magnifier (150%-400% zoom) that follows the cursor, plus high contrast so text and controls stand out — switch the contrast level to \"max\" in the card below if you need more. Enlarging Meet's own control font isn't available locally yet.",
    },
    {
      id: "colorblind-condition",
      label: "Color blindness",
      preset: { colorblind: { enabled: true, mode: "deuteranopia" } },
      note: "Defaults to deuteranopia — change the mode in the card below if you need protanopia or tritanopia.",
    },
    {
      id: "photophobia",
      label: "Photophobia",
      preset: { inversion: { enabled: true, invertColors: false, brightness: 0.6 } },
      note: "Dims the whole call (including video/shared screen) to 60% brightness — not color inversion, which would make Meet's dark theme BRIGHTER instead of darker. Turn \"Invert colors\" on in the card below too if you also want the smart/full color-inversion filter; the two are independent now.",
    },
    {
      id: "hearing",
      label: "Hard of hearing",
      preset: {
        liveCaptions: { enabled: true },
        aiRecap: { enabled: true, windowSeconds: 120 },
      },
      note: "Turns on Meet's own captions (clicks Meet's own \"turn on captions\" button for you if they're off) and adds a \"Catch me up\" button that summarizes the last 2 minutes of captioned speech if you missed part of it. Fully local — nothing is sent anywhere. Auto-saved transcripts aren't built yet.",
    },
    {
      id: "apd",
      label: "APD",
      preset: {
        liveCaptions: { enabled: true },
        aiRecap: { enabled: true, windowSeconds: 120 },
      },
      note: "Turns on Meet's own captions and adds a \"Catch me up\" button that summarizes the last 2 minutes of captioned speech, for when processing what was said takes a moment longer. Fully local — nothing is sent anywhere. An audio equalizer and background noise reduction aren't available yet.",
    },
    {
      id: "motor",
      label: "Motor disabilities",
      preset: {
        customHotkeys: { enabled: true, toggleMicKey: "alt+m", toggleCameraKey: "alt+c", hangUpKey: "alt+h" },
      },
      note: "Default hotkeys: Alt+M toggles mic, Alt+C toggles camera, Alt+H leaves the call — change them in the card below. Ignored while typing in chat or any text field. Voice-command navigation and enlarged click targets aren't available locally yet.",
    },
    {
      id: "social-anxiety",
      label: "Social anxiety",
      preset: {
        focusMode: { enabled: true, dimOthers: false, hideSelfView: true, hideReactions: true },
      },
      note: "Hides your own camera tile (so you're not watching yourself) and floating emoji reactions. This only changes what YOU see locally — it doesn't hide your camera from other participants or change how they see you. \"Pause videos\" (in the card below, or the ADHD/autism preset) is also available if you want a moment to collect yourself mid-call.",
    },
    {
      id: "sensory-processing",
      label: "Sensory Processing Disorder",
      preset: {
        inversion: { enabled: true, invertColors: false, brightness: 0.6 },
        focusMode: { enabled: true, dimOthers: false, hideSelfView: false, hideReactions: true },
      },
      note: "Dims the whole call to reduce visual intensity (not color inversion — see the dedicated photophobia preset for why that distinction matters) and hides floating emoji reactions. Doesn't touch audio volume or Meet's own UI sounds/animations — only presentation-layer dimming.",
    },
    {
      id: "photosensitive-epilepsy",
      label: "Photosensitive epilepsy",
      preset: {
        inversion: { enabled: true, invertColors: false, brightness: 0.5 },
        pauseVideos: { enabled: true },
      },
      note: "Dims the call to 50% brightness and adds the on-screen \"Pause videos\" button so you can freeze a shared screen or camera INSTANTLY if it starts flashing/strobing. This extension cannot detect flashing content automatically — it's your judgment call to hit pause. For a confirmed seizure risk, treat this as a convenience, not a safety guarantee; leaving the call is always the safer option if something looks dangerous.",
    },
    {
      id: "motion-sensitivity",
      label: "Motion sensitivity / vestibular",
      preset: {
        pauseVideos: { enabled: true },
      },
      note: "Adds the on-screen \"Pause videos\" button to freeze every video — including a shared screen — when motion (scrolling content, camera movement, animated shares) becomes disorienting. Only affects video playback; it can't stop Meet's own UI transitions/animations.",
    },
  ];

  const offsiteNoticeEl = document.getElementById("aa-offsite-notice");

  // key -> array of rendered card instances ({ root, switchInput, badgeEl,
  // fieldInputs, config }) — a module can appear inside one or more expanded
  // condition panels; all instances of the same key stay in sync.
  const instancesByKey = new Map();

  let currentProfile = {};
  let activeTabId = null;
  let onMeetTab = false;

  function logger() {
    return AA.logger ? AA.logger.scope("popup") : console;
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of children || []) node.appendChild(child);
    return node;
  }

  function buildFieldRow(idPrefix, field, onChange) {
    const label = el("label", { for: `${idPrefix}-${field.key}`, text: field.label });
    let input;

    if (field.type === "select") {
      input = el("select", { id: `${idPrefix}-${field.key}` }, []);
      for (const opt of field.options) {
        input.appendChild(el("option", { value: opt.value, text: opt.label }, []));
      }
      input.addEventListener("change", () => onChange(input.value));
    } else if (field.type === "checkbox") {
      input = el("input", { type: "checkbox", id: `${idPrefix}-${field.key}` }, []);
      input.addEventListener("change", () => onChange(input.checked));
    } else if (field.type === "range") {
      input = el(
        "input",
        { type: "range", id: `${idPrefix}-${field.key}`, min: String(field.min), max: String(field.max), step: String(field.step) },
        []
      );
      input.addEventListener("input", () => onChange(Number(input.value)));
    } else if (field.type === "text") {
      input = el("input", { type: "text", id: `${idPrefix}-${field.key}`, placeholder: field.placeholder || "" }, []);
      input.addEventListener("change", () => onChange(input.value));
    }

    const row = el("div", { class: "aa-option-row" }, [label, input]);
    return { row, input };
  }

  // Builds one module card (toggle + fields) inside a condition panel.
  // Registers itself in instancesByKey so handleToggle/handleFieldChange/
  // renderAll/applyStatus keep every rendered copy of a given key in sync
  // (the same key can appear in more than one condition's panel).
  function buildModuleCard(key, idPrefix, { withBadge }) {
    const config = MODULE_CONFIG_BY_KEY.get(key);
    if (!config) return null;

    const switchInput = el("input", { type: "checkbox", id: `${idPrefix}-enabled` }, []);
    const track = el("span", { class: "aa-track" }, [el("span", { class: "aa-thumb" }, [])]);
    const switchEl = el("label", { class: "aa-switch" }, [switchInput, track]);

    const badgeEl = withBadge ? el("span", { class: "aa-badge-error", hidden: "hidden", text: "module unavailable" }, []) : null;
    const titleChildren = [el("span", { text: config.label }, [])];
    if (badgeEl) titleChildren.push(badgeEl);
    const titleEl = el("span", { class: "aa-module-title" }, titleChildren);

    const head = el("div", { class: "aa-module-head" }, [titleEl, switchEl]);
    const optionsEl = el("div", { class: "aa-module-options" }, []);

    const fieldInputs = {};
    for (const field of config.fields) {
      const { row, input } = buildFieldRow(idPrefix, field, (val) => handleFieldChange(config, field.key, val));
      fieldInputs[field.key] = input;
      optionsEl.appendChild(row);
    }

    const root = el("div", { class: "aa-module", "data-module": key, "data-enabled": "false" }, [head, optionsEl]);
    switchInput.addEventListener("change", () => handleToggle(config, switchInput.checked));

    const instance = { root, switchInput, badgeEl, fieldInputs, config };
    if (!instancesByKey.has(key)) instancesByKey.set(key, []);
    instancesByKey.get(key).push(instance);
    return instance;
  }

  function currentOptionsForKey(key) {
    const stored = currentProfile[key] || {};
    const defaults = (AA.storage && AA.storage.DEFAULT_STATE.profile[key]) || {};
    return { ...defaults, ...stored };
  }

  async function persist(key, options) {
    try {
      currentProfile[key] = options;
      await AA.storage.setSlice(`profile.${key}`, options);
    } catch (err) {
      logger().error(`failed to persist profile.${key}`, err);
    }
  }

  function handleToggle(config, isEnabled) {
    const options = { ...currentOptionsForKey(config.key), enabled: isEnabled };
    persist(config.key, options); // currentProfile updates synchronously inside persist(), before its await
    renderAll();
  }

  function handleFieldChange(config, fieldKey, value) {
    const options = { ...currentOptionsForKey(config.key), [fieldKey]: value };
    persist(config.key, options);
    renderAll();
  }

  function renderCardInstance(instance) {
    const options = currentOptionsForKey(instance.config.key);
    instance.switchInput.checked = !!options.enabled;
    instance.root.dataset.enabled = String(!!options.enabled);
    for (const field of instance.config.fields) {
      const input = instance.fieldInputs[field.key];
      if (!input) continue;
      const value = options[field.key];
      if (document.activeElement === input) continue; // don't fight the user mid-interaction
      if (field.type === "checkbox") input.checked = !!value;
      else input.value = String(value);
    }
  }

  function renderAll() {
    for (const instances of instancesByKey.values()) {
      for (const instance of instances) renderCardInstance(instance);
    }
  }

  // ---- condition menu --------------------------------------------------

  async function applyConditionPreset(item) {
    for (const [key, options] of Object.entries(item.preset)) {
      await persist(key, { ...currentOptionsForKey(key), ...options });
    }
    renderAll();
  }

  function presetKeysForConditionId(id) {
    const condition = CONDITIONS.find((c) => c.id === id);
    return condition ? Object.keys(condition.preset) : [];
  }

  // Scoped version of resetAllToDefaults (below): un-ticking a condition
  // puts every module IT turned on back to the extension defaults (enabled:
  // false, default fields) — "restart", but only for this category's keys.
  // A module key shared with another condition panel that's STILL open
  // (e.g. focusMode under both ADHD and social anxiety) is left alone, so
  // closing one open category never un-checks another open category's
  // options.
  async function resetConditionToDefault(item) {
    const defaults = (AA.storage && AA.storage.DEFAULT_STATE.profile) || {};
    const keysUsedByOtherOpenConditions = new Set();
    for (const otherId of expandedConditionIds) {
      if (otherId === item.id) continue;
      for (const key of presetKeysForConditionId(otherId)) keysUsedByOtherOpenConditions.add(key);
    }
    for (const key of Object.keys(item.preset)) {
      if (keysUsedByOtherOpenConditions.has(key)) continue;
      if (defaults[key]) await persist(key, { ...defaults[key] });
    }
    renderAll();
  }

  function buildConditionPanel(item) {
    const panel = el("div", { class: "aa-condition-panel" }, []);
    const keys = Object.keys(item.preset);
    for (const key of keys) {
      const instance = buildModuleCard(key, `aa-cond-${item.id}-${key}`, { withBadge: true });
      if (instance) panel.appendChild(instance.root);
    }
    if (keys.length === 0) {
      panel.appendChild(el("p", { class: "aa-condition-unavailable", text: "No local toggle for this yet — see the note above." }, []));
    }
    return panel;
  }

  // One collapse function per rendered condition button, so Reset can close
  // whichever one(s) are currently expanded without re-rendering the menu.
  const conditionCollapsers = [];

  function collapseAllConditions() {
    for (const collapse of conditionCollapsers) collapse();
    persistExpandedConditions();
  }

  // Which condition ids are expanded right now, mirrored to ui.expandedConditions
  // so the NEXT popup open (a dropdown popup's JS/DOM dies on every close —
  // this is the only way to remember "ADHD was open") restores them.
  const expandedConditionIds = new Set();

  async function persistExpandedConditions() {
    try {
      await AA.storage.setSlice("ui.expandedConditions", Array.from(expandedConditionIds));
    } catch (err) {
      logger().error("failed to persist ui.expandedConditions", err);
    }
  }

  function buildConditionsMenu(initiallyExpandedIds) {
    const body = document.getElementById("aa-conditions-body");
    if (!body) return;
    const list = el("div", { class: "aa-condition-list" }, []);
    // Expanded panels render here, below the FULL row of category buttons —
    // not inline next to whichever pill was clicked (that pushed the
    // flex-wrap row around and looked messy with several open at once).
    const panelsArea = el("div", { class: "aa-condition-panels" }, []);
    const restoreSet = new Set(initiallyExpandedIds || []);

    for (const item of CONDITIONS) {
      const btn = el("button", { type: "button", class: "aa-condition-btn", text: item.label }, []);
      let panelWrap = null;
      let expanded = false;

      function setExpanded(next) {
        expanded = next;
        btn.classList.toggle("aa-condition-btn-active", expanded);
        if (panelWrap) panelWrap.hidden = !expanded;
        if (expanded) expandedConditionIds.add(item.id);
        else expandedConditionIds.delete(item.id);
      }

      function collapse() {
        if (expanded) setExpanded(false);
      }
      conditionCollapsers.push(collapse);

      // applyPresetDefaults is false only when restoring a panel that was
      // already open before the popup closed — the stored profile already
      // reflects whatever the user last set, so re-expanding must NOT
      // silently reapply the condition's defaults on top of it. Every other
      // expand (an actual click on the category pill) DOES reapply the
      // preset even if the panel DOM already exists — otherwise a category
      // the user had un-ticked stayed un-ticked on the next click instead of
      // always coming back checked.
      async function ensureExpanded(applyPresetDefaults) {
        if (!panelWrap) {
          const closeBtn = el(
            "button",
            { type: "button", class: "aa-condition-panel-close", text: "✕", "aria-label": `Close ${item.label}` },
            []
          );
          closeBtn.addEventListener("click", async () => {
            setExpanded(false);
            await resetConditionToDefault(item);
            persistExpandedConditions();
          });
          const titleBar = el("div", { class: "aa-condition-panel-title" }, [el("span", { text: item.label }, []), closeBtn]);
          panelWrap = el("div", { class: "aa-condition-panel-wrap" }, [titleBar, buildConditionPanel(item)]);
          panelsArea.appendChild(panelWrap);
        }
        if (applyPresetDefaults) await applyConditionPreset(item);
        setExpanded(true);
      }

      btn.addEventListener("click", async () => {
        if (expanded) {
          setExpanded(false);
          await resetConditionToDefault(item);
        } else {
          await ensureExpanded(true);
        }
        persistExpandedConditions();
      });

      list.appendChild(btn);
      if (restoreSet.has(item.id)) ensureExpanded(false);
    }
    body.appendChild(list);
    body.appendChild(panelsArea);
  }

  function applyStatus(statusPayload) {
    if (!statusPayload) return;
    for (const config of MODULE_CONFIGS) {
      const bucket = statusPayload[config.registry] || {};
      const instances = instancesByKey.get(config.key) || [];
      const isError = bucket[config.key] === "disabled-error";
      for (const instance of instances) {
        if (instance.badgeEl) instance.badgeEl.hidden = !isError;
      }
    }
  }

  async function queryLiveStatus() {
    if (activeTabId == null) return;
    chrome.tabs.sendMessage(activeTabId, { event: "status:query" }, (response) => {
      if (chrome.runtime.lastError) return; // no content script on this tab; not an error
      applyStatus(response);
    });
  }

  function listenForErrorRelays() {
    AA.messaging?.onRuntime((message) => {
      if (!message || message.event !== "module:error") return;
      queryLiveStatus();
    });
  }

  async function resolveActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  // ---- theme (popup-only chrome, not part of the accessibility profile) --

  const themeBtnEl = document.getElementById("aa-theme-btn");
  const THEME_LABELS = { light: "Theme: Light", dark: "Theme: Dark" };
  let currentTheme = "light";

  function applyTheme(theme) {
    currentTheme = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", currentTheme);
    if (themeBtnEl) themeBtnEl.textContent = THEME_LABELS[currentTheme];
  }

  function wireThemeButton() {
    if (!themeBtnEl) return;
    themeBtnEl.addEventListener("click", async () => {
      const next = currentTheme === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        await AA.storage.setSlice("ui.theme", next);
      } catch (err) {
        logger().error("failed to persist ui.theme", err);
      }
    });
  }

  // ---- reset-to-defaults -------------------------------------------------

  const resetBtnEl = document.getElementById("aa-reset-btn");

  async function resetAllToDefaults() {
    const defaults = (AA.storage && AA.storage.DEFAULT_STATE.profile) || {};
    for (const [key, value] of Object.entries(defaults)) {
      await persist(key, { ...value });
    }
    renderAll();
    collapseAllConditions(); // closes whichever condition panel(s) were open
  }

  function wireResetButton() {
    if (!resetBtnEl) return;
    resetBtnEl.addEventListener("click", async () => {
      try {
        await resetAllToDefaults();
        const original = resetBtnEl.textContent;
        resetBtnEl.textContent = "Reset ✓";
        setTimeout(() => {
          resetBtnEl.textContent = original;
        }, 1200);
      } catch (err) {
        logger().error("reset to defaults failed", err);
      }
    });
  }

  async function init() {
    wireResetButton();
    wireThemeButton();

    const state = await AA.storage.getState();
    currentProfile = { ...state.profile };
    applyTheme((state.ui && state.ui.theme) || "light");

    // Needs currentProfile/theme already loaded: restoring a previously-open
    // condition panel renders its module cards against the real stored
    // values, not blank/default ones.
    buildConditionsMenu((state.ui && state.ui.expandedConditions) || []);
    renderAll();

    const tab = await resolveActiveTab();
    onMeetTab = !!(tab && tab.url && tab.url.startsWith("https://meet.google.com/"));
    activeTabId = tab ? tab.id : null;
    offsiteNoticeEl.hidden = onMeetTab;

    if (onMeetTab) {
      await queryLiveStatus();
      listenForErrorRelays();
    }

    AA.storage.onChange((newValue) => {
      if (!newValue) return;
      currentProfile = { ...newValue.profile };
      renderAll();
    });
  }

  init().catch((err) => logger().error("popup init failed", err));
})();
