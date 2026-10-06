# PiP Gestures

Two-finger move and pinch-to-resize for Picture-in-Picture windows in [Zen Browser](https://zen-browser.app), like Arc. Built for macOS trackpads.

- **Two-finger scroll** over a PiP window moves the window. It keeps coasting after you lift your fingers.
- **Pinch** resizes the window around its center and keeps the aspect ratio.
- The cursor hides while you gesture and travels with the window, then comes back at the window's center.
- The window stops at screen edges that have no other monitor beyond them, so it can't be clipped. Edges that border another monitor stay open.

macOS only sends pinch gestures to the focused window, so while your cursor rests over a PiP window it takes focus (and gives it back when you leave). Switch this off with "Focus the PiP while hovering it" if you'd rather click the window first. It never takes focus while you're typing in the browser, or when another app is frontmost (a pinch can't reach the PiP then, since macOS sends it to the other app).

### When another app is in front

macOS only delivers pinch gestures to the active app, and only the active app can hide the cursor. So when you start moving or resizing a PiP while another app is in front, the browser is brought forward and the PiP focused (like Dia does), and from then on pinch and cursor hiding work as usual. Hovering alone never does this. This can also raise the main browser window; turn off "When another app is in front, bring the browser forward" if you'd rather it didn't, in which case two-finger scrolling still moves the PiP and **Option + two-finger scroll** resizes it (fingers up = bigger) without needing any focus.

## Gummy mode

An optional, goofy mode (off by default; turn it on in the settings). Flick a window and it behaves like it's made of gummy:

- The sides **peel back** along the direction you're pushing, so the window and the picture stretch, then spring back with a wobble.
- A hard flick **bounces off the screen edges**: the window squashes against the wall, rebounds, and keeps bouncing around the screen until it runs out of energy.
- Touch it again while it's flying and you catch it.

You can tune how far it peels, how springy it is, how bouncy the walls are and how far a throw slides. Bouncing needs "Keep the window on screen" (the walls) to be on.

## Install

Install through [Sine](https://github.com/CosmoCreeper/Sine) by adding this repository, `11moo11/PiP-Gestures`, as a mod. Restart Zen after installing.

## Settings

Open the mod's settings on the Sine mods page. Changes apply instantly. Every setting is also a pref in `about:config` under `zen.pipgestures.*`.

| Setting | Pref | Default |
| --- | --- | --- |
| Move with two-finger scroll | `enableMove` | on |
| Move speed (%) | `panSpeed` | 100 |
| Resize by pinching | `enablePinch` | on |
| Focus the PiP while hovering it (so pinch works unfocused) | `focusOnHover` | on |
| Bring the browser forward when you gesture while another app is in front | `focusOtherApps` | on |
| Resize with Option + two-finger scroll | `altResize` | on |
| Pinch speed (%) | `pinchSpeed` | 100 |
| Smallest width when pinching in (px) | `minWidth` | 200 |
| Keep the window on screen | `keepOnScreen` | on |
| Hide the cursor during a gesture | `hideCursor` | on |
| Rest time before the cursor returns (ms) | `holdMs` | 600 |
| Gummy mode | `gummy` | off |
| Peel amount (%) | `gummyStretch` | 100 |
| Springiness (%) | `gummySpring` | 100 |
| Wall bounciness (%) | `gummyBounce` | 70 |
| Slide friction (%) | `gummyFriction` | 100 |
| Debug mode | `debug` | off |
| Save the debug log to the Desktop | `logToFile` | on (needs debug) |

## Troubleshooting

Turn on **Debug mode**, reproduce the problem, and open the Browser Console (`Cmd+Shift+J`). The same log is saved as `PiP_Gestures_log.txt` on your Desktop while debug is on.

A trackpad sends no events while your fingers rest, so the mod can't tell resting from lifting. After a flick it notices the momentum fading and gives the cursor back right away; after a slow stop it waits for the "rest time" setting.

## Releasing updates (for contributors)

Sine decides whether a mod needs updating by comparing the `updatedAt` date in `theme.json` with the one stored in the installed copy (the `version` number isn't compared). **Don't put `updatedAt` in `theme.json`**: when it's missing, Sine uses the repository's last-push time from the GitHub API, so every push is picked up automatically. A fixed `updatedAt` means Sine never sees an update. Sine checks once when the browser starts, and changes to the `.uc.js` script only take effect after a restart.

## Adding a setting (for contributors)

1. Add it to `DEFAULTS` at the top of `pip-gestures.uc.js`. The value's type (boolean or integer) is the pref's type.
2. Add a matching entry to `preferences.json` with the same `zen.pipgestures.<name>` property and `defaultValue`. The format is Sine's: `checkbox`, `dropdown` (use `"value": "number"` for integer options), `string`, `text` and `separator`.
3. Read it with `pref("<name>")` where it's needed. It's read live on every use, so changes apply without a restart.
