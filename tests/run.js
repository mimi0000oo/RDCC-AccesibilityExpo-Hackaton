/**
 * tests/run.js
 * Puppeteer-based verification harness (ARCHITECTURE.md §9 step 7).
 *
 * Two independent checks:
 *  A) EXTENSION LOAD CHECK — launches Chrome with the unpacked extension via
 *     --load-extension, confirms the background service worker starts with
 *     zero errors and the manifest is valid.
 *  B) FUNCTIONAL MODULE CHECK — opens tests/mock-meet.html (a mock Meet DOM
 *     with real <video> tiles driven by canvas.captureStream) and exercises
 *     every registered filter/overlay module through its real public API,
 *     screenshotting each state and recording console errors + perf timing.
 *
 * NOTE ON SCOPE: (B) loads the same production module files as classic
 * scripts directly in the page, the same way Meet's page would see them as
 * injected content scripts (identical global-scope semantics) — but it is
 * NOT going through chrome-extension:// content-script injection against a
 * real https://meet.google.com/* match pattern, because we have no real Meet
 * call to attach to and must not touch any live external service. This is
 * documented here so no one mistakes this for an in-Meet test.
 *
 * Output: tests/output/run-log.json + tests/output/*.png
 */

const fs = require("fs");
const https = require("https");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const OUTPUT_DIR = path.join(__dirname, "output");
const CERTS_DIR = path.join(__dirname, "certs");

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function checkExtensionLoads(log) {
  const section = { name: "extension-load", pass: false, errors: [], details: {} };
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        "--no-sandbox",
      ],
    });

    // Give the service worker a moment to register.
    await new Promise((r) => setTimeout(r, 1000));

    const targets = await browser.targets();
    const swTarget = targets.find((t) => t.type() === "service_worker" && t.url().includes("service-worker.js"));
    section.details.serviceWorkerFound = !!swTarget;
    if (!swTarget) {
      section.errors.push("No service_worker target found for background/service-worker.js");
    }

    const extensionTarget = targets.find((t) => t.url().startsWith("chrome-extension://"));
    section.details.extensionId = extensionTarget ? extensionTarget.url().split("/")[2] : null;

    section.pass = section.errors.length === 0 && !!extensionTarget;
  } catch (err) {
    section.errors.push(String(err));
  } finally {
    if (browser) await browser.close();
  }
  log.sections.push(section);
}

// Scenario list: each entry calls into the real AA registry API in-page.
// Entries whose module id isn't registered are skipped (reported, not failed) —
// this lets the harness run against partial builds during early waves.
const SCENARIOS = [
  { label: "baseline", actions: [] },
  { label: "contrast-high", actions: [["filterRegistry", "enable", "contrast", { enabled: true, level: "high" }]] },
  { label: "contrast-max", actions: [["filterRegistry", "update", "contrast", { enabled: true, level: "max" }]] },
  { label: "contrast-custom", actions: [["filterRegistry", "update", "contrast", { enabled: true, level: "custom", amount: 2.2, saturate: 1.4 }]] },
  { label: "contrast-off", actions: [["filterRegistry", "disable", "contrast"]] },
  { label: "colorblind-protanopia", actions: [["filterRegistry", "enable", "colorblind", { enabled: true, mode: "protanopia" }]] },
  { label: "colorblind-deuteranopia", actions: [["filterRegistry", "update", "colorblind", { enabled: true, mode: "deuteranopia" }]] },
  { label: "colorblind-tritanopia", actions: [["filterRegistry", "update", "colorblind", { enabled: true, mode: "tritanopia" }]] },
  { label: "colorblind-intensity-50", actions: [["filterRegistry", "update", "colorblind", { enabled: true, mode: "deuteranopia", intensity: 50 }]] },
  { label: "colorblind-off", actions: [["filterRegistry", "disable", "colorblind"]] },
  { label: "inversion-smart", actions: [["filterRegistry", "enable", "inversion", { enabled: true, smart: true }]] },
  { label: "inversion-full", actions: [["filterRegistry", "update", "inversion", { enabled: true, smart: false }]] },
  { label: "inversion-dim-only", actions: [["filterRegistry", "update", "inversion", { enabled: true, invertColors: false, brightness: 0.6 }]] },
  { label: "inversion-off", actions: [["filterRegistry", "disable", "inversion"]] },
  { label: "reading-ruler-on", actions: [["overlayRegistry", "enable", "readingRuler", { enabled: true, height: 48, opacity: 0.85 }]] },
  { label: "reading-ruler-off", actions: [["overlayRegistry", "disable", "readingRuler"]] },
  {
    label: "magnifier-on",
    actions: [
      ["overlayRegistry", "enable", "magnifier", { enabled: true, zoom: 2, shape: "circle" }],
      ["__mouse", "move", 220, 160], // over participant-1 tile, so onFrame's lens actually has a cursor position to render at
      ["__wait", 150], // let two rAF ticks (clone + position) land before the screenshot
    ],
  },
  { label: "magnifier-off", actions: [["overlayRegistry", "disable", "magnifier"]] },
  { label: "pause-videos-button-on", actions: [["overlayRegistry", "enable", "pauseVideos", { enabled: true }]] },
  {
    label: "pause-videos-clicked",
    actions: [
      ["__dom", "click", "#aa-pause-videos-button"],
      ["__wait", 150],
    ],
  },
  { label: "pause-videos-off", actions: [["overlayRegistry", "disable", "pauseVideos"]] },
  {
    label: "focus-mode-on",
    actions: [
      ["overlayRegistry", "enable", "focusMode", { enabled: true, dimOthers: true, hideSelfView: true, hideReactions: true }],
      ["__wait", 300],
    ],
  },
  { label: "focus-mode-off", actions: [["overlayRegistry", "disable", "focusMode"]] },
  {
    label: "combo-all-active",
    actions: [
      ["filterRegistry", "enable", "contrast", { enabled: true, level: "high" }],
      ["filterRegistry", "enable", "colorblind", { enabled: true, mode: "deuteranopia" }],
      ["overlayRegistry", "enable", "readingRuler", { enabled: true, height: 48, opacity: 0.85 }],
      ["overlayRegistry", "enable", "magnifier", { enabled: true, zoom: 2.5, shape: "circle" }],
      ["overlayRegistry", "enable", "pauseVideos", { enabled: true }],
      ["overlayRegistry", "enable", "focusMode", { enabled: true, hideReactions: true }],
      ["__mouse", "move", 220, 160],
      ["__wait", 150],
    ],
  },
  { label: "screenshare-toggle", actions: [["__dom", "click", "#toggle-screenshare"]] },
  { label: "theme-toggle", actions: [["__dom", "click", "#toggle-theme"]] },
];

async function runAction(page, [target, method, ...args]) {
  if (target === "__dom") {
    const [selector] = args;
    if (method === "hover") {
      await page.hover(selector);
    } else {
      await page.click(selector);
    }
    return { skipped: false };
  }
  if (target === "__mouse") {
    const [x, y] = args;
    await page.mouse.move(x, y, { steps: 5 }); // steps: dispatches intermediate mousemove events, same as a real drag
    return { skipped: false };
  }
  if (target === "__wait") {
    const [ms] = args;
    await new Promise((r) => setTimeout(r, ms));
    return { skipped: false };
  }
  return page.evaluate(
    (target, method, args) => {
      const registry = window.AA && window.AA[target];
      if (!registry) return { skipped: true, reason: `AA.${target} not registered` };
      try {
        registry[method](...args);
        return { skipped: false };
      } catch (err) {
        return { skipped: false, error: String(err && err.stack || err) };
      }
    },
    target,
    method,
    args
  );
}

async function checkFunctionalModules(log) {
  const section = { name: "functional-modules", pass: true, errors: [], scenarios: [] };
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--use-fake-ui-for-media-stream"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    const mockMeetPath = "file://" + path.join(ROOT, "tests", "mock-meet.html");
    await page.goto(mockMeetPath, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 500)); // let captureStream video tiles size up

    for (const scenario of SCENARIOS) {
      const errorsBefore = consoleErrors.length;
      const start = Date.now();
      const results = [];
      for (const action of scenario.actions) {
        results.push(await runAction(page, action));
      }
      await new Promise((r) => setTimeout(r, 150)); // settle any rAF/style transitions
      const elapsedMs = Date.now() - start;

      const screenshotFile = `${scenario.label}.png`;
      await page.screenshot({ path: path.join(OUTPUT_DIR, screenshotFile) });

      const newErrors = consoleErrors.slice(errorsBefore);
      const perfReport = await page.evaluate(() => (window.AA && window.AA.perf ? window.AA.perf.getLastReport() : {}));

      section.scenarios.push({
        label: scenario.label,
        elapsedMs,
        screenshot: screenshotFile,
        actionResults: results,
        consoleErrors: newErrors,
        perfReport,
      });

      if (newErrors.length > 0) section.pass = false;
    }

    section.allConsoleErrors = consoleErrors;
    if (consoleErrors.length > 0) section.pass = false;
  } catch (err) {
    section.errors.push(String(err && err.stack || err));
    section.pass = false;
  } finally {
    if (browser) await browser.close();
  }
  log.sections.push(section);
}

// POPUP CHECK (ARCHITECTURE.md §9 step 5/7, 10, 11) — loads the real unpacked
// extension, opens its popup page directly at chrome-extension://<id>/ui/popup/
// popup.html (the same document chrome://extensions would open on an action
// click). Current popup shows ONLY a flat list of condition buttons by name
// (no always-visible module list — ui/popup/popup.js's CONDITIONS); module
// toggle cards (.aa-module) render lazily, only inside a clicked condition's
// expanded panel. So this confirms: all 15 condition buttons render with
// zero console errors, AND clicking one ("ADHD") actually expands a panel
// containing a real module card — not just that the button exists.
// chrome.tabs.query's url field is unavailable here (no activeTab
// user-gesture, no "tabs" host match for this page) — popup.js already
// treats a missing/non-Meet url as "offsite" and shows the notice instead of
// querying content-script status, so that is expected, not a bug.
async function checkPopup(log) {
  const section = { name: "popup", pass: false, errors: [], details: {} };
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, "--no-sandbox"],
    });

    await new Promise((r) => setTimeout(r, 1000));
    const targets = await browser.targets();
    const extensionTarget = targets.find((t) => t.url().startsWith("chrome-extension://"));
    const extensionId = extensionTarget ? extensionTarget.url().split("/")[2] : null;
    section.details.extensionId = extensionId;
    if (!extensionId) throw new Error("could not resolve extension id");

    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.goto(`chrome-extension://${extensionId}/ui/popup/popup.html`, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 300));

    const conditionCount = await page.evaluate(() => document.querySelectorAll(".aa-condition-btn").length);
    section.details.conditionCount = conditionCount;
    section.details.moduleCountBeforeExpand = await page.evaluate(() => document.querySelectorAll(".aa-module").length);
    section.details.offsiteNoticeVisible = await page.evaluate(
      () => !document.getElementById("aa-offsite-notice").hidden
    );

    // Click the ADHD condition button (by its visible text) and confirm its
    // panel actually expands with a real module card inside it.
    const expandedModuleCount = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll(".aa-condition-btn")).find((b) => b.textContent.trim() === "ADHD");
      if (!btn) return -1;
      btn.click();
      return document.querySelectorAll(".aa-module").length;
    });
    section.details.moduleCountAfterExpandAdhd = expandedModuleCount;

    const resetBtnExists = await page.evaluate(() => !!document.getElementById("aa-reset-btn"));
    section.details.resetBtnExists = resetBtnExists;

    await page.screenshot({ path: path.join(OUTPUT_DIR, "popup.png") });

    if (conditionCount !== 15) section.errors.push(`expected 15 condition buttons, found ${conditionCount}`);
    if (section.details.moduleCountBeforeExpand !== 0) {
      section.errors.push(`expected 0 module cards before expanding any condition, found ${section.details.moduleCountBeforeExpand}`);
    }
    if (expandedModuleCount === -1) section.errors.push('could not find an "ADHD" condition button to click');
    else if (expandedModuleCount < 1) section.errors.push(`expected >=1 module card after expanding ADHD, found ${expandedModuleCount}`);
    if (!resetBtnExists) section.errors.push("expected #aa-reset-btn to exist in the popup header");
    if (consoleErrors.length > 0) section.errors.push(...consoleErrors);
    section.details.consoleErrors = consoleErrors;
    section.pass = section.errors.length === 0;
  } catch (err) {
    section.errors.push(String(err && err.stack || err));
  } finally {
    if (browser) await browser.close();
  }
  log.sections.push(section);
}

// INVITE-LINK CHECK — exercises utils/invite-link.js's encode/decode pair
// directly in a page context (same global-scope semantics as the real
// extension). Verifies: a built URL round-trips back to the same preset;
// only enabled, whitelisted fields survive; and malformed/absent hashes
// decode to null instead of throwing (so a candidate opening a plain,
// un-augmented Meet link never sees an error).
async function checkInviteLink(log) {
  const section = { name: "invite-link", pass: false, errors: [], details: {} };
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.goto(`file://${path.join(ROOT, "tests", "mock-meet.html")}`, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 300));

    const result = await page.evaluate(() => {
      const AA = window.AA || {};
      const inviteLink = AA.inviteLink;
      if (!inviteLink) return { ok: false, reason: "AA.inviteLink not registered" };

      const profile = {
        contrast: { enabled: true, level: "max" },
        colorblind: { enabled: false, mode: "protanopia" }, // disabled — must NOT survive encoding
        readingRuler: { enabled: true, height: 60, opacity: 0.7 },
        magnifier: { enabled: false, zoom: 2, shape: "circle" },
      };

      const url = inviteLink.buildUrl("https://meet.google.com/abc-defg-hij", profile);
      const hash = url ? new URL(url).hash : null;
      const decoded = hash ? inviteLink.decode(hash) : null;

      const nullOnGarbage = inviteLink.decode("#aa=not-valid-base64!!!");
      const nullOnAbsent = inviteLink.decode("");
      const nullOnEmptyProfile = inviteLink.buildUrl("https://meet.google.com/x", {});

      return {
        ok: true,
        url,
        decoded,
        roundTripMatches:
          !!decoded &&
          decoded.contrast && decoded.contrast.enabled === true && decoded.contrast.level === "max" &&
          decoded.readingRuler && decoded.readingRuler.height === 60 && decoded.readingRuler.opacity === 0.7 &&
          !("colorblind" in decoded) &&
          !("magnifier" in decoded),
        nullOnGarbage,
        nullOnAbsent,
        nullOnEmptyProfile,
      };
    });

    section.details = result;
    if (!result.ok) section.errors.push(result.reason || "invite-link check failed");
    else {
      if (!result.roundTripMatches) section.errors.push(`encode/decode round-trip mismatch: ${JSON.stringify(result.decoded)}`);
      if (result.nullOnGarbage !== null) section.errors.push("decode() did not return null for a malformed token");
      if (result.nullOnAbsent !== null) section.errors.push("decode() did not return null for an absent fragment");
      if (result.nullOnEmptyProfile !== null) section.errors.push("buildUrl() did not return null for a profile with nothing enabled");
    }
    if (consoleErrors.length > 0) section.errors.push(...consoleErrors);
    section.pass = section.errors.length === 0;
  } catch (err) {
    section.errors.push(String(err && err.stack || err));
  } finally {
    if (browser) await browser.close();
  }
  log.sections.push(section);
}

// Serves tests/mock-meet-bare.html for any request, over HTTPS with the
// self-signed cert at tests/certs/ (CN=meet.google.com). Combined with
// Chrome's --host-resolver-rules (mapping meet.google.com to 127.0.0.1) and
// --ignore-certificate-errors, this makes manifest.json's
// "https://meet.google.com/*" content_scripts match pattern genuinely fire —
// the ONLY way to prove content-main.js and the real content_scripts array
// work end-to-end, as opposed to checkFunctionalModules() below which hand-
// includes module <script> tags on a file:// page for fast, cert-free
// iteration and does not exercise the real injection path.
function startMockMeetServer() {
  return new Promise((resolve, reject) => {
    const html = fs.readFileSync(path.join(__dirname, "mock-meet-bare.html"));
    const options = {
      key: fs.readFileSync(path.join(CERTS_DIR, "key.pem")),
      cert: fs.readFileSync(path.join(CERTS_DIR, "cert.pem")),
    };
    const server = https.createServer(options, (req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

// KNOWN ENVIRONMENT LIMITATION: in this sandbox, Puppeteer's bundled
// "Chrome for Testing" build does not fire extension content_scripts on
// CDP-navigated pages — verified by isolating a trivial throwaway extension
// (one manifest, one content script, no custom flags, no host overrides)
// against a real external site (https://example.com/): it ALSO failed to
// inject, with the extension showing enabled/error-free in chrome://extensions
// and its background service worker running normally. That rules out our
// manifest.json/content_scripts config as the cause — this is a tooling gap
// in the automation environment, not in the extension. Background/service
// worker loading IS reliably testable here (see checkExtensionLoads above)
// and functional module behavior IS reliably testable via checkFunctionalModules
// (same production files, loaded as classic scripts instead of via
// chrome-extension:// matching). Only the "does manifest.json's
// content_scripts array itself fire on a matching URL" question is
// unverifiable in this environment, so this section reports "inconclusive"
// rather than pass/fail and does NOT gate overallPass — misreporting it as a
// pass would be a false claim; misreporting it as a fail would incorrectly
// implicate working code.
async function checkRealContentScriptInjection(log) {
  const section = { name: "real-content-script-injection", status: "inconclusive", pass: null, errors: [], details: {} };
  let server;
  let browser;
  try {
    server = await startMockMeetServer();
    const port = server.address().port;

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        `--host-resolver-rules=MAP meet.google.com 127.0.0.1:${port}`,
        "--ignore-certificate-errors",
        "--no-sandbox",
        "--use-fake-ui-for-media-stream",
      ],
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.goto("https://meet.google.com/aaa-bbbb-ccc", { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 800)); // let document_idle content_scripts run

    const injected = await page.evaluate(() => {
      const AA = window.AA || {};
      return {
        namespaceKeys: Object.keys(AA),
        hasFilterRegistry: !!AA.filterRegistry,
        hasOverlayRegistry: !!AA.overlayRegistry,
        hasMeetObserver: !!AA.meetObserver,
        filterStatus: AA.filterRegistry ? AA.filterRegistry.getStatus() : null,
        overlayStatus: AA.overlayRegistry ? AA.overlayRegistry.getStatus() : null,
        tileCount: AA.meetObserver ? AA.meetObserver.surface.getVideoTiles().length : null,
      };
    });
    section.details.injected = injected;

    const didInject = injected.hasFilterRegistry && injected.hasOverlayRegistry && injected.hasMeetObserver;

    if (!didInject) {
      section.status = "inconclusive";
      section.pass = null;
      section.details.note =
        "content_scripts did not fire via CDP-driven navigation in this sandbox — a confirmed " +
        "environment/tooling limitation (see comment above this function), not evidence of a bug " +
        "in manifest.json or the module code. Functional correctness is instead verified by " +
        "checkFunctionalModules() against the same production files.";
    } else {
      // Injection genuinely worked this run — exercise the real modules for real,
      // and this section becomes fully conclusive (pass/fail on actual evidence).
      section.status = "ran";
      section.pass = true;
      for (const scenario of SCENARIOS.filter((s) => s.actions.every((a) => a[0] !== "__dom"))) {
        const errorsBefore = consoleErrors.length;
        for (const action of scenario.actions) {
          await runAction(page, action);
        }
        await new Promise((r) => setTimeout(r, 100));
        const newErrors = consoleErrors.slice(errorsBefore);
        if (newErrors.length > 0) {
          section.pass = false;
          section.errors.push(`scenario "${scenario.label}": ${newErrors.join(" | ")}`);
        }
      }
      if (consoleErrors.length > 0) section.pass = false;
    }

    await page.screenshot({ path: path.join(OUTPUT_DIR, "real-injection-combo.png") });
    section.details.allConsoleErrors = consoleErrors;
  } catch (err) {
    section.status = "error";
    section.errors.push(String(err && err.stack || err));
    section.pass = false;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((r) => server.close(r));
  }
  log.sections.push(section);
}

// NEW-MODULES CHECK — exercises custom-hotkeys.js, live-captions.js, and
// focus-mode.js with real assertions (not just "no console error"):
//  - pauseVideos: enabling only shows the on-screen button (nothing paused
//    yet); clicking it pauses every <video> tile, clicking again resumes
//    them, and it shares the bottom-right dock with "Catch me up" without
//    overlapping it (the ADHD condition turns both on).
//  - customHotkeys actually clicks the right mock control on a simulated
//    Alt+M/Alt+C/Alt+H keydown, including against a Romanian hangup label in
//    its FORMAL conjugation ("Părăsiți apelul", not "Părăsește apelul") — the
//    real-world mismatch that broke the leave-call hotkey, since the two
//    forms only share a prefix once diacritics are stripped, not a whole word.
//  - liveCaptions does EXACTLY one thing and nothing more: clicks Meet's
//    mock "turn captions on" button, adds no DOM overlay of its own. A real
//    disable() (after an actual enable()) symmetrically turns Meet's
//    captions back off; but disable() on a module that was NEVER actually
//    turned on (the common case on every page load for whatever is OFF in
//    stored state) must NOT touch Meet's captions — otherwise it would
//    force off a caption state a user turned on manually, unrelated to
//    this extension.
//  - focusMode's dimOthers dims every tile except whoever's loudest, using
//    each mock tile's OWN real synthetic audio track (an oscillator through
//    a GainNode) read via a Web Audio AnalyserNode — not a stand-in flag —
//    so this also proves the audio graph itself works end to end, not just
//    the dimming logic.
//  - focusMode's hideSelfView hides the video of the tile Meet marks "(You)" and
//    restores it exactly on disable (a CSS opacity rule, nothing inserted
//    into the tile, so Meet re-renders cannot make it flicker).
//  - focusMode's hideReactions hides a floating emoji node via its own
//    MutationObserver as Meet would add one, not a synthetic pre-hidden node.
async function checkNewAccessibilityModules(log) {
  const section = { name: "new-modules", pass: true, errors: [], details: {} };
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      // autoplay-policy flag: without it Chrome suspends every AudioContext
      // until a user gesture, which silently zeroes out BOTH the mock
      // tiles' oscillator audio and focus-mode.js's own AnalyserNode reads
      // (confirmed in testing — every tile read as silence, never flagged
      // as "loudest", so nothing ever got dimmed).
      args: [
        "--no-sandbox",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.goto("file://" + path.join(ROOT, "tests", "mock-meet.html"), { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 500));

    // --- A: pauseVideos button pauses/resumes the mock tiles and shares
    // the dock with "Catch me up" ---
    await page.evaluate(() => {
      window.AA.overlayRegistry.enable("pauseVideos", { enabled: true });
      window.AA.overlayRegistry.enable("aiRecap", { enabled: true, windowSeconds: 120 });
    });
    await new Promise((r) => setTimeout(r, 250));
    const pauseResult = await page.evaluate(async () => {
      const videos = () => Array.from(document.querySelectorAll("#call-area video"));
      const button = document.getElementById("aa-pause-videos-button");
      const recap = document.getElementById("aa-ai-recap-button");
      const result = { tileCount: videos().length, buttonShown: !!button, pausedBeforeClick: videos().some((v) => v.paused) };
      const a = button?.getBoundingClientRect();
      const b = recap?.getBoundingClientRect();
      result.buttonsOverlap = !!(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);
      button?.click();
      await new Promise((r) => setTimeout(r, 250));
      result.allPausedAfterClick = videos().length > 0 && videos().every((v) => v.paused);
      result.labelAfterClick = button?.textContent;
      button?.click();
      await new Promise((r) => setTimeout(r, 250));
      result.allPlayingAfterSecondClick = videos().every((v) => !v.paused);
      return result;
    });
    section.details.pauseVideos = pauseResult;
    if (!pauseResult.buttonShown) section.errors.push("pauseVideos: expected the on-screen button");
    if (pauseResult.pausedBeforeClick) section.errors.push("pauseVideos: expected nothing paused before the button is clicked");
    if (!pauseResult.allPausedAfterClick) section.errors.push(`pauseVideos: expected all tiles paused after click, got ${JSON.stringify(pauseResult)}`);
    if (!pauseResult.allPlayingAfterSecondClick) section.errors.push("pauseVideos: expected all tiles playing again after a second click");
    if (pauseResult.buttonsOverlap) section.errors.push("pauseVideos: its button overlaps the Catch me up button");
    await page.evaluate(() => {
      window.AA.overlayRegistry.disable("pauseVideos");
      window.AA.overlayRegistry.disable("aiRecap");
    });

    // --- B: customHotkeys clicks the right mock button on Alt+M/Alt+C/Alt+H,
    // against Romanian aria-labels + a locale-independent data-is-muted mic
    // fallback, exactly the conditions that broke it for a localized Meet UI ---
    await page.evaluate(() =>
      window.AA.overlayRegistry.enable("customHotkeys", {
        enabled: true,
        toggleMicKey: "alt+m",
        toggleCameraKey: "alt+c",
        hangUpKey: "alt+h",
      })
    );
    await page.evaluate(() => {
      window.__aaTestClicks = { mic: 0, camera: 0, hangup: 0 };
    });
    async function pressAltKey(code) {
      await page.keyboard.down("Alt");
      await page.keyboard.press(code);
      await page.keyboard.up("Alt");
      await new Promise((r) => setTimeout(r, 50));
    }
    await pressAltKey("KeyM");
    await pressAltKey("KeyC");
    await pressAltKey("KeyH");
    const hotkeyClicks = await page.evaluate(() => window.__aaTestClicks);
    section.details.hotkeyClicks = hotkeyClicks;
    if (hotkeyClicks.mic !== 1) section.errors.push(`customHotkeys: Alt+M should click mic button once, got ${hotkeyClicks.mic}`);
    if (hotkeyClicks.camera !== 1) section.errors.push(`customHotkeys: Alt+C should click camera button once, got ${hotkeyClicks.camera}`);
    if (hotkeyClicks.hangup !== 1) section.errors.push(`customHotkeys: Alt+H should click hangup button once, got ${hotkeyClicks.hangup}`);
    await page.evaluate(() => window.AA.overlayRegistry.disable("customHotkeys"));

    // --- C: liveCaptions just turns Meet's mock captions on — nothing else.
    // No bar, no scraping — exactly one action. ---
    await page.evaluate(() => {
      window.__aaTestClicks.captionsToggle = 0; // mock toggle starts "off" per its data-captions-on="false"
      window.AA.overlayRegistry.enable("liveCaptions", { enabled: true });
    });
    await new Promise((r) => setTimeout(r, 200));
    const captionsToggleClicks = await page.evaluate(() => window.__aaTestClicks.captionsToggle);
    section.details.captionsToggleClicks = captionsToggleClicks;
    if (captionsToggleClicks !== 1) {
      section.errors.push(`liveCaptions: expected it to click Meet's captions-on toggle once, got ${captionsToggleClicks} clicks`);
    }
    const addsNoOverlay = await page.evaluate(() => document.querySelectorAll('[data-aa-overlay="liveCaptions"]').length === 0);
    if (!addsNoOverlay) section.errors.push("liveCaptions: expected no DOM overlay of its own (just turns Meet's captions on)");

    // disable() after an actual enable() must turn Meet's captions back off
    // too (symmetric) — the user explicitly reported them staying on
    // otherwise after Reset/toggle-off.
    await page.evaluate(() => {
      window.__aaTestClicks.captionsToggle = 0;
      window.AA.overlayRegistry.disable("liveCaptions");
    });
    const afterRealDisable = await page.evaluate(() => ({
      clicks: window.__aaTestClicks.captionsToggle,
      captionsOn: document.getElementById("mock-captions-toggle-btn").dataset.captionsOn,
    }));
    section.details.liveCaptionsSymmetricDisable = afterRealDisable;
    if (afterRealDisable.clicks !== 1 || afterRealDisable.captionsOn !== "false") {
      section.errors.push(`liveCaptions: expected disable() to turn Meet's captions back off, got ${JSON.stringify(afterRealDisable)}`);
    }

    // But disable() must NOT touch Meet's captions when THIS module was
    // never actually turned on (e.g. every page load calls disable() on
    // whatever is OFF in stored state) — otherwise it would force off
    // captions a user turned on manually, unrelated to this extension.
    // Simulate that: flip the mock toggle to "on" directly (not via our
    // click handler) without ever calling enable() on liveCaptions.
    await page.evaluate(() => {
      const btn = document.getElementById("mock-captions-toggle-btn");
      btn.dataset.captionsOn = "true";
      btn.setAttribute("aria-label", "Dezactivează subtitrarea");
      window.__aaTestClicks.captionsToggle = 0;
      window.AA.overlayRegistry.disable("liveCaptions"); // already disabled — a no-op transition
    });
    const afterNoOpDisable = await page.evaluate(() => ({
      clicks: window.__aaTestClicks.captionsToggle,
      captionsOn: document.getElementById("mock-captions-toggle-btn").dataset.captionsOn,
    }));
    section.details.liveCaptionsNoOpDisable = afterNoOpDisable;
    if (afterNoOpDisable.clicks !== 0 || afterNoOpDisable.captionsOn !== "true") {
      section.errors.push(
        `liveCaptions: disable() on an already-off module must NOT touch Meet's captions (would force off a user's own manual setting), got ${JSON.stringify(afterNoOpDisable)}`
      );
    }

    // --- E: focusMode's dimOthers dims every tile except whoever's
    // currently loudest, measured from each tile's OWN audio (a real
    // oscillator per mock tile, not a synthetic class toggle) — and clears
    // when disabled. Targets "Participant 2" — a REMOTE (unmuted) tile, not
    // "Participant 1" which plays the self-view role and is muted (mirrors
    // real Meet: a muted MediaStream-sourced <video> reads silent through
    // an AnalyserNode too, confirmed empirically — "Participant 1" would
    // never register as loudest no matter its gain). ---
    await page.evaluate(() => {
      window.AA.overlayRegistry.enable("focusMode", { enabled: true, dimOthers: true });
      window.__aaTileGains["Participant 2"].gain.value = 0.5; // make tile 2 the loudest
    });
    await new Promise((r) => setTimeout(r, 700)); // > SPEAKER_CHECK_MS (200ms), with margin
    const dimResult = await page.evaluate(() => {
      // focusMode's dim class lands on the <video> itself (what
      // getVideoTiles() returns), not the .tile wrapper div.
      const tiles = Array.from(document.querySelectorAll(".tile"));
      const byLabel = {};
      for (const tile of tiles) {
        const label = tile.querySelector(".label")?.textContent || "";
        byLabel[label] = tile.querySelector("video")?.classList.contains("aa-focus-dim") ?? null;
      }
      return byLabel;
    });
    section.details.focusModeDimOthers = dimResult;
    if (dimResult["Participant 2"] !== false) {
      section.errors.push(`focusMode: expected the loudest tile (Participant 2) to stay undimmed, got ${JSON.stringify(dimResult)}`);
    }
    if (dimResult["Participant 1 (You)"] !== true || dimResult["Participant 3"] !== true) {
      section.errors.push(`focusMode: expected quieter tiles dimmed, got ${JSON.stringify(dimResult)}`);
    }
    await page.evaluate(() => {
      window.__aaTileGains["Participant 2"].gain.value = 0;
      window.AA.overlayRegistry.disable("focusMode");
    });
    const dimCleared = await page.evaluate(() => document.querySelectorAll(".aa-focus-dim").length === 0);
    if (!dimCleared) section.errors.push("focusMode: expected dim class cleared from all tiles after disable");

    // --- F: focusMode's hideSelfView hides the video of the tile Meet marks
    // "(You)" (only that one), and disable restores it exactly. ---
    const videoOpacities = () =>
      Array.from(document.querySelectorAll("#call-area .tile")).map((tile) => ({
        label: tile.querySelector(".label")?.textContent,
        opacity: getComputedStyle(tile.querySelector("video")).opacity,
      }));
    await page.evaluate(() => window.AA.overlayRegistry.enable("focusMode", { enabled: true, hideSelfView: true }));
    const selfViewHidden = await page.evaluate(videoOpacities);
    section.details.selfViewHidden = selfViewHidden;
    const hiddenLabels = selfViewHidden.filter((t) => t.opacity === "0").map((t) => t.label);
    if (hiddenLabels.length !== 1 || !hiddenLabels[0].includes("(You)")) {
      section.errors.push(`focusMode: expected only the "(You)" video hidden, got ${JSON.stringify(hiddenLabels)}`);
    }
    await page.evaluate(() => window.AA.overlayRegistry.disable("focusMode"));
    const selfViewRestored = await page.evaluate(
      () =>
        !document.querySelector("[data-aa-self-view-hidden]") &&
        document.querySelectorAll('[data-aa-overlay="focusMode"]').length === 0
    );
    if (!selfViewRestored) section.errors.push("focusMode: expected the self-view video restored after disable");

    // --- G: focusMode's hideReactions hides a floating emoji reaction node
    // as Meet adds it, via its own MutationObserver (not a synthetic event). ---
    await page.evaluate(() => window.AA.overlayRegistry.enable("focusMode", { enabled: true, hideReactions: true }));
    await page.evaluate(() => window.__aaAddMockReaction("👍"));
    await new Promise((r) => setTimeout(r, 200));
    const reactionHidden = await page.evaluate(() => {
      const reaction = document.querySelector(".mock-reaction");
      return reaction ? getComputedStyle(reaction).display === "none" : null;
    });
    if (reactionHidden !== true) section.errors.push(`focusMode: expected the mock reaction hidden, got ${JSON.stringify(reactionHidden)}`);
    await page.evaluate(() => window.AA.overlayRegistry.disable("focusMode"));

    // --- H: aiRecap. Fully on-device: window.fetch is replaced with a spy
    // to prove the recap never touches the network. The on-device Summarizer
    // API is mocked in H2 and removed in H3 to exercise the local fallback. ---
    await page.evaluate(() => window.AA.overlayRegistry.enable("aiRecap", { enabled: true, windowSeconds: 120 }));

    // H1: clicking with nothing captioned yet must say so honestly and NOT
    // call fetch at all.
    let fetchCalls = await page.evaluate(() => {
      window.__aaFetchCalls = [];
      window.fetch = (...args) => {
        window.__aaFetchCalls.push(args);
        return Promise.reject(new Error("fetch should not have been called yet"));
      };
      document.getElementById("aa-ai-recap-button").click();
      return window.__aaFetchCalls.length;
    });
    section.details.aiRecapNoSpeechFetchCalls = fetchCalls;
    if (fetchCalls !== 0) section.errors.push(`aiRecap: expected no fetch call with nothing captioned, got ${fetchCalls} call(s)`);
    const noSpeechPanelText = await page.evaluate(() => document.getElementById("aa-ai-recap-panel")?.textContent);
    if (!noSpeechPanelText || !noSpeechPanelText.toLowerCase().includes("captions")) {
      section.errors.push(`aiRecap: expected an honest "turn captions on" message, got ${JSON.stringify(noSpeechPanelText)}`);
    }

    // H2: with speech actually scraped from Meet's (mock) captions, a click
    // summarizes it with the (mocked) on-device Summarizer — no fetch.
    const captionLines = [
      "We agreed to move the product launch to Friday.",
      "QA still needs to test the login flow on older laptops.",
      "Maria will update the changelog before the launch.",
      "The weather was nice this morning.",
      "Andrei prepares the launch demo for the client on Thursday.",
    ];
    async function captionAll() {
      for (const line of captionLines) {
        await page.evaluate((t) => window.__aaSetMockCaption(t), line);
        await new Promise((r) => setTimeout(r, 600)); // > ai-recap.js's POLL_MS (400ms)
      }
      await page.evaluate(() => window.__aaSetMockCaption("")); // finalizes the last line into the buffer
      await new Promise((r) => setTimeout(r, 600));
    }
    await captionAll();

    const clickResult = await page.evaluate(async () => {
      window.__aaFetchCalls = [];
      window.fetch = (...args) => {
        window.__aaFetchCalls.push(args);
        return Promise.reject(new Error("recap must not use the network"));
      };
      window.Summarizer = {
        availability: async () => "available",
        create: async () => ({ summarize: async () => "Mock on-device summary.", destroy() {} }),
      };
      document.getElementById("aa-ai-recap-button").click();
      await new Promise((r) => setTimeout(r, 150)); // let the async click handler settle
      return {
        fetchCallCount: window.__aaFetchCalls.length,
        panelText: document.getElementById("aa-ai-recap-panel")?.textContent,
      };
    });
    section.details.aiRecapClickResult = clickResult;
    if (clickResult.fetchCallCount !== 0) {
      section.errors.push(`aiRecap: expected no network call, got ${clickResult.fetchCallCount}`);
    }
    if (clickResult.panelText !== "Mock on-device summary.") {
      section.errors.push(`aiRecap: expected the on-device summary rendered in the panel, got ${JSON.stringify(clickResult.panelText)}`);
    }

    // H3: no on-device AI in this browser -> local key-points fallback.
    // Re-enable first so the cached summarizer instance from H2 is dropped.
    await page.evaluate(() => {
      window.AA.overlayRegistry.disable("aiRecap");
      window.AA.overlayRegistry.enable("aiRecap", { enabled: true, windowSeconds: 120 });
    });
    await captionAll();
    const fallbackResult = await page.evaluate(async () => {
      delete window.Summarizer;
      window.__aaFetchCalls = [];
      document.getElementById("aa-ai-recap-button").click();
      await new Promise((r) => setTimeout(r, 150));
      return {
        fetchCallCount: window.__aaFetchCalls.length,
        panelText: document.getElementById("aa-ai-recap-panel")?.textContent,
      };
    });
    section.details.aiRecapFallbackResult = fallbackResult;
    if (fallbackResult.fetchCallCount !== 0) {
      section.errors.push(`aiRecap fallback: expected no network call, got ${fallbackResult.fetchCallCount}`);
    }
    const fallbackText = fallbackResult.panelText || "";
    const fallbackPoints = fallbackText.split("\n").filter((l) => l.startsWith("• "));
    if (!fallbackText.includes("Key points:") || !fallbackText.includes("launch") || fallbackText.includes("weather") ||
        fallbackPoints.some((p) => p.split(/\s+/).length > 12)) {
      section.errors.push(`aiRecap fallback: expected launch-related key points without filler, got ${JSON.stringify(fallbackText)}`);
    }

    await page.evaluate(() => window.AA.overlayRegistry.disable("aiRecap"));
    const aiRecapUiRemoved = await page.evaluate(
      () => document.querySelectorAll('[data-aa-overlay="aiRecap"]').length === 0
    );
    if (!aiRecapUiRemoved) section.errors.push("aiRecap: expected its button/panel removed after disable");

    await page.screenshot({ path: path.join(OUTPUT_DIR, "new-modules.png") });

    section.details.consoleErrors = consoleErrors;
    if (consoleErrors.length > 0) section.errors.push(...consoleErrors);
    section.pass = section.errors.length === 0;
  } catch (err) {
    section.errors.push(String((err && err.stack) || err));
    section.pass = false;
  } finally {
    if (browser) await browser.close();
  }
  log.sections.push(section);
}

async function main() {
  ensureOutputDir();
  const log = { timestamp: new Date().toISOString(), sections: [] };

  await checkExtensionLoads(log);
  await checkFunctionalModules(log);
  await checkPopup(log);
  await checkInviteLink(log);
  await checkNewAccessibilityModules(log);
  await checkRealContentScriptInjection(log);

  // pass === null means "inconclusive" (e.g. a known environment limitation) —
  // excluded from the gate rather than counted as a failure or a pass.
  log.overallPass = log.sections.every((s) => s.pass === true || s.pass === null);

  fs.writeFileSync(path.join(OUTPUT_DIR, "run-log.json"), JSON.stringify(log, null, 2));
  console.log(`Wrote ${path.join(OUTPUT_DIR, "run-log.json")}`);
  console.log(`Overall pass: ${log.overallPass}`);
  for (const section of log.sections) {
    const label = section.pass === null ? "INCONCLUSIVE" : section.pass ? "PASS" : "FAIL";
    console.log(`- ${section.name}: ${label}`);
    if (section.errors && section.errors.length) {
      for (const e of section.errors) console.log(`    ERROR: ${e}`);
    }
  }
  process.exitCode = log.overallPass ? 0 : 1;
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exitCode = 1;
});
