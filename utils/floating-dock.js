/**
 * utils/floating-dock.js
 * One shared bottom-right row for the extension's on-screen buttons
 * ("Pause videos", "Catch me up", …), so several modules can each add a
 * button without overlapping one another. Sits above Meet's bottom control
 * bar. The dock is created on the first add() and removed when its last
 * button is removed.
 *
 * Public API: AA.floatingDock.add(button, order), remove(button),
 *             createButton(label), PANEL_BOTTOM_PX (where a module's popup
 *             panel should sit so it clears the dock).
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});

  const DOCK_ID = "aa-floating-dock";
  const DOCK_BOTTOM_PX = 96; // clears Meet's ~80px bottom control bar
  const BUTTON_HEIGHT_PX = 38;

  let dockEl = null;

  function ensureDock() {
    if (dockEl && dockEl.isConnected) return dockEl;
    if (typeof document === "undefined" || !document.body) return null;
    dockEl = document.createElement("div");
    dockEl.id = DOCK_ID;
    dockEl.setAttribute("data-aa-overlay", "floatingDock");
    dockEl.style.cssText =
      `position:fixed;bottom:${DOCK_BOTTOM_PX}px;right:24px;z-index:2147483646;` +
      "display:flex;flex-direction:row;align-items:center;gap:8px;";
    document.body.appendChild(dockEl);
    return dockEl;
  }

  // Buttons are kept sorted by their `order` (lower = further left), so the
  // row looks the same whichever module happens to enable first.
  function add(button, order) {
    const dock = ensureDock();
    if (!dock || !button) return;
    button.dataset.aaDockOrder = String(order || 0);
    const after = Array.from(dock.children).find((el) => Number(el.dataset.aaDockOrder) > (order || 0));
    dock.insertBefore(button, after || null);
  }

  function remove(button) {
    if (button && button.parentNode) button.parentNode.removeChild(button);
    if (dockEl && dockEl.children.length === 0) {
      if (dockEl.parentNode) dockEl.parentNode.removeChild(dockEl);
      dockEl = null;
    }
  }

  function createButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText =
      `height:${BUTTON_HEIGHT_PX}px;background:#1a73e8;color:#fff;border:none;border-radius:999px;` +
      "padding:0 18px;font:600 13px sans-serif;cursor:pointer;white-space:nowrap;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.3);";
    return button;
  }

  AA.floatingDock = {
    add,
    remove,
    createButton,
    PANEL_BOTTOM_PX: DOCK_BOTTOM_PX + BUTTON_HEIGHT_PX + 10,
  };
})(typeof window !== "undefined" ? window : globalThis);
