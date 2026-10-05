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
  
  // ---- Settings ------------------------------------------------------------------------------
  // Every setting lives in about:config under zen.pipgestures.<name>, and is exposed in the Sine mods
  // page through preferences.json. To add a setting:
  //   1. add it to DEFAULTS below (the value's type, boolean or integer, is the pref's type),
  //   2. add a matching entry to preferences.json (same property name and defaultValue),
  //   3. read it with pref("name") wherever it's needed; changes apply live, no restart needed.
  const PREF_ROOT = "zen.pipgestures.";
  const DEFAULTS = {
    debug: false,       // log what the mod is doing (Browser Console, and a file on the Desktop)
    logToFile: true,    // with debug on: also write PiP_Gestures_log.txt on the Desktop
    enableMove: true,   // two-finger scroll moves the PiP window
    enablePinch: true,  // pinch resizes the PiP window
    panSpeed: 100,      // % - window move sensitivity
    pinchSpeed: 100,    // % - resize sensitivity
    keepOnScreen: true, // hard-stop the window at screen edges that have no neighbouring screen
    minWidth: 200,      // px - smallest the window can be pinched down to
    hideCursor: true,   // hide the cursor and carry it along with the window during a gesture
    holdMs: 600,        // ms - how long resting fingers can pause mid-move before the cursor returns
    gummy: false,       // goofy gummy mode: the window peels, stretches, bounces and wobbles
    gummyStretch: 100,  // % - how far the trailing sides peel back when you move fast
    gummySpring: 100,   // % - springiness: higher = looser, longer wobble
    gummyBounce: 70,    // % - how much speed is kept when bouncing off a screen edge (0 = just squish)
    gummyFriction: 100, // % - how quickly a thrown window slows down (higher = stops sooner)
  };

  const P = Services.prefs;

  // Give every setting a default so the Sine settings page and about:config show the real values.
  (function registerDefaults() {
    const branch = P.getDefaultBranch("");
    for (const [name, def] of Object.entries(DEFAULTS)) {
      try {
        if (typeof def === "boolean") branch.setBoolPref(PREF_ROOT + name, def);
        else branch.setIntPref(PREF_ROOT + name, def);
      } catch (e) {}
    }
  })();

  // Read a setting. Tolerant of the pref having been stored as a different type (e.g. a string from
  // a settings UI), and always falls back to the default.
  function pref(name) {
    const def = DEFAULTS[name];
    const full = PREF_ROOT + name;
    try {
      const type = P.getPrefType(full);
      if (typeof def === "boolean") {
        if (type === P.PREF_BOOL) return P.getBoolPref(full);
        if (type === P.PREF_STRING) return P.getStringPref(full) === "true";
        if (type === P.PREF_INT) return P.getIntPref(full) !== 0;
      } else {
        let v = NaN;
        if (type === P.PREF_INT) v = P.getIntPref(full);
        else if (type === P.PREF_STRING) v = parseInt(P.getStringPref(full), 10);
        if (Number.isFinite(v)) return v;
      }
    } catch (e) {}
    return def;
  }
  const debugOn = () => pref("debug");
  const pinchSpeed = () => pref("pinchSpeed") / 100;
  const panSpeed = () => pref("panSpeed") / 100;
  const holdMs = () => pref("holdMs");

  // Screen geometry, in desktop (CSS-like) pixels. The available rect excludes the menu bar and Dock.
  const screenMgr = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager);
  function availRectAt(x, y) {
    const scr = screenMgr.screenForRect(Math.round(x), Math.round(y), 1, 1); // nearest screen to the point
    const L = {}, T = {}, W = {}, H = {};
    scr.GetAvailRectDisplayPix(L, T, W, H);
    return { left: L.value, top: T.value, right: L.value + W.value, bottom: T.value + H.value };
  }
  const sameRect = (a, b) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

  let logCount = 0;
  const LOG_FILE = (() => {
    try {
      return PathUtils.join(Services.dirsvc.get("Desk", Ci.nsIFile).path, "PiP_Gestures_log.txt");
    } catch (e) {
      return null;
    }
  })();

  // force = true also logs to the console when debug is off (startup and error lines).
  // The Desktop log file is only written while debug is on.
  function log(msg, force) {
    const debug = debugOn();
    if (!force && !debug) return;
    if (++logCount > 5000) return; // keep it readable
    const line = "[PiP Gestures] " + msg;
    try { console.log(line); } catch (e) {}
    try { Services.console.logStringMessage(line); } catch (e) {}
    if (LOG_FILE && debug && pref("logToFile")) {
      try {
        IOUtils.writeUTF8(LOG_FILE, new Date().toISOString() + " " + line + "\n", {
          mode: "appendOrCreate",
        });
      } catch (e) {}
    }
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---- Gummy physics (pure functions, no DOM) ------------------------------------------------
  // The window is modelled as a rigid "body" (the rect the fingers and momentum drive) plus four
  // independently sprung edges that chase it. Trailing edges are softer than leading ones, so a fast
  // move stretches the window backwards ("peels"); when the body hits a wall the leading edge is held
  // at the wall while the trailing edge keeps coming (a squash), then everything springs back.
  // <physics>
  const GUMMY_MIN_BOUNCE_V = 120; // px/s - slower impacts just stop instead of bouncing
  const GUMMY_MIN_SIZE = 80;      // px - the squash never collapses a window below this
  const GUMMY_MAX_V = 6000;       // px/s

  function gummyParams(get) {
    const spring = clamp(get("gummySpring") / 100, 0.3, 3);
    return {
      omega: 22 / Math.sqrt(spring),             // rad/s - how fast edges chase their target
      zeta: clamp(0.28 / spring, 0.08, 0.9),     // damping ratio: lower = more wobble
      stretch: clamp(get("gummyStretch") / 100, 0, 3),
      restitution: clamp(get("gummyBounce") / 100, 0, 0.95),
      friction: 2.5 * clamp(get("gummyFriction") / 100, 0.1, 5), // 1/s
    };
  }

  // Keep one axis of the body inside [lo, hi]. Returns the new velocity and whether it bounced.
  function gummyCollideAxis(pos, vel, lo, hi, restitution) {
    if (pos < lo) {
      if (vel >= 0) return { pos: lo, vel, bounced: false };
      const bounced = -vel > GUMMY_MIN_BOUNCE_V && restitution > 0;
      return { pos: lo, vel: bounced ? -vel * restitution : 0, bounced };
    }
    if (pos > hi) {
      if (vel <= 0) return { pos: hi, vel, bounced: false };
      const bounced = vel > GUMMY_MIN_BOUNCE_V && restitution > 0;
      return { pos: hi, vel: bounced ? -vel * restitution : 0, bounced };
    }
    return { pos, vel, bounced: false };
  }

  // Clamp the body rect g ({x, y}) into bounds b ({minX, maxX, minY, maxY}), reflecting bv.
  function gummyCollide(g, bv, b, restitution) {
    const cx = gummyCollideAxis(g.x, bv.x, b.minX, b.maxX, restitution);
    const cy = gummyCollideAxis(g.y, bv.y, b.minY, b.maxY, restitution);
    g.x = cx.pos; bv.x = cx.vel;
    g.y = cy.pos; bv.y = cy.vel;
    return cx.bounced || cy.bounced;
  }

  // Free flight of the body: friction, then walls.
  function gummyFly(g, bv, b, pr, h) {
    const f = Math.exp(-pr.friction * h);
    bv.x *= f;
    bv.y *= f;
    g.x += bv.x * h;
    g.y += bv.y * h;
    return b ? gummyCollide(g, bv, b, pr.restitution) : false;
  }

  // lim: how far (px) an edge may stray from its rigid target in either direction (peel or squash).
  function gummySpringEdge(e, target, omega, zeta, lim, h) {
    e.v += (omega * omega * (target - e.p) - 2 * zeta * omega * e.v) * h;
    e.p += e.v * h;
    if (e.p > target + lim) { e.p = target + lim; if (e.v > 0) e.v = 0; }
    else if (e.p < target - lim) { e.p = target - lim; if (e.v < 0) e.v = 0; }
  }

  // One axis of the sprung rect: lo/hi are edges {p, v}, tLo/tHi the rigid targets, bodyV the body's
  // velocity along this axis (it decides which edge is trailing), wallLo/wallHi optional hard walls.
  function gummySpringAxis(lo, hi, tLo, tHi, bodyV, wallLo, wallHi, pr, h) {
    const dir = clamp(bodyV / 900, -1, 1);
    const soft = Math.min(0.9, 0.9 * pr.stretch * Math.abs(dir));
    const trail = pr.omega * Math.sqrt(1 - soft);
    // The more "stretch", the further the sides may peel away from the rigid window.
    const lim = (tHi - tLo) * Math.min(1, 0.12 + 0.4 * pr.stretch);
    gummySpringEdge(lo, tLo, dir > 0 ? trail : pr.omega, pr.zeta, lim, h);
    gummySpringEdge(hi, tHi, dir < 0 ? trail : pr.omega, pr.zeta, lim, h);
    if (wallLo !== null) {
      if (lo.p < wallLo) { lo.p = wallLo; if (lo.v < 0) lo.v = 0; }
      if (hi.p > wallHi) { hi.p = wallHi; if (hi.v > 0) hi.v = 0; }
    }
    if (hi.p - lo.p < GUMMY_MIN_SIZE) {
      const mid = (hi.p + lo.p) / 2;
      lo.p = mid - GUMMY_MIN_SIZE / 2;
      hi.p = mid + GUMMY_MIN_SIZE / 2;
      lo.v = hi.v = 0;
    }
  }

  // Is everything at rest (body, edges, and no fingers driving)?
  function gummyCalm(E, targets, bv) {
    const near = (e, t) => Math.abs(e.p - t) < 0.4 && Math.abs(e.v) < 8;
    return near(E.L, targets.l) && near(E.R, targets.r) && near(E.T, targets.t) && near(E.B, targets.b) &&
      Math.abs(bv.x) < 8 && Math.abs(bv.y) < 8;
  }
  // </physics>

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
    const g = { x: 0, y: 0, w: 0, h: 0, aspect: 1, t: 0 };

    // Gummy mode state (see the physics block at the top of the file). While the loop runs, `g` is
    // the rigid rect the fingers/momentum drive and the real window is the sprung rect GM.E.
    const GM = {
      running: false,
      raf: 0,
      startT: 0,
      lastT: 0,
      E: { L: { p: 0, v: 0 }, R: { p: 0, v: 0 }, T: { p: 0, v: 0 }, B: { p: 0, v: 0 } },
      bv: { x: 0, y: 0 },  // velocity of the rigid body, px/s
      swallow: false,      // a throw is in flight; ignore the trackpad's leftover momentum events
      lastEvT: 0,          // last time fingers/momentum moved the body
      lastRawT: 0,
      lastMag: 0,
      chromeW: 0,
      chromeH: 0,
      pinW: 0,
      pinH: 0,
      viewSaved: null,
      bounces: 0,
    };
    const gummyOn = () => pref("gummy");
    const nowMs = () => win.performance.now();

    function sync() {
      const now = Date.now();
      // While gummy is animating, the real window is deformed and g is the source of truth.
      if (!GM.running && (now - g.t > IDLE_MS || !g.w)) {
        g.x = win.screenX;
        g.y = win.screenY;
        g.w = win.outerWidth;
        g.h = win.outerHeight;
        g.aspect = g.w / g.h || 16 / 9;
      }
      g.t = now;
    }

    // Where the window may be. An edge with no other screen beyond it is a hard wall (the window
    // is repelled and can never be clipped by it); an edge that borders another screen is open,
    // so the window can still travel between monitors.
    let lastBoundsLog = "";
    function windowBounds() {
      const w = Math.ceil(g.w);
      const h = Math.ceil(g.h);
      const cx = g.x + g.w / 2;
      const cy = g.y + g.h / 2;
      let r;
      let open = { l: false, r: false, t: false, b: false };
      try {
        r = availRectAt(cx, cy);
        // The nearest screen to a point beyond the edge is this same screen unless another one is there.
        open = {
          l: !sameRect(availRectAt(r.left - 8, cy), r),
          r: !sameRect(availRectAt(r.right + 8, cy), r),
          t: !sameRect(availRectAt(cx, r.top - 8), r),
          b: !sameRect(availRectAt(cx, r.bottom + 8), r),
        };
      } catch (e) {
        // Fall back to the window's own screen with hard walls all round.
        const sc = win.screen;
        const left = sc.availLeft || 0;
        const top = sc.availTop || 0;
        r = { left, top, right: left + sc.availWidth, bottom: top + sc.availHeight };
      }
      const margin = 60; // across an open edge, keep this much of the window reachable
      const minX = open.l ? r.left - w + margin : r.left;
      const minY = open.t ? r.top - h + margin : r.top;
      const maxX = open.r ? r.right - margin : r.right - w;
      const maxY = open.b ? r.bottom - margin : r.bottom - h;
      const desc = "screen=(" + r.left + "," + r.top + " " + (r.right - r.left) + "x" + (r.bottom - r.top) +
        ") neighbours L" + +open.l + " R" + +open.r + " T" + +open.t + " B" + +open.b +
        " screens=" + screenMgr.numberOfScreens + " win.screen=" + win.screen.availWidth + "x" + win.screen.availHeight;
      if (desc !== lastBoundsLog) {
        lastBoundsLog = desc;
        log("bounds: " + desc);
      }
      return {
        minX, minY, maxX: Math.max(minX, maxX), maxY: Math.max(minY, maxY),
        // Largest window that fits on this screen at the current aspect ratio.
        maxW: open.l || open.r || open.t || open.b
          ? r.right - r.left
          : Math.min(r.right - r.left, (r.bottom - r.top) * g.aspect),
      };
    }

    function keepOnScreen() {
      if (!pref("keepOnScreen")) return;
      const b = windowBounds();
      g.x = clamp(g.x, b.minX, b.maxX);
      g.y = clamp(g.y, b.minY, b.maxY);
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
      if (!pref("hideCursor")) return;
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


    // Hide the cursor everywhere in the window. A plain `cursor: none` on the root isn't enough
    // because elements under the pointer (the controls overlay) set their own cursor.
    let hideStyle = null;
    function hideCursor() {
      if (!pref("hideCursor")) return;
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

    // Re-read the window's real geometry and push it back inside the walls if it ended up outside
    // (e.g. the OS adjusted the size or position of a move/resize we asked for).
    function settleOnScreen() {
      g.x = win.screenX;
      g.y = win.screenY;
      g.w = win.outerWidth;
      g.h = win.outerHeight;
      g.t = Date.now();
      const x0 = g.x;
      const y0 = g.y;
      keepOnScreen();
      if (g.x !== x0 || g.y !== y0) {
        log("pushed back inside the screen edge: (" + x0 + "," + y0 + ") -> (" + Math.round(g.x) + "," + Math.round(g.y) + ")");
        try { win.moveTo(Math.round(g.x), Math.round(g.y)); } catch (e) {}
      }
    }

    function endGesture(reason, userTookOver) {
      if (!gesturing) return;
      if (GM.running && !userTookOver) {
        // The window is still flying/wobbling; end the gesture (and return the cursor) once it settles.
        if (idleTimer) win.clearTimeout(idleTimer);
        idleTimer = win.setTimeout(() => endGesture(reason), 100);
        return;
      }
      gesturing = false;
      if (idleTimer) win.clearTimeout(idleTimer);
      idleTimer = null;
      recent.length = 0;
      fading = false;
      // The window has settled by now; park the (still hidden) cursor at the centre of where it
      // ended up, then reveal it a moment later so the jump itself is never seen.
      if (!GM.running) settleOnScreen();
      const a = [g.x + g.w / 2, g.y + g.h / 2];
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
      if (gummyOn()) {
        gummyStart(); // the loop moves/resizes the window and carries the cursor
        return;
      }
      try {
        if (resized) win.resizeTo(Math.round(g.w), Math.round(g.h));
        win.moveTo(Math.round(g.x), Math.round(g.y));
      } catch (e) {
        log("move/resize failed: " + e, true);
      }
      // Carry the cursor along with the window so it stays under the pointer's original spot.
      if (gesturing) warpCursor(g.x + curFx * g.w, g.y + curFy * g.h);
    }

    // ---- Gummy engine -----------------------------------------------------------------------
    const VIEW_PROPS = ["position", "left", "top", "width", "height", "transformOrigin", "transform"];

    // Pin the video's layout size so that when the window is stretched the picture stretches with it
    // (otherwise it would just letterbox), then scale it to whatever size the window currently is.
    function pinView() {
      GM.viewSaved = {};
      for (const k of VIEW_PROPS) GM.viewSaved[k] = view.style[k];
      view.style.position = "absolute";
      view.style.left = "0px";
      view.style.top = "0px";
      view.style.transformOrigin = "0 0";
      GM.pinW = 0; // forces the size to be applied on the first frame
      GM.pinH = 0;
    }
    function unpinView() {
      if (!GM.viewSaved) return;
      for (const k of VIEW_PROPS) view.style[k] = GM.viewSaved[k];
      GM.viewSaved = null;
    }

    function gummyStart() {
      if (GM.running) return;
      GM.running = true;
      GM.bounces = 0;
      const E = GM.E;
      // Start from the window exactly as it is now (before this event's change to g).
      E.L.p = win.screenX; E.R.p = win.screenX + win.outerWidth;
      E.T.p = win.screenY; E.B.p = win.screenY + win.outerHeight;
      E.L.v = E.R.v = E.T.v = E.B.v = 0;
      GM.chromeW = win.outerWidth - win.innerWidth;
      GM.chromeH = win.outerHeight - win.innerHeight;
      pinView();
      GM.startT = GM.lastT = nowMs();
      GM.raf = win.requestAnimationFrame(gummyStep);
      log("gummy: start");
    }

    function gummyStop() {
      GM.running = false;
      if (GM.raf) win.cancelAnimationFrame(GM.raf);
      GM.raf = 0;
      GM.bv.x = GM.bv.y = 0;
      GM.swallow = false;
      // Snap to the exact rest geometry and give the video its normal layout back.
      try {
        win.resizeTo(Math.round(g.w), Math.round(g.h));
        win.moveTo(Math.round(g.x), Math.round(g.y));
      } catch (e) {}
      unpinView();
    }

    function gummyStep() {
      GM.raf = 0;
      if (!GM.running) return;
      if (!gummyOn()) {
        gummyStop();
        return;
      }
      const t = nowMs();
      const dt = clamp((t - GM.lastT) / 1000, 0.001, 0.05);
      GM.lastT = t;
      const pr = gummyParams(pref);
      // A flight that somehow never settles (extreme settings) gets progressively more friction.
      if (t - GM.startT > 8000) pr.friction *= 1 + (t - GM.startT - 8000) / 1000;
      const walls = pref("keepOnScreen") ? windowBounds() : null;
      const driven = !GM.swallow && t - GM.lastEvT < 40; // fingers (or the OS's momentum) are moving it
      const E = GM.E;
      const steps = Math.max(1, Math.ceil(dt / 0.008));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        if (!driven && gummyFly(g, GM.bv, walls, pr, h)) {
          GM.bounces++;
          log("gummy: bounce #" + GM.bounces + " v=(" + Math.round(GM.bv.x) + "," + Math.round(GM.bv.y) + ")");
        }
        gummySpringAxis(E.L, E.R, g.x, g.x + g.w, GM.bv.x,
          walls ? walls.minX : null, walls ? walls.maxX + g.w : null, pr, h);
        gummySpringAxis(E.T, E.B, g.y, g.y + g.h, GM.bv.y,
          walls ? walls.minY : null, walls ? walls.maxY + g.h : null, pr, h);
      }

      // Apply the sprung rect to the real window...
      const l = Math.round(E.L.p);
      const top = Math.round(E.T.p);
      const w = Math.round(E.R.p - E.L.p);
      const hgt = Math.round(E.B.p - E.T.p);
      try {
        if (w !== win.outerWidth || hgt !== win.outerHeight) win.resizeTo(w, hgt);
        if (l !== win.screenX || top !== win.screenY) win.moveTo(l, top);
      } catch (e) {
        log("gummy: move/resize failed: " + e, true);
      }
      // ...and stretch the picture to match. The pinned layout size is the window's rest size.
      const restW = Math.max(1, Math.round(g.w - GM.chromeW));
      const restH = Math.max(1, Math.round(g.h - GM.chromeH));
      if (restW !== GM.pinW || restH !== GM.pinH) {
        GM.pinW = restW;
        GM.pinH = restH;
        view.style.width = restW + "px";
        view.style.height = restH + "px";
      }
      const sx = win.innerWidth / restW;
      const sy = win.innerHeight / restH;
      view.style.transform = Math.abs(sx - 1) < 0.002 && Math.abs(sy - 1) < 0.002 ? "" : "scale(" + sx + "," + sy + ")";

      if (gesturing) warpCursor(E.L.p + curFx * (E.R.p - E.L.p), E.T.p + curFy * (E.B.p - E.T.p));

      const calm = !driven && gummyCalm(E, { l: g.x, r: g.x + g.w, t: g.y, b: g.y + g.h }, GM.bv);
      if (calm && t - GM.lastEvT > 100) {
        log("gummy: settled after " + Math.round(t - GM.startT) + "ms, " + GM.bounces + " bounces");
        gummyStop();
        return;
      }
      GM.raf = win.requestAnimationFrame(gummyStep);
    }

    // Fingers (or the trackpad's momentum) move the body by (dx, dy).
    function gummyMove(dx, dy) {
      sync();
      const t = nowMs();
      const gap = t - GM.lastEvT;
      if (gap > 60) GM.bv.x = GM.bv.y = 0; // a fresh touch grabs the window
      const dts = clamp(gap, 4, 50) / 1000;
      GM.bv.x = clamp(GM.bv.x * 0.4 + (dx / dts) * 0.6, -GUMMY_MAX_V, GUMMY_MAX_V);
      GM.bv.y = clamp(GM.bv.y * 0.4 + (dy / dts) * 0.6, -GUMMY_MAX_V, GUMMY_MAX_V);
      GM.lastEvT = t;
      g.x += dx;
      g.y += dy;
      if (pref("keepOnScreen") && gummyCollide(g, GM.bv, windowBounds(), gummyParams(pref).restitution)) {
        // Hit a wall hard enough to bounce: the body is now flying, so ignore the leftover momentum
        // events (they'd push it back into the wall) until a fresh touch comes along.
        GM.swallow = true;
        GM.bounces++;
        log("gummy: bounce #" + GM.bounces + " v=(" + Math.round(GM.bv.x) + "," + Math.round(GM.bv.y) + ")");
      }
      gummyStart();
    }

    // Resize by `factor` around the window's centre.
    function resizeBy(factor) {
      sync();
      const minW = pref("minWidth");
      const maxW = pref("keepOnScreen") ? windowBounds().maxW : Infinity;
      const newW = clamp(g.w * factor, minW, Math.max(minW, maxW));
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
      if (!pref("hideCursor")) return;
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

    // Handles both two-finger scrolls (moves) and pinches (ctrl+wheel). A scroll is delivered to the
    // window under the cursor, so it arrives here directly; a pinch is only delivered to the focused
    // window, so for an unfocused PiP it arrives via the browser-window listener further down and is
    // handed to this function through win.__pipGesturesController.
    function onWheel(e) {
      // A gesture that's switched off is left completely alone (default behaviour applies).
      if (!pref(e.ctrlKey ? "enablePinch" : "enableMove")) return;
      e.preventDefault();
      e.stopPropagation();
      const mag = e.ctrlKey ? Math.abs(e.deltaY) : Math.hypot(e.deltaX, e.deltaY);
      lastWheelT = Date.now();
      // Gummy: while a throw is in flight, the trackpad's leftover momentum events are ignored. A
      // fresh touch (a pinch, a pause, or a jump in size) catches the window.
      const tRaw = nowMs();
      const rawGap = tRaw - GM.lastRawT;
      const prevMag = GM.lastMag;
      GM.lastRawT = tRaw;
      GM.lastMag = mag;
      if (GM.swallow) {
        if (e.ctrlKey || rawGap > 90 || mag > prevMag * 1.25 + 2) {
          GM.swallow = false;
          GM.bv.x = GM.bv.y = 0;
          log("gummy: caught the flying window");
        } else {
          return;
        }
      }
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
      if (gummyOn()) gummyMove(-e.deltaX * unit * sp, -e.deltaY * unit * sp);
      else moveBy(-e.deltaX * unit * sp, -e.deltaY * unit * sp);
      logEvent(e);
    }
    doc.addEventListener("wheel", onWheel, { capture: true, passive: false });
    win.__pipGesturesController = { onWheel };
  }

  // ---- Pinching an unfocused PiP window ------------------------------------------------------
  // macOS delivers scroll events to the window under the cursor but pinch gestures only to the focused
  // window. With the PiP unfocused (the usual case while you work in the browser), the pinch lands on
  // the main window instead, where it would zoom the page. Catch it here and, if the cursor is over a
  // PiP window, resize that window instead.
  function pipUnderCursor(e) {
    for (const w of Services.wm.getEnumerator(null)) {
      try {
        if (!w.__pipGesturesController || !isPipWindow(w)) continue;
        if (e.screenX >= w.screenX && e.screenX < w.screenX + w.outerWidth &&
            e.screenY >= w.screenY && e.screenY < w.screenY + w.outerHeight) return w;
      } catch (err) {}
    }
    return null;
  }
  let forwardedLogs = 0;
  window.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      const pip = pipUnderCursor(e);
      if (!pip) return;
      if (forwardedLogs++ < 3) log("pinch over an unfocused PiP window; handing it over");
      pip.__pipGesturesController.onWheel(e);
    },
    { capture: true, passive: false }
  );
  // Some setups report pinches as gesture events rather than ctrl+wheel; log them so we can tell.
  let magnifyLogs = 0;
  for (const type of ["MozMagnifyGestureStart", "MozMagnifyGestureUpdate"]) {
    window.addEventListener(
      type,
      (e) => {
        const pip = pipUnderCursor(e);
        if (!pip) return;
        if (magnifyLogs++ < 5) log(type + " over a PiP window: delta=" + e.delta + " (not handled)");
      },
      true
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
  log("PiP Gestures v0.5.1 loaded. Debug is " + (debugOn() ? "ON" : "OFF"), true);
})();
