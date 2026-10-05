// ==UserScript==
// @name         PiP Gestures
// @description  Two-finger move and pinch-to-resize for Picture-in-Picture windows (Zen / Firefox, macOS trackpad)
// @include      main
// ==/UserScript==

(function () {
  "use strict";

  // Several browser windows may load this script; only the first one needs to watch.
  // (Each PiP window is also guarded individually below.)
  const PIP_URL = /pictureinpicture\/player\.xhtml/;
  
  // Optional about:config prefs (all are created on demand, none are required):
  //   zen.pipgestures.debug          (bool, default false)  -> logs to Browser Console (Cmd+Shift+J)
  //   zen.pipgestures.pinchSpeed     (int %, default 100)   -> pinch-to-resize sensitivity
  //   zen.pipgestures.panSpeed       (int %, default 100)   -> two-finger window-move sensitivity
  const P = Services.prefs;
  const debugOn = () => P.getBoolPref("zen.pipgestures.debug", false);
  const pinchSpeed = () => P.getIntPref("zen.pipgestures.pinchSpeed", 100) / 100;
  const panSpeed = () => P.getIntPref("zen.pipgestures.panSpeed", 100) / 100;

  let logCount = 0;
  const LOG_FILE = (() => {
    try {
      return PathUtils.join(Services.dirsvc.get("Desk", Ci.nsIFile).path, "PiP_Gestures_log.txt");
    } catch (e) {
      return null;
    }
  })();

  // force = true logs even when the debug pref is off (used for the startup line)
  function log(msg, force) {
    if (!force && !debugOn()) return;
    if (++logCount > 3000) return; // keep it readable
    const line = "[PiP Gestures] " + msg;
    try { console.log(line); } catch (e) {}
    try { Services.console.logStringMessage(line); } catch (e) {}
    if (LOG_FILE) {
      try {
        IOUtils.writeUTF8(LOG_FILE, new Date().toISOString() + " " + line + "\n", {
          mode: "appendOrCreate",
        });
      } catch (e) {}
    }
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function isPipWindow(win) {
    try {
      return PIP_URL.test(win.location.href);
    } catch (e) {
      return false;
    }
  }

  function attach(win) {
    if (win.__pipGesturesAttached) return;

    const doc = win.document;
    const view = doc.getElementById("browser") || doc.querySelector("browser");
    if (!view) {
      // DOM may not be parsed yet; don't mark as attached so a later call can retry.
      log("PiP window found, but could not find the video element (readyState=" + doc.readyState + ").", true);
      return;
    }
    win.__pipGesturesAttached = true;
    log("Attached to a PiP window. Video element: <" + view.localName + "#" + view.id + ">", true);

    // The gestures move/resize the PiP *window* itself:
    //   two-finger scroll -> move the window
    //   pinch (arrives as ctrl+wheel) -> resize the window, keeping its aspect ratio
    // Window moves/resizes apply asynchronously, so we track our own target geometry
    // across a burst of events and only re-read the real geometry after a short idle gap.
    const IDLE_MS = 250;
    const MIN_W = 200;
    const g = { x: 0, y: 0, w: 0, h: 0, aspect: 1, t: 0 };

    function sync() {
      const now = Date.now();
      if (now - g.t > IDLE_MS || !g.w) {
        g.x = win.screenX;
        g.y = win.screenY;
        g.w = win.outerWidth;
        g.h = win.outerHeight;
        g.aspect = g.w / g.h || 16 / 9;
      }
      g.t = now;
    }

    // Keep at least part of the window reachable on screen.
    function keepOnScreen() {
      const sc = win.screen;
      const left = sc.availLeft || 0;
      const top = sc.availTop || 0;
      const margin = 60;
      g.x = clamp(g.x, left - g.w + margin, left + sc.availWidth - margin);
      g.y = clamp(g.y, top, top + sc.availHeight - margin);
    }

    // The OS delivers scroll events to whichever window is under the cursor, so once the
    // window slides out from under the pointer the gesture would stop. Like Arc, we hide the
    // cursor while gesturing and carry it along with the window, keeping it at the same spot
    // relative to the window (so there's no visible jump when a gesture starts). When the
    // gesture ends the cursor reappears at the window's centre.
    const wu = win.windowUtils;
    log("scales: devicePixelRatio=" + win.devicePixelRatio + " screenPixelsPerCSSPixel=" + wu.screenPixelsPerCSSPixel, true);
    let warpFailed = false;
    let newSignature = true; // sendNativeMouseEvent(x, y, msg, button, modifiers, element, observer)
    // (cx, cy) is the point to put the cursor at, in screen CSS pixels.
    // sendNativeMouseEvent wants *device* pixels. screenPixelsPerCSSPixel is 1 on a Retina Mac
    // (it counts OS points), which put the cursor at half the intended coordinates; the window's
    // devicePixelRatio is the device-pixels-per-CSS-pixel we actually need.
    let lastWarp = null;
    function warpCursor(cx, cy) {
      try {
        const scale = win.devicePixelRatio || 1;
        lastWarp = [Math.round(cx), Math.round(cy)];
        const x = cx * scale;
        const y = cy * scale;
        const el = doc.documentElement;
        const MOVE = Ci.nsIDOMWindowUtils.NATIVE_MOUSE_MESSAGE_MOVE;
        if (newSignature) {
          try {
            wu.sendNativeMouseEvent(x, y, MOVE, 0, 0, el, null);
            return;
          } catch (e) {
            newSignature = false; // older Firefox without the button argument
          }
        }
        wu.sendNativeMouseEvent(x, y, MOVE, 0, el, null);
      } catch (e) {
        if (!warpFailed) {
          warpFailed = true;
          log("could not move the cursor: " + e, true);
        }
      }
    }

    const actualCentre = () => [win.screenX + win.outerWidth / 2, win.screenY + win.outerHeight / 2];

    // Hide the cursor everywhere in the window. A plain `cursor: none` on the root isn't enough
    // because elements under the pointer (the controls overlay) set their own cursor.
    let hideStyle = null;
    function hideCursor() {
      view.style.pointerEvents = "none"; // let the chrome document, not the video process, pick the cursor
      doc.documentElement.style.cursor = "none";
      if (!hideStyle) {
        hideStyle = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
        hideStyle.textContent = "* { cursor: none !important; }";
        (doc.head || doc.documentElement).appendChild(hideStyle);
      }
    }
    function showCursor() {
      view.style.pointerEvents = "";
      doc.documentElement.style.cursor = "";
      if (hideStyle) {
        hideStyle.remove();
        hideStyle = null;
      }
    }

    let gesturing = false;
    let idleTimer = null;
    let evN = 0;
    // Where the cursor sits inside the window, as a fraction of its size.
    let curFx = 0.5;
    let curFy = 0.5;

    function endGesture() {
      gesturing = false;
      idleTimer = null;
      // The window has settled by now; park the (still hidden) cursor at the centre of where it
      // ended up, then reveal it a moment later so the jump itself is never seen.
      const a = actualCentre();
      log("gesture end after " + evN + " events; target=(" + Math.round(g.x) + "," + Math.round(g.y) + " " +
        Math.round(g.w) + "x" + Math.round(g.h) + ") actual=(" + win.screenX + "," + win.screenY + " " +
        win.outerWidth + "x" + win.outerHeight + ")");
      warpCursor(a[0], a[1]);
      win.setTimeout(() => { if (!gesturing) showCursor(); }, 80);
    }

    function touchGesture(e) {
      if (!gesturing) {
        gesturing = true;
        evN = 0;
        // Remember where the cursor is within the window; it keeps that spot as the window moves.
        const fx = (e.screenX - win.screenX) / (win.outerWidth || 1);
        const fy = (e.screenY - win.screenY) / (win.outerHeight || 1);
        curFx = Number.isFinite(fx) ? clamp(fx, 0.05, 0.95) : 0.5;
        curFy = Number.isFinite(fy) ? clamp(fy, 0.05, 0.95) : 0.5;
        log("gesture start; cursor at " + curFx.toFixed(2) + "," + curFy.toFixed(2) + " of the window");
        hideCursor();
      }
      if (idleTimer) win.clearTimeout(idleTimer);
      idleTimer = win.setTimeout(endGesture, 200);
    }

    function commit(resized) {
      keepOnScreen();
      try {
        if (resized) win.resizeTo(Math.round(g.w), Math.round(g.h));
        win.moveTo(Math.round(g.x), Math.round(g.y));
      } catch (e) {
        log("move/resize failed: " + e, true);
      }
      // Carry the cursor along with the window so it stays under the pointer's original spot.
      if (gesturing) warpCursor(g.x + curFx * g.w, g.y + curFy * g.h);
    }

    // Resize by `factor` around the window's centre.
    function resizeBy(factor) {
      sync();
      const maxW = win.screen.availWidth;
      const newW = clamp(g.w * factor, MIN_W, maxW);
      const newH = newW / g.aspect;
      g.x -= (newW - g.w) / 2;
      g.y -= (newH - g.h) / 2;
      g.w = newW;
      g.h = newH;
      commit(true);
    }

    function moveBy(dx, dy) {
      sync();
      g.x += dx;
      g.y += dy;
      commit(false);
    }

    // Dead zone: a lone 1px twitch (resting fingers, trackpad noise) shouldn't hijack the cursor or
    // nudge the window. A gesture starts once ~4px of movement accumulates within a short window.
    const START_DISTANCE = 4;
    const START_WINDOW_MS = 150;
    let pending = 0;
    let pendingT = 0;
    function shouldStart(e) {
      if (gesturing) return true;
      const now = Date.now();
      if (now - pendingT > START_WINDOW_MS) pending = 0;
      pendingT = now;
      pending += Math.abs(e.deltaX) + Math.abs(e.deltaY);
      return pending >= START_DISTANCE;
    }

    // Log the first events of every gesture, then every 10th, so long gestures stay readable.
    function logEvent(e) {
      evN++;
      if (evN > 25 && evN % 10) return;
      log("#" + evN + " " + (e.ctrlKey ? "pinch" : "move") + " dx=" + e.deltaX + " dy=" + e.deltaY +
        " target=(" + Math.round(g.x) + "," + Math.round(g.y) + " " + Math.round(g.w) + "x" + Math.round(g.h) +
        ") actual=(" + win.screenX + "," + win.screenY + ")" +
        " cursor=(" + e.screenX + "," + e.screenY + ")" +
        (lastWarp ? " lastAskedCursor=(" + lastWarp[0] + "," + lastWarp[1] + ")" : ""));
    }

    doc.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!shouldStart(e)) return;
        touchGesture(e);
        if (e.ctrlKey) {
          // Pinch out -> negative deltaY -> bigger window.
          resizeBy(Math.exp(-e.deltaY * 0.005 * pinchSpeed()));
          logEvent(e);
          return;
        }
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? win.innerHeight : 1;
        const sp = panSpeed();
        // Window follows the fingers (natural scrolling reports the opposite sign).
        moveBy(-e.deltaX * unit * sp, -e.deltaY * unit * sp);
        logEvent(e);
      },
      { capture: true, passive: false }
    );
  }

  function consider(win) {
    if (!win || !win.document) return;
    let href = "?";
    try { href = win.location.href; } catch (e) {}
    log("window opened: " + href + " (readyState=" + win.document.readyState + ")", true);

    // Only attach once the DOM is fully loaded; at open time the <browser> may not exist yet.
    if (isPipWindow(win) && win.document.readyState === "complete") {
      attach(win);
      return;
    }
    // Not loaded yet (or still the initial about:blank): check again on load.
    // Not { once: true } so a stray early load event can't consume the listener.
    const onLoad = () => {
      if (!isPipWindow(win)) return;
      win.removeEventListener("load", onLoad);
      attach(win);
    };
    win.addEventListener("load", onLoad);
  }

  const listener = {
    onOpenWindow(appWindow) {
      try {
        consider(appWindow.docShell.domWindow);
      } catch (e) {
        log("onOpenWindow error: " + e);
      }
    },
    onCloseWindow() {},
  };

  // Catch PiP windows that open later...
  Services.wm.addListener(listener);
  window.addEventListener(
    "unload",
    () => {
      try {
        Services.wm.removeListener(listener);
      } catch (e) {}
    },
    { once: true }
  );

  // ...and any that are already open.
  for (const w of Services.wm.getEnumerator(null)) consider(w);

  try {
    P.setCharPref("zen.pipgestures.loaded", new Date().toISOString());
  } catch (e) {}
  log("PiP Gestures v0.3.4 loaded. Debug is " + (debugOn() ? "ON" : "OFF"), true);
})();
