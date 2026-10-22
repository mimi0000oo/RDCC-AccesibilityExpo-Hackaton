/**
 * content/main-world/media-guard.js
 * Runs in Meet's own JavaScript world ("world": "MAIN" in manifest.json),
 * unlike every other content script here, which run in Chrome's isolated
 * extension world and so can't affect calls Meet's code makes.
 *
 * One job: when pause-videos.js pauses a <video> it marks it with
 * data-aa-paused; Meet calls play() on its videos whenever they stop, which
 * would undo the pause immediately. This makes play() a no-op for marked
 * videos only. Every other <video>, and every other media call, is untouched.
 * The DOM attribute is the only link between the two worlds.
 */
(function () {
  "use strict";

  const PAUSED_ATTR = "data-aa-paused";
  const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  if (!proto || proto.__aaMediaGuard) return;

  const originalPlay = proto.play;
  Object.defineProperty(proto, "__aaMediaGuard", { value: true });
  proto.play = function play() {
    if (this.hasAttribute && this.hasAttribute(PAUSED_ATTR)) return Promise.resolve();
    return originalPlay.apply(this, arguments);
  };
})();
