# PiP Gestures

Two-finger move and pinch-to-resize for Picture-in-Picture windows in [Zen Browser](https://zen-browser.app), like Arc. Built for macOS trackpads.

- **Two-finger scroll** over a PiP window moves the window. It keeps coasting after you lift your fingers.
- **Pinch** resizes the window around its center and keeps the aspect ratio.
- The cursor hides while you gesture and travels with the window, then comes back at the window's center.
- The window stops at screen edges that have no other monitor beyond them, so it can't be clipped. Edges that border another monitor stay open.

## Install

Install through [Sine](https://github.com/CosmoCreeper/Sine) by adding this repository, `11moo11/PiP-Gestures`, as a mod. Restart Zen after installing.

## Settings

Open the mod's settings on the Sine mods page. Changes apply instantly. Every setting is also a pref in `about:config` under `zen.pipgestures.*`.

| Setting | Pref | Default |
| --- | --- | --- |
| Move with two-finger scroll | `enableMove` | on |
| Move speed (%) | `panSpeed` | 100 |
| Resize by pinching | `enablePinch` | on |
| Pinch speed (%) | `pinchSpeed` | 100 |
| Smallest width when pinching in (px) | `minWidth` | 200 |
| Keep the window on screen | `keepOnScreen` | on |
| Hide the cursor during a gesture | `hideCursor` | on |
| Rest time before the cursor returns (ms) | `holdMs` | 600 |
| Debug mode | `debug` | off |
| Save the debug log to the Desktop | `logToFile` | on (needs debug) |

## Troubleshooting

Turn on **Debug mode**, reproduce the problem, and open the Browser Console (`Cmd+Shift+J`). The same log is saved as `PiP_Gestures_log.txt` on your Desktop while debug is on.

A trackpad sends no events while your fingers rest, so the mod can't tell resting from lifting. After a flick it notices the momentum fading and gives the cursor back right away; after a slow stop it waits for the "rest time" setting.

## Adding a setting (for contributors)

1. Add it to `DEFAULTS` at the top of `pip-gestures.uc.js`. The value's type (boolean or integer) is the pref's type.
2. Add a matching entry to `preferences.json` with the same `zen.pipgestures.<name>` property and `defaultValue`. The format is Sine's: `checkbox`, `dropdown` (use `"value": "number"` for integer options), `string`, `text` and `separator`.
3. Read it with `pref("<name>")` where it's needed. It's read live on every use, so changes apply without a restart.
