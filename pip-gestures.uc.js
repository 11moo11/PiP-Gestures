// ==UserScript==
// @name         PiP Gestures
// @description  Two-finger pan and pinch-to-zoom inside Picture-in-Picture windows (Zen / Firefox, macOS trackpad)
// @include      main
// ==/UserScript==

(function () {
  "use strict";

  // Several browser windows may load this script; only the first one needs to watch.
  // (Each PiP window is also guarded individually below.)
  const PIP_URL = /pictureinpicture\/player\.xhtml/;
  const MAX_ZOOM = 8;

  // Optional about:config prefs (all are created on demand, none are required):
  //   zen.pipgestures.debug          (bool, default false)  -> logs to Browser Console (Cmd+Shift+J)
  //   zen.pipgestures.pinchSpeed     (int %, default 100)   -> pinch sensitivity
  //   zen.pipgestures.panSpeed       (int %, default 100)   -> two-finger pan sensitivity
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
    if (++logCount > 400) return; // keep it readable
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

    view.style.transformOrigin = "0 0";

    // Current view state: screen point = (tx, ty) + scale * original point
    let scale = 1;
    let tx = 0;
    let ty = 0;

    const W = () => doc.documentElement.clientWidth || win.innerWidth;
    const H = () => doc.documentElement.clientHeight || win.innerHeight;

    function clampPan() {
      if (scale <= 1) {
        tx = 0;
        ty = 0;
        return;
      }
      tx = clamp(tx, W() * (1 - scale), 0);
      ty = clamp(ty, H() * (1 - scale), 0);
    }

    function apply() {
      view.style.transform =
        scale === 1 && tx === 0 && ty === 0
          ? ""
          : "translate(" + tx + "px, " + ty + "px) scale(" + scale + ")";
    }

    function reset() {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
    }

    // Zoom while keeping the point under the fingers (fx, fy) fixed.
    function zoomAt(newScale, fx, fy) {
      newScale = clamp(newScale, 1, MAX_ZOOM);
      const k = newScale / scale;
      tx = fx - (fx - tx) * k;
      ty = fy - (fy - ty) * k;
      scale = newScale;
      clampPan();
      apply();
    }

    const focal = (e) => ({
      x: typeof e.clientX === "number" && (e.clientX || e.clientY) ? e.clientX : W() / 2,
      y: typeof e.clientY === "number" && (e.clientX || e.clientY) ? e.clientY : H() / 2,
    });

    // --- Pinch (macOS trackpad) -------------------------------------------
    // Diagnostic: log the first few gesture events of any kind that reach this window.
    let gestureLogs = 0;
    for (const t of ["MozMagnifyGestureStart", "MozMagnifyGestureUpdate", "MozMagnifyGesture",
                     "MozRotateGestureStart", "MozSwipeGestureMayStart", "MozTapGesture"]) {
      win.addEventListener(t, (e) => {
        if (gestureLogs++ < 8) log("gesture event seen: " + t + " delta=" + e.delta, true);
      }, true);
    }
    win.addEventListener(
      "MozMagnifyGestureStart",
      (e) => {
        e.preventDefault();
        log("pinch start");
      },
      true
    );

    win.addEventListener(
      "MozMagnifyGestureUpdate",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const f = focal(e);
        const factor = clamp(1 + (e.delta / 100) * pinchSpeed(), 0.5, 1.5);
        log("pinch delta=" + e.delta + " factor=" + factor.toFixed(3) + " scale=" + scale.toFixed(2));
        zoomAt(scale * factor, f.x, f.y);
      },
      true
    );

    win.addEventListener(
      "MozMagnifyGesture",
      (e) => {
        e.preventDefault();
        // Snap back to normal if the user pinched out to roughly 1x.
        if (scale < 1.04) reset();
        log("pinch end scale=" + scale.toFixed(2));
      },
      true
    );

    // --- Two-finger scroll = pan; ctrl+wheel = pinch fallback --------------
    let wheelLogs = 0;
    doc.addEventListener(
      "wheel",
      (e) => {
        // Diagnostic: confirm wheel events reach us at all (first few only, to keep the log readable).
        if (wheelLogs < 8) {
          wheelLogs++;
          log("wheel seen ctrl=" + e.ctrlKey + " dx=" + e.deltaX + " dy=" + e.deltaY +
            " mode=" + e.deltaMode + " scale=" + scale.toFixed(2) + " target=<" + (e.target && e.target.localName) + ">", true);
        }
        if (e.ctrlKey) {
          // Some setups deliver pinch as ctrl+wheel.
          e.preventDefault();
          e.stopPropagation();
          const f = focal(e);
          log("ctrl+wheel deltaY=" + e.deltaY);
          zoomAt(scale * Math.exp(-e.deltaY * 0.01 * pinchSpeed()), f.x, f.y);
          return;
        }
        if (scale <= 1) return; // nothing to pan; leave default behavior alone
        e.preventDefault();
        e.stopPropagation();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H() : 1;
        const sp = panSpeed();
        log("pan dx=" + e.deltaX + " dy=" + e.deltaY);
        tx -= e.deltaX * unit * sp;
        ty -= e.deltaY * unit * sp;
        clampPan();
        apply();
      },
      { capture: true, passive: false }
    );

    // --- Cmd+0 resets the view --------------------------------------------
    doc.addEventListener(
      "keydown",
      (e) => {
        if (e.metaKey && e.key === "0") {
          e.preventDefault();
          reset();
        }
      },
      true
    );

    win.addEventListener("resize", () => {
      clampPan();
      apply();
    });
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
  log("PiP Gestures v0.2 loaded. Debug is " + (debugOn() ? "ON" : "OFF"), true);
})();
