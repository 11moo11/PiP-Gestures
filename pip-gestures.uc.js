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
  //   zen.pipgestures.holdMs         (int ms, default 600)  -> how long fingers can rest still mid-move
  //                                                            before the cursor comes back
  const P = Services.prefs;
  const debugOn = () => P.getBoolPref("zen.pipgestures.debug", false);
  const pinchSpeed = () => P.getIntPref("zen.pipgestures.pinchSpeed", 100) / 100;
  const panSpeed = () => P.getIntPref("zen.pipgestures.panSpeed", 100) / 100;
  const holdMs = () => P.getIntPref("zen.pipgestures.holdMs", 600);

  // With a single monitor the PiP window is kept fully on screen; with several we let it roam.
  const screenMgr = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager);
  const isSingleScreen = () => {
    try {
      return screenMgr.numberOfScreens <= 1;
    } catch (e) {
      return true;
    }
  };

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

    function keepOnScreen() {
      const sc = win.screen;
      const left = sc.availLeft || 0;
      const top = sc.availTop || 0;
      if (isSingleScreen()) {
        // Active repel: the window can't cross any screen edge (menu bar and Dock excluded),
        // and a window that is already out of bounds is pulled back in on the next gesture.
        g.x = clamp(g.x, left, Math.max(left, left + sc.availWidth - Math.ceil(g.w)));
        g.y = clamp(g.y, top, Math.max(top, top + sc.availHeight - Math.ceil(g.h)));
      } else {
        // Several monitors: let it travel between them, but keep part of it reachable.
        const margin = 60;
        g.x = clamp(g.x, left - g.w + margin, left + sc.availWidth - margin);
        g.y = clamp(g.y, top, top + sc.availHeight - margin);
      }
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
    const warpHistory = []; // recent cursor positions we asked for (our own moves echo back as mousemoves)
    function warpCursor(cx, cy) {
      try {
        const scale = win.devicePixelRatio || 1;
        lastWarp = [Math.round(cx), Math.round(cy)];
        warpHistory.push(lastWarp);
        if (warpHistory.length > 16) warpHistory.shift();
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
    let fading = false; // fingers are up and the momentum is fading out
    let idleTimer = null;
    let evN = 0;
    // Where the cursor sits inside the window, as a fraction of its size.
    let curFx = 0.5;
    let curFy = 0.5;

    function endGesture(reason, userTookOver) {
      if (!gesturing) return;
      gesturing = false;
      if (idleTimer) win.clearTimeout(idleTimer);
      idleTimer = null;
      recent.length = 0;
      fading = false;
      // The window has settled by now; park the (still hidden) cursor at the centre of where it
      // ended up, then reveal it a moment later so the jump itself is never seen.
      const a = actualCentre();
      log("gesture end (" + (typeof reason === "string" ? reason : "idle") + ") after " + evN + " events; target=(" + Math.round(g.x) + "," + Math.round(g.y) + " " +
        Math.round(g.w) + "x" + Math.round(g.h) + ") actual=(" + win.screenX + "," + win.screenY + " " +
        win.outerWidth + "x" + win.outerHeight + ")");
      if (userTookOver) {
        // They're already steering the cursor themselves: just give it back, don't move it.
        showCursor();
        return;
      }
      warpCursor(a[0], a[1]);
      // Just long enough for the cursor to land before it's revealed.
      win.setTimeout(() => { if (!gesturing) showCursor(); }, 30);
    }

    function touchGesture(e, isPinch) {
      if (!gesturing) {
        gesturing = true;
        evN = 0;
        // Remember where the cursor is within the window; it keeps that spot as the window moves.
        const fx = (e.screenX - win.screenX) / (win.outerWidth || 1);
        const fy = (e.screenY - win.screenY) / (win.outerHeight || 1);
        curFx = Number.isFinite(fx) ? clamp(fx, 0.05, 0.95) : 0.5;
        curFy = Number.isFinite(fy) ? clamp(fy, 0.05, 0.95) : 0.5;
        warpHistory.push([Math.round(e.screenX), Math.round(e.screenY)]); // where the cursor really is now
        log("gesture start; cursor at " + curFx.toFixed(2) + "," + curFy.toFixed(2) + " of the window");
        hideCursor();
      }
      if (idleTimer) win.clearTimeout(idleTimer);
      // A trackpad sends nothing while fingers rest, so "paused" and "lifted" look the same here.
      // Pauses get a generous grace period for moves; lifts with momentum are caught separately.
      // While momentum is fading, any gap means the coast is over; otherwise allow for resting fingers.
      idleTimer = win.setTimeout(endGesture, fading ? 150 : isPinch ? 250 : holdMs());
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
      const sc = win.screen;
      // On a single screen the window must also fit vertically.
      const maxW = isSingleScreen() ? Math.min(sc.availWidth, sc.availHeight * g.aspect) : sc.availWidth;
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

    // Momentum: after the fingers lift, macOS keeps sending wheel events whose size fades out
    // smoothly, and we let the window coast on them. We only use the fade to know the fingers are
    // up, so that the gesture can end as soon as the coasting stops instead of waiting out the
    // longer "fingers are just resting" grace period.
    const recent = []; // magnitudes of the latest events in this gesture
    function looksLikeMomentum() {
      const n = 8;
      if (recent.length < n) return false;
      const r = recent.slice(-n);
      let drops = 0;
      for (let i = 1; i < n; i++) {
        if (r[i] > r[i - 1]) return false;
        if (r[i] < r[i - 1]) drops++;
      }
      const ratio = r[n - 1] / r[0];
      return r[0] >= 12 && drops >= 5 && ratio >= 0.6 && ratio <= 0.97;
    }

    // If the user grabs the cursor (one-finger movement) mid-gesture or while the window is still
    // coasting, the cursor is theirs: show it where it is and never warp it back to the window.
    let takeover = false;
    let takeoverTimer = null;
    function isOurMove(e) {
      return warpHistory.some((w) => Math.abs(e.screenX - w[0]) <= 4 && Math.abs(e.screenY - w[1]) <= 4);
    }
    let lastWheelT = 0;
    function onRealMouseMove(e) {
      if (!gesturing && !fading) return;
      // While two fingers are actively scrolling the cursor can't be steered, and the window
      // sliding under it makes Gecko fire synthetic mouse moves; only trust moves that arrive
      // once the wheel stream has paused, or while the window is coasting.
      if (!fading && Date.now() - lastWheelT < 60) return;
      if (isOurMove(e)) return;
      log("mouse moved by the user at (" + e.screenX + "," + e.screenY + "); giving the cursor back");
      takeover = true;
      endGesture("mouse moved", true);
      if (takeoverTimer) win.clearTimeout(takeoverTimer);
      takeoverTimer = win.setTimeout(() => { takeover = false; }, 200);
    }
    doc.addEventListener("mousemove", onRealMouseMove, true);
    // The cursor may be over the main window when the user moves it with one finger.
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      w.addEventListener("mousemove", onRealMouseMove, true);
      win.addEventListener("unload", () => { try { w.removeEventListener("mousemove", onRealMouseMove, true); } catch (e) {} }, { once: true });
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
        const mag = e.ctrlKey ? Math.abs(e.deltaY) : Math.hypot(e.deltaX, e.deltaY);
        lastWheelT = Date.now();
        if (takeover) {
          // Keep coasting, but leave the cursor alone.
          if (takeoverTimer) win.clearTimeout(takeoverTimer);
          takeoverTimer = win.setTimeout(() => { takeover = false; }, 200);
        } else {
          if (!shouldStart(e)) return;
          touchGesture(e, e.ctrlKey);
          // A jump in size means a fresh touch rather than a fading coast.
          if (fading && recent.length && mag > recent[recent.length - 1] * 1.25 + 2) fading = false;
          recent.push(mag);
          if (recent.length > 8) recent.shift();
          if (!fading && looksLikeMomentum()) {
            fading = true;
            log("fingers lifted (momentum fade detected); letting the window coast");
            touchGesture(e, e.ctrlKey); // re-arm the idle timer with the shorter coasting grace period
          }
        }
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
  log("PiP Gestures v0.3.6 loaded. Debug is " + (debugOn() ? "ON" : "OFF"), true);
})();
