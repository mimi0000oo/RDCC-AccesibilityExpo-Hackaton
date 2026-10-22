/**
 * utils/invite-link.js
 * Lets a recruiter share a Google Meet link with an accessibility profile
 * baked in, so a candidate joining doesn't have to configure anything
 * themselves. Fully local (ARCHITECTURE.md §2/§8): the preset lives entirely
 * in the URL FRAGMENT (`#aa=...`), which browsers never send to any server
 * (fragments are client-side only, never part of an HTTP request) — no
 * backend, no new network surface, nothing stored remotely. Whoever already
 * has the Meet link already has whatever is in the fragment; this doesn't
 * change who can see what.
 *
 * Only a whitelisted subset of profile keys/fields ever round-trips through
 * here (ALLOWED_FIELDS) — a crafted link can only ever toggle this
 * extension's own presentation-layer overlays (contrast, colorblind filter,
 * inversion, reading ruler, magnifier), never anything else.
 *
 * Both sides use the exact same encode/decode pair so a link only ever
 * produces what this file itself would accept back — see ui/popup/popup.js
 * (encode, recruiter side) and content/content-main.js (decode, candidate
 * side).
 *
 * Public API:
 *   AA.inviteLink.encode(profile) -> string | null     // just the token, no "#aa="
 *   AA.inviteLink.buildUrl(baseUrl, profile) -> string | null
 *   AA.inviteLink.decode(hash) -> partial profile object | null
 */
(function (global) {
  "use strict";

  const AA = (global.AA = global.AA || {});
  const logger = AA.logger ? AA.logger.scope("invite-link") : console;

  const FRAGMENT_KEY = "aa";

  const ALLOWED_FIELDS = {
    contrast: ["enabled", "level", "amount", "saturate"],
    colorblind: ["enabled", "mode", "intensity"],
    inversion: ["enabled", "smart", "invertColors", "brightness"],
    readingRuler: ["enabled", "height", "opacity"],
    magnifier: ["enabled", "zoom", "shape", "size"],
    pauseVideos: ["enabled"],
  };

  function base64UrlEncode(str) {
    const b64 = typeof btoa === "function" ? btoa(str) : Buffer.from(str, "binary").toString("base64");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64UrlDecode(str) {
    const padded = (str.replace(/-/g, "+").replace(/_/g, "/") + "===").slice(0, str.length + ((4 - (str.length % 4)) % 4));
    return typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("binary");
  }

  // Keeps only the whitelisted fields for a key, and only if the module is
  // actually enabled — a link should never ship "enabled: false" noise.
  function sanitizeEntry(key, value) {
    const allowedFields = ALLOWED_FIELDS[key];
    if (!allowedFields || !value || typeof value !== "object") return null;
    const clean = {};
    for (const field of allowedFields) {
      if (field in value) clean[field] = value[field];
    }
    return clean.enabled ? clean : null;
  }

  function encode(profile) {
    try {
      if (!profile || typeof profile !== "object") return null;
      const preset = {};
      for (const key of Object.keys(ALLOWED_FIELDS)) {
        const clean = sanitizeEntry(key, profile[key]);
        if (clean) preset[key] = clean;
      }
      if (Object.keys(preset).length === 0) return null; // nothing enabled, nothing worth sharing
      return base64UrlEncode(JSON.stringify(preset));
    } catch (err) {
      logger.error("encode failed", err);
      return null;
    }
  }

  function buildUrl(baseUrl, profile) {
    const token = encode(profile);
    if (!token) return null;
    try {
      const url = new URL(baseUrl);
      url.hash = `${FRAGMENT_KEY}=${token}`;
      return url.toString();
    } catch (err) {
      logger.error("buildUrl failed: invalid baseUrl", err);
      return null;
    }
  }

  function decode(hash) {
    try {
      if (!hash || typeof hash !== "string") return null;
      const clean = hash.startsWith("#") ? hash.slice(1) : hash;
      const params = new URLSearchParams(clean);
      const token = params.get(FRAGMENT_KEY);
      if (!token) return null;
      const parsed = JSON.parse(base64UrlDecode(token));
      if (!parsed || typeof parsed !== "object") return null;

      const preset = {};
      for (const key of Object.keys(ALLOWED_FIELDS)) {
        const clean = sanitizeEntry(key, parsed[key]);
        if (clean) preset[key] = clean;
      }
      return Object.keys(preset).length > 0 ? preset : null;
    } catch (err) {
      logger.warn("decode failed (malformed or absent invite fragment)", err);
      return null;
    }
  }

  AA.inviteLink = { encode, buildUrl, decode };
})(typeof window !== "undefined" ? window : globalThis);
