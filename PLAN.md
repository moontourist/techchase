# [tc] techchase: plan

techchase is tournament firmware and a setup app for the Hand Held Legend GC Ultimate: a fork of
HHL's HOJA firmware, public at `github.com/moontourist/techchase`. Working name before 2026-11-21:
"GCU Tourney". HHL's own firmware has a feature called tourney mode (`macro_tourney.c`), which
this project leaves alone and never renames.

Target hardware: **Hand Held Legend GC Ultimate, revision R4K** (USB product string `GCU-R4K`,
FCC ID 2BM3E-GCU-R4K). Upstream firmware target: `hoja-device-fw/rp2040/gcu_1`.

## Mission
**techchase is the all-in-one controller utility for PhobGCC and the GC Ultimate: one place to
calibrate them and to cut their input lag, so every aftermarket controller gets the same lag
reduction and is ready for tournament play.**

**Focus, from 2026-11-21: the Phob first.** Phob calibration is what will bring players in; few
use a GC Ultimate, and its side does what HHL's firmware does, a little better. New work starts
with the Phob, the app and README lead with it, and the GC Ultimate gets the same where it fits.

Every decision gets checked against it:
* **Calibrate or cut lag?** A feature should help a player calibrate a Phob or a GC Ultimate, or
  lower its input lag. Anything else waits.
* **Both controllers.** A feature built for one controller is planned for the other too, or the
  plan says why it can't be. Prefer approaches that reach more aftermarket controllers (any HOJA
  board, any PhobGCC) over ones tied to one board.
* **Tournament-legal.** Nothing ships that a Melee or Ultimate ruleset would ban, and anything near
  the line is off by default.
* **Intuitive.** A player who has never read a manual can do it: show the controller live, say what
  to do next, and show the result.
* **Measured.** Lag claims come with numbers taken on the controller, and the method is written
  down.

## Goal
As close to a PhobGCC as possible in input lag and tournament viability, on the platforms the owner
plays:

* **Switch 2** for Smash Ultimate.
* **PC**: OpenSmash (Ultimate, the owner's Corneria fork) and Slippi Dolphin (Melee).

The controller connects over **USB-C or Bluetooth**. It has no GameCube plug. Wired is the
tournament path, and Bluetooth comes second.

Targets for wired play (these are our numbers, not a measured Phob figure; Phase 9 measures the
real comparison):
* Input age at hand-off: 0.5 ms average or less, 1 ms worst case or less.
* 0 missed polls, at whatever rate the host polls.
* No added button delay.
* Stick filtering delay no worse than a Phob's.

## Name, repo and rules
* **Name and mark:** techchase, drawn as `[tc]`, the way thunk is `[*]` and seethe is `[s]`.
* **Look:** the same family as thunk, seethe, wave and tascii (monospace, square boxes, bracketed
  choices), in Ghostty's **Nord** palette (14f). JetBrains Mono.
* **Repo:** public, README in the thunk/seethe/wave format (banner, what it does, install,
  controls, how it's built, develop, roadmap, credits).
* **Code rules:** the `scadoshi-rust` rules (from scadoshi's zwipe, as copied into wave, thunk and
  seethe), applied to C, JavaScript and Python. Written out in `CONTRIBUTING.md`. In short:
  * no panics outside tests (no `assert`/`abort` in firmware paths, no unhandled throw or
    rejection in the app, no bare `except` or traceback for a user error in the tools)
  * no unchecked casts or indexing: every narrowing cast and every buffer index is range-checked or
    carries a comment saying why it can't go wrong
  * every lint exception explained, on the narrowest line it can be
  * no comments in code; reasons go in commit messages and this plan, and prose has no em dashes
  * one-line commit messages, no emoji
* **License:** CC BY-NC-SA 3.0, the same as HOJA, because the firmware is a derivative of it.

## Phase 0: Research findings (done)

### Hardware (from `rp2040/gcu_1/main.c` + `board_config.h`)
| Part | What it is | Notes |
|---|---|---|
| MCU | RP2040, dual Cortex-M0+, no FPU | 264 KB SRAM, 1 MB flash (GD25Q80) |
| Radio | ESP32 as an HCI Bluetooth controller over I2C/UART | separate firmware, untouched here |
| Sticks | 2× MCP3002 SPI ADCs | read on core 0 at a fixed 2 kHz |
| Triggers | RP2040 internal ADC (GPIO 28/29) + digital click | |
| Buttons | 6×3 scanned matrix + Power on GPIO 5 | 15 µs settle per row |
| Joybus | joybus code on GPIO 20 via PIO | the controller has **no GameCube plug** (USB-C and Bluetooth only), so this path isn't used |
| Other | 2× LSM6DSR IMU, LRA haptics, 12 WS2812 LEDs, BQ25180 charger | |

### Firmware (HOJA)
* C11 on the Raspberry Pi Pico SDK 2.2.0, ARM GCC 14.2, about 37.6k lines in the core library. PIO
  assembly for the timing-critical wire protocols.
* License **CC BY-NC-SA 3.0**: a fork is allowed if it's non-commercial, attributed, and shared
  under the same license.
* Flash layout: the HOJA bootloader (`0x10000000–0x10007474`) and the app after it. A `.uf2` is a
  whole image.
* Core 0 runs the stick loop. Core 1 runs a cooperative task scheduler: input read, report build,
  RGB, flash, macros, and so on.
* Recovery: hold **ZL + Start while plugging in** → USB update mode. The app checks this combo at
  boot, before the main loops. The official image is backed up in `official/gcu_r4k/`.
* Stock build reproduced locally: 437,608 B flash vs 437,344 B official, with RAM at 89%.

### Where latency comes from today
1. **USB (Slippi/"GameCube adapter", SInput, XInput modes).** HHL's "sample at start-of-frame"
   hook (`usb_hal.c:_usb_hal_on_sof`) is actually called from `tud_task()`, not the start-of-frame
   interrupt (TinyUSB `usbd.c:690`). So input is read at *SOF + loop latency + read time*, then
   armed, and it doesn't depend on when the PC actually polls. If the PC polls early in the 1 ms
   frame, every report waits ~1 frame in the endpoint buffer. The worst case is ~1 ms of
   unnecessary input age, with jitter.
2. **GameCube port (console, Lossless/official adapter).** The report snapshot is rebuilt on a
   free-running 1 ms timer (`joybus_gc_hal.c:transport_jbgc_task`) that isn't synced to the
   console's polls. Input is 0–1 ms stale at each poll, ~0.5 ms on average.
3. **Button matrix.** 6 rows × 15 µs settle = 90 µs of busy-waiting per scan. That adds to every
   report.
   **Worse than it looks (found while building 2b):** the SOF callback sets "send", and the same
   `transport_usb_task` pass sends immediately, before the input read the callback just requested
   has run. So every stock USB report carries the *previous* cycle's input: about one extra frame
   of age. The simulation below measures stock at ~1.1–1.9 ms depending on the PC's poll phase.
4. **Sticks.** These are sampled on a fixed 2 kHz grid. The snapback filters are tuned for exactly
   500 µs (`snapback_lpf.c:72`, `snapback_auto.c:6`), so the **rate stays** to keep stick feel
   identical.

### Where the UX falls short today
* Remapping only works in the web app (Chromium + WebUSB, `handheldlegend.github.io/hoja3`).
  Nothing can be changed on the controller itself, e.g. at a tournament setup with no PC.
* Mappings are stored **per output mode** (Switch, XInput, SInput, GameCube/Slippi, N64, SNES,
  3× Wii). Swapping Z and X in Slippi doesn't carry over to Switch mode. The user has to know
  which mode they're in and redo it for each.

## Phase 1: Language & toolchain decision

**Stay in C on the Pico SDK (plus PIO assembly), and fork HOJA rather than rewrite.**

* Latency on this board comes from *scheduling*: when input is read relative to when the host or
  console reads it. Language speed isn't the bottleneck. C, C++ and Rust all compile to the same
  Thumb-1 machine code on an M0+, and the hard real-time parts (joybus, WS2812) run in PIO
  assembly whatever the host language.
* C is what the Pico SDK, TinyUSB, the ESP32 HCI bridge, the FLOSS BLE stack, and HHL's
  Switch/SInput/Wii protocol libraries are written in. Rust (embassy-rp) would mean rewriting
  ~40k lines, including undocumented Nintendo protocol work, for no latency gain.
* MicroPython/CircuitPython are out: they're interpreted and garbage-collected, with no timing
  guarantees.
* Performance rules this fork follows: no float math in the input→report path (the M0+ has no
  FPU), hot paths placed in SRAM only where RAM allows (89% used), timing from hardware IRQ
  timestamps, and no blocking flash writes while a report is due.

## Phase 2: Latency work
| # | Change | Expected effect |
|---|---|---|
| 2a | **Measure first.** Interrupt-time timestamps of USB SOF/IN-complete and joybus polls. Track *input age at hand-off* (time from button read to host/console taking the report) as min/avg/max. Readable over WebUSB with `tools/gcu.py stats`. | before/after numbers |
| 2b | **USB late-latch.** Learn the PC's poll phase within the 1 ms frame from IN-complete timestamps. Start the input read just early enough (measured read time + guard) to arm the endpoint right before the PC polls. Widen the guard automatically if a poll is missed. | input age from up to ~1 ms down to ~0.15–0.3 ms, with less jitter |
| 2c | **Joybus poll-lock.** Learn the console/adapter poll period from IRQ timestamps and rebuild the snapshot just before the next predicted poll. Fall back to a 500 µs free-run when polls are irregular. | GC-port input age from 0–1 ms (avg ~0.5) down to ~0.15–0.3 ms. **Deprioritized:** the GCU has no GameCube plug. The code is built and simulated, and it's harmless, but it gets no more work. |
| 2d | **Faster matrix scan.** 15 µs → 4 µs settle per row. | −66 µs per read |

Not changed: stick sample rate (filter feel), clock speed (PIO/SPI timing all derive from it),
Bluetooth.

### Phase 2 status (built, simulated, not yet on hardware)
* `utilities/latch.c` holds the scheduler. `latch_stats_s` is read by `gcu.py stats`. Late-latch can be
  switched off at runtime (`gcu.py latch off`), which restores stock timing for A/B on the same
  firmware.
* Stale-send fix: a USB report waits until the read that its trigger requested has started.
* The task loop holds optional tasks (RGB, flash writes) back when they would overrun a scheduled
  read. A pending read blocks them outright, and a long task gets the start of a gap so it isn't
  starved.
* If the PC hasn't taken the previous report yet, the next one is dropped so the schedule comes
  back into phase (otherwise every later report would be a frame late). A read held up by a stall
  doesn't widen the guard permanently.
* GameCube/Slippi report path (cores, joybus HAL, transport, latch) now runs from RAM, alongside the
  paths upstream already placed there. RAM is at 93.1% with no heap use.
* Host simulation `tests/sim_latch.c` compiles the real `latch.c` against stub hardware headers and
  reports input age at hand-off:

  | Scenario | Stock avg / max | techchase avg / max |
  |---|---|---|
  | USB, PC polls 120 µs into the frame | 1111 / 1150 µs | **251 / 288 µs** |
  | USB, poll at 500 µs | 1487 / 1505 µs | **251 / 288 µs** |
  | USB, poll at 900 µs | 1887 / 1905 µs | **252 / 288 µs** |
  | GC console (16.7 ms polls) | 634 / 1149 µs | **223 / 258 µs** |
  | GC adapter (1 ms polls) | 725 / 796 µs | **222 / 261 µs** |

  None of these scenarios missed a poll. Irregular polls fall back to stock timing. These figures
  come from a model: the real numbers come from `gcu.py ab` on the controller.

### Phase 2 on hardware (flashed 2026-11-21, build sha256 16b1dbf1…)
Measured by the firmware itself (input age = button read start → host takes the report), same
firmware, late-latch toggled at runtime:

| Mode / host | Stock timing avg / max | Late-latch avg / max | Reports/s |
|---|---|---|---|
| SInput, Windows HID driver (`gcu.py ab`) | 934 / 2943 µs | **358 / 947 µs** | ~950 |
| Slippi, 1 kHz adapter polling (`tools/slippi_poll_ab.py`) | 1036 / 3021 µs | **388 / 422 µs** | ~935 |

0 late reports in every run.

Findings:
* **WinUSB polls at ~470/s, not 1000/s, unless the reader enables RAW_IO.** Without it, Windows
  hands reads to the host controller one at a time, so with `bInterval` 1 the controller is still
  only polled every 2–3 frames. Late-latch detects that (take interval > 1.3 ms) and keeps stock
  timing, so it does no harm but gives no gain there. Whether Slippi Dolphin reads at 1 kHz on this
  PC is unconfirmed: Dolphin holds the adapter exclusively, so the stats can't be read while it runs.
* **Slippi mode switched there by an app used to break Dolphin** (upstream behaviour). Fixed in 14c:
  Slippi mode is now always the plain adapter, however it was picked.
* The device now names itself "GCU 1" (upstream renamed gcu_r4k → gcu_1; the official Nov image does
  the same). Don't accept the web app's firmware-update prompt unless rolling back.

## Phase 3: Quick Remap on the controller ("Smash-style")
Works in **every** mode and game because it rewrites the firmware mapping, so it applies to Slippi,
Switch, PC, and so on.

1. **Hold Power + Start for 1.5 s.** The power LED pulses purple, a rumble tick confirms, and the
   game sees the controller at rest.
2. **Press the button you want to change.** One tick.
3. **Press the button whose job it should do.** Double tick and green flash. Saved immediately.
   * Example: press Z, then X → Z now jumps. Then press X, then Z → X now grabs (swap done).
   * Pressing the same button twice restores that button to default.
4. **Hold Start for 3 s** → every button goes back to defaults (orange flash).
5. **Tap Power** to leave. It also leaves by itself after 20 s untouched.

Rules: a change is written to **every mode's profile** ("Z acts like X" means the same thing on
Switch, Slippi, and PC). Targets refer to a button's *default* job, so chains and swaps behave
predictably. Trigger clicks carry their analog half along: mapping R to "L" gives light-shield on
L's analog channel, and mapping R to "Z" turns R's analog off. Holding Power alone still shuts down
after 3 s, and a Power + Start hold can't trigger it.

## Phase 4: Desktop tool
`tools/gcu.py` (Python + pyusb, WinUSB, no driver install):
`info` · `stats` (latency numbers live) · `map` (show the current button map) ·
`remap Z X` · `reset` · `mode slippi|switch|sinput` · `ab` (stock-vs-latch A/B on the same firmware) ·
`backup` (dump every settings block; works on official firmware too). Set up with
`.venv` (`pyusb`, `libusb-package`). Tested read-only against the controller on official firmware:
`info` and `backup` work, and techchase commands report "not present" cleanly.
The official web app keeps working for everything else (calibration, RGB, snapback): the fork
doesn't change any settings struct layout.

## Phase 5: Validation
* Builds clean. Host unit test for the remap logic.
* Flash (**after the owner OKs it**), then run through: every button in every mode, Quick Remap
  flow, reset-all, shutdown hold, ZL+Start recovery, webapp still connects.
* Latency: `gcu.py stats` stock vs fork, in Slippi mode and SInput mode. Optional cross-check with
  the Lossless adapter's Slippi lag tester.

## Phase 6: techchase app (the UI)
Until now the UI was Quick Remap on the controller plus the `gcu.py` command line. This phase adds
the graphical app. It can start right after Phase 5's hand tests, because the protocol it needs
(`0xC0` commands) already exists and works.

* **Form:** one web page using WebUSB, like HHL's own web app.
  * Runs in Chrome or Edge on Windows, Mac and Linux, and in **Chrome on Android**, so the
    controller can be set up at a venue with a phone and a USB-C cable.
  * No install. Hosted on GitHub Pages from the fork, or opened locally.
* **Controls screen, modelled on Smash Ultimate's:**
  * A picture of the controller. Tap a button, then pick its job from a list.
  * Labels can show GameCube names (A, B, X, Z, L…) or Smash actions (Attack, Special, Jump,
    Grab, Shield).
  * Shows what each button does in each mode.
  * "Reset this button" and "Reset all".
  * Changes save to the controller at once, the same as Quick Remap.
* **Profiles:** named button layouts (for example "Ultimate – Wolf" and "Melee – Falco"). Save,
  load, and export/import as a file. *Firmware work:* store several layouts and switch between
  them on the controller (a Quick Remap gesture picks the slot, with an LED colour for each).
* **Latency panel:** live input age, polls per second, mode, late-latch on/off, and a one-click
  A/B test. It shows the last session's numbers from the Switch 2 too (see 7a).
* **Device panel:** firmware version, default mode on plug-in, settings backup/restore,
  rollback steps.
* HHL's web app stays available for calibration and RGB until Phase 9 brings stick setup in.

### Phase 6 status (first version built 2026-11-21)
`tools/app/` holds a single page with no build step. Start it with `python tools/app/serve.py`,
which serves it on `http://127.0.0.1:8473` and opens it in Chrome. `serve.py --demo` runs it
without a controller.

* `gcu-protocol.js` speaks the controller's protocol over WebUSB. The page and the tests both use
  it.
* **Controls:** a clickable GCU picture and a list of buttons with their jobs.
  * Picking a button opens a grid of jobs, labelled with Smash actions or GameCube names.
  * Each job also shows the Switch equivalent.
  * Remapped buttons are marked on the picture. Power, the sticks and the analog triggers are
    greyed out.
  * Reset all, plus Quick Remap help.
* **Profiles:** kept in the browser, by button name. Save, load, export and import, plus a
  built-in "Default". The profile that matches the controller is marked. Loading a profile
  resets the buttons, then replays the remaps.
* **Latency:** a live view, the late-latch switch, and a 20 s A/B test.
* **Device:** firmware and mode, mode switching, settings backup, rollback steps.
* Tests:
  * `tests/app/protocol_test.mjs` drives the **real controller** with the app's own module (Node
    WebUSB, `usb` package), then restores the original layout. All 15 checks pass.
  * `tests/app/ui_smoke.mjs` clicks through the demo in headless Chrome over the DevTools
    protocol. All 19 checks pass.
* Not done yet:
  * The WebUSB connect in a real browser needs a person to pick the device in Chrome's chooser.
  * Profile slots switchable on the controller itself (firmware).
  * Hosting on GitHub Pages (the owner pushes).
* **Retheme (2026-11-21):** Dracula, JetBrains Mono (bundled, `tools/app/fonts/`), the `[tc]
  techchase` header, bracketed tabs and toggles, square boxes with one colored border each. Text
  colors were picked for contrast on the Dracula background: 13.4x primary, 7.0x subtle, 5.2x
  muted (Dracula's own comment color is 3.0x, too dim for body text). UI smoke test: 19 of 19.

## Phase 7: Switch 2 latency (wired first)
Findings so far:
* The firmware has a Switch 2 GameCube-controller mode, `core_ns2gc.c`. It copies the retail
  NSO GameCube controller and **reports every 4 ms**.
* Switch Pro mode reports on an 8/8/9 ms pattern.
* Late-latch only runs when a report goes out every 1 ms frame, so it's **off in both of these**
  today.

| # | Change | Why |
|---|---|---|
| 7a | **Session stats that survive unplugging.** Save a small stats record to flash when the host disconnects; it's written only after play ends, so it can't stall a report. Read it afterwards on the PC (`gcu.py stats --last`, plus the app). | The Switch 2 (and Dolphin, see 8d) can't be measured while it holds the controller. |
| 7b | **Late-latch for 4 ms and 8/8/9 ms paces.** Learn the console's poll phase as on PC, then start the read just before the poll of the frame that sends. | Input age at hand-off drops from up to a frame (plus a stale read) to about 0.35 ms, as on PC. |
| 7c | **Test faster reports in Switch 2 GC mode.** The game reads input once per 16.7 ms frame. With a report every 4 ms, the newest report is about 2 ms old on average by then; at 1 ms it would be about 0.5 ms. Try a 1 ms report rate on the console, check stability over long sessions, and ship it only as an option if it's solid. | The biggest remaining wired gain on Switch 2. Retail-style 4 ms stays the default. |
| 7d | **Choose the default Switch 2 mode.** Compare GC mode against Pro mode with 7a's stats, and make the faster one the plug-in default when the host is a Switch 2. | Nothing to set up at a venue. |

## Phase 8: PC: OpenSmash and Slippi Dolphin
* **8a SInput through SDL3** (OpenSmash's gamepad path): measured 934 → 358 µs. Check that SDL's
  HID read and OpenSmash's input thread add no buffering of their own.
* **8b OpenSmash's own adapter and Switch 2 reader** (`corneria/runtime/hle_padusb.c`): it reads
  WinUSB pipes without RAW_IO. On this PC that measured **about 470 reads/s instead of 1000** for
  a `bInterval`-1 endpoint. Switch on RAW_IO and keep several overlapped reads queued. This change
  goes in the Corneria repo, not the firmware.
* **8c Game-side hand-off:** measure when the game samples the pad against when the newest
  report arrived. Make sure `padusb_poll` hands over the newest report with no extra frame of
  queueing.
* **8d Slippi Dolphin:**
  * Find out whether it reads the adapter with RAW_IO (if not, it polls at about 470/s and
    late-latch falls back to stock timing). If it doesn't, document that and propose the fix
    upstream.
  * Measure in-game with 7a's session stats, with Slippi mode picked **on the controller** (the
    app-switched mode adds an interface that Dolphin mis-reads; see Phase 2 findings).

## Phase 9: Phob parity: measurement, sticks, buttons
* **End-to-end comparison** against the owner's Phob, which is played through the Lossless
  adapter:
  * (a) Find out what the Lossless adapter's "Slippi lag tester" program measures, and whether it
    can test both setups.
  * (b) Film button press and screen with a 240 fps phone camera, many presses per setup. It's
    coarse, but averages compare the whole chain.
  * (c) Optional: a $5 Pico rig that presses a button electrically, for exact numbers. This one
    needs soldering, so the owner decides.
* **Stick delay audit:** low-pass snapback filters add delay. Measure the delay the snapback,
  deadzone and scaling stages add at the 2 kHz rate, compare it with Phob's smart snapback, and
  offer a low-delay "Phob-like" preset. Stick sample rate and feel stay the same by default.
* **Buttons:** no debounce code was found in the input path, so presses aren't delayed there.
  Still verify matrix chatter and ghosting at the 4 µs settle time (2d).
* **Melee stick accuracy:** notch calibration on par with Phob (8 main directions plus modder
  notches), verified in GTS through Dolphin the same way the Phob was checked.
* **Triggers:** analog range for light shield, and the mechanical-trigger option.

## Phase 10: Bluetooth (secondary)
* Measure first with 7a's stats: Switch 2 over BLE (`ns2_ble.c`), Switch 1 Pro over classic
  Bluetooth, and PC.
* Over Bluetooth a report goes RP2040 → ESP32 → air, at the link's next connection event. The
  console picks the interval. Late-latch here means timing the read just before that event, which
  needs timing from the ESP32's firmware (separate, untouched so far). Stretch goal.
* Tournament advice stays **wired**. A Phob is wired-only too.

## Phase 11: Tournament readiness
* **Ruleset audit:** check every feature against the current Melee controller ruleset and the
  common Ultimate rules. Quick Remap is one-to-one, with no macros or turbo. Look again at analog
  processing options and digital-to-analog trigger mappings. Add a "tournament lock" that turns off
  anything questionable and shows it with an LED colour.
* **Reliability:** multi-hour soak tests on each platform, hot-plugging, no settings loss, and no
  disconnects while a flash write is pending.
* **Venue setup:** the right default mode on plug-in (Switch 2 vs PC), one-glance LED feedback
  for the mode, and a one-page guide.

## Phase 12: techchase rewrite (repo, rules, desktop app)
Turns the working folder into a project other people can build, read and trust. Runs alongside
Phase 7; nothing here changes how the controller behaves.

* [x] **12a Repo.** Public `moontourist/techchase`. The firmware changes are kept as patches
  against pinned upstream commits (`firmware/UPSTREAM`, `firmware/patches/`), with
  `firmware/export-patches.sh` to write them from the working checkout and
  `firmware/apply-patches.sh` to rebuild one from scratch. The settings backups and HHL's official
  images stay out of the repo.
* [x] **12b Names.** Every "Tourney" name this project added is now techchase: the protocol ID
  (`WEBUSB_ID_TECHCHASE`, still `0xC0`), the `TC_CMD_*` commands, the app, the tools. The protocol
  bytes didn't change, so the firmware on the controller needs no reflash for this.
* [x] **12c Theme.** Dracula, see Phase 6 status. Nord since 14f.
* [ ] **12d Code audit.** Hold every file this project wrote to `CONTRIBUTING.md`: unexplained
  casts, unchecked buffer indexes in the WebUSB handler, Python errors that print a traceback to a
  player. Comments are done: on 2026-11-21 every comment this project wrote was removed (HHL's own
  comments in upstream files stay), and the rule is now no comments in code.
* [ ] **12e Lint and format, warnings as errors.**
  * C (only the files this project owns or changed): `-Wall -Wextra -Wconversion -Wsign-conversion
    -Werror`, plus `clang-format` with a checked-in style. Upstream files keep upstream flags.
  * JavaScript: ESLint (flat config) with `no-unused-vars`, `eqeqeq`, `no-floating-promises`
    through type-aware checking of JSDoc types, and a formatter.
  * Python: `ruff check`, `ruff format`, `mypy --strict` on `tools/`.
  * A contrast test that reads `style.css` and fails when a text color drops under its floor.
* [ ] **12f CI.** GitHub Actions on every push: apply the patches and build `gcu_1` with the Pico
  SDK, run the latch simulation, the UI smoke test in headless Chrome, and the linters. Tagged
  releases attach the `.uf2`.
* [ ] **12g Desktop app.** One app for the GC Ultimate and the Phob. Decided: Rust, see Phase 14.
  No installer (owner, 2026-11-21): players download `techchase.exe` from GitHub Releases and run
  it. It must stand alone:
  * Build with the MSVC target (`x86_64-pc-windows-msvc`). The GNU build loads
    `WebView2Loader.dll` from a separate file, so a lone downloaded exe fails to start; the MSVC
    build links the loader in.
  * WebView2 itself ships with Windows 11 and current Windows 10. The README says what to do if
    it's missing.
  * Release workflow (`.github/workflows/release.yml`, 2026-11-21): a `v*` tag that matches the
    version in `tauri.conf.json` runs the Rust tests, builds the exe with MSVC, fails if it needs
    any DLL that doesn't come with Windows (checked with `dumpbin`), and drafts a release with
    `techchase.exe` and its SHA-256. The owner checks the draft and publishes it. A manual run
    builds the same exe as a download on the run, with no release. The `.uf2` joins it with 12f.

## Phase 13: Phob configurator (replaces the config ROM in Dolphin)
The owner's PhobGCC (2.0.5 board, firmware 0.29) is set up today by running a config ROM in Dolphin
and watching it through the Lossless adapter, because the Phob's USB port is broken. The goal is a
screen in the techchase desktop app that does the same job with no Dolphin and no ROM.

What's known so far (from PhobGCC-SW, GPL-3.0):
* The RP2040 build turns USB serial on (`pico_enable_stdio_usb`), but `main.cpp` reads nothing from
  it. Settings change only through button combos on the controller.
* So the ROM is a display: it shows what the controller reports while the player does the combos.
  A desktop app reading the same reports through the adapter can do the same.

Steps:
* [ ] **13a Research.**
  * Every combo and setting in PhobGCC-SW `common/`, and how each value shows on the sticks or
    triggers while it's being changed.
  * Which ROM the owner uses and what it draws.
  * Whether HOJA's `rp2040/phob_2` target fits a 2.0.5 board. A Phob running HOJA plus the
    techchase patches would speak this app's protocol directly. That's an option for other
    players only: the owner keeps PhobGCC.
* [x] **13b Read the Phob.** Done in the desktop app 2026-11-21 (14e). Poll it through the GameCube adapter (Lossless or official, WinUSB,
  RAW_IO, like `tools/slippi_poll_ab.py`) from the desktop app. Dolphin must be closed while it
  runs.
* [ ] **13c Guided setup.** Built as 14e, inside the live view.
  * [x] Live stick and trigger view with the Melee notches overlaid.
  * [x] Step-by-step calibration that prompts each combo (14e).
  * [x] Snapback (2026-11-21): the snapback tuner. It measures each release, reads the settings
    back from L + Start's 2 s display (snapback on the main stick, smoothing on the c-stick,
    waveshaping on the triggers, each 127 plus the value), and reads each A + X or A + Y plus
    D-pad change from the c-stick's 0.75 s display. The Phob's range is -10 to 10, standard 4: 0
    turns the filter off, and minus values switch to a low-pass that gets stronger toward -10.
    Every change needs safe mode off.
  * [ ] Smoothing, waveshaping and trigger settings, decoded the same way (their displays are
    known: smoothing on the c-stick after R + X or R + Y plus D-pad, waveshaping on the c-stick
    after L + X or L + Y plus D-pad).
  * A check of the result against the coordinates GTS shows.
  * The app reads and guides. It can't send settings through an adapter, which only passes polls
    and rumble.
* [ ] **13d Two-way settings (stretch).** For Phobs whose USB works: a small serial command set
  (read and write settings) proposed upstream to PhobGCC-SW as a pull request, so players don't
  need a fork.
* [ ] **13e Phob input lag.** The mission covers the Phob's lag too, not only its setup.
  * Measure when a Phob reads its sticks and buttons relative to the console's poll (PhobGCC
    source, then a logic analyzer or the Pico rig from Phase 9 on the joybus line).
  * If reads land early, a late-latch for PhobGCC (the joybus version of `latch.c`, which a
    console's steady poll suits well) goes upstream to PhobGCC-SW as a pull request, under its
    GPL-3.0.
  * Testing needs a Phob that can be flashed: the owner's needs its USB port repaired first.
* [ ] **13f License check.** Talking to a Phob needs none of its code. Any PhobGCC code copied in
  (for example, its notch math) stays GPL-3.0 and goes in its own module. Decide this before
  copying anything.

## Phase 14: Rust conversion
Decided 2026-11-21 after an audit of the app and tools. JavaScript is not slow here: the app's
language has no effect on input lag, because the controller does the timing. Rust wins on what the
app can reach and on how far its code can be trusted.

Audit findings:
* **The browser can't do Phase 13.** Chrome's WebUSB blocks HID devices. The official GameCube
  adapter is one and the Lossless adapter copies it, so a web page can never read a Phob.
* **The browser can't poll fast.** It has no RAW_IO, so 1 kHz polling (the Slippi A/B test) lives in
  Python.
* **The protocol exists three times:** `gcu-protocol.js`, `gcu.py` and part of
  `slippi_poll_ab.py`. Every protocol change is made three times.
* **Parsing trusted the controller.** Map page counts, block chunk lengths and the stats length
  went unchecked (fixed in the JavaScript 2026-11-21). A late reply to a timed-out command can
  still be taken as the next command's reply. Clippy's `indexing_slicing` and the type system turn
  this class of bug into build errors.

Why not C#: no maintained USB library (we'd write Windows bindings by hand), a second UI framework
for Mac, a third app for phones, and the `scadoshi-rust` rules would only be approximated.

### First: the owner's hand test (2026-11-21)
These come before the Rust work, in the current app, so they help players now. The Rust port
carries them over. Each is checked against the mission: 14a to 14c keep a remapped controller
correct and connected at a tournament, and 14d and 14e are the calibration half of it.

* [x] **14a Save to controller.** Built and flashed 2026-11-21 (build 1795296951, protocol 2). UI
  test 36 of 36; protocol test 27 of 27 on the controller; a saved change survives a replug.
  * Found: there's no save button, so the screen gives no sign a change is kept. In fact every
    pick is written to flash at once: `TC_CMD_ASSIGN` calls `settings_commit_blocks()`. There's
    no undo, and every pick is a flash write.
  * Change: a pick applies at once in the controller's memory, so the player can try it (the
    Live tab lights its new job). A bar then shows "2 unsaved changes: Save to controller,
    Discard".
    * Save writes flash once. Discard reloads the saved layout.
    * Unplugging or restarting without saving keeps the saved layout. The app warns before it
      closes or disconnects with changes unsaved.
  * Firmware:
    * `TC_CMD_ASSIGN` and `TC_CMD_RESET_ALL` gain a "don't save" flag.
    * New commands `TC_CMD_SAVE` and `TC_CMD_REVERT`. Revert reloads the input block from
      flash.
    * Protocol version 2. On version 1 firmware the app keeps saving per pick and says so on
      the bar.
  * Profiles and Reset all use the same bar. Quick Remap on the controller keeps saving at once,
    because it has no screen to save from.
  * The Device tab shows "Saved on controller" or the number of unsaved changes.
  * Tests:
    * protocol test: an unsaved change reads back, Revert undoes it, and Save keeps it
    * UI test: the bar appears and clears
    * by hand: a saved change survives a replug
* [x] **14b Dolphin reads a remapped L as A.** Done 2026-11-21.
  * Reported: after L was remapped to X, Slippi Dolphin read L as A.
  * **Not a firmware bug.** `tools/button_check.py` read each physical press from the live report
    and Windows' joystick view together. Windows gets exactly the SInput bits (A 0, X 1, Y 3,
    D-pad 4 to 7, Z 11, L 12, R 13, Start 16; SInput has 32 buttons and no hat). Slippi Dolphin's
    port-1 Standard Controller profile was recorded for another numbering (Start 9, D-pad 12 to
    15): it read A as X, X as A, D-Right as Z, and L and R as D-pad. A remap to X sends X's
    number, which that profile read as A. Its C-stick axes were swapped too.
  * The axes, from SInput's report layout: left stick X and Y, C-stick `Axis Z` (left, right) and
    `Axis Zr` (up, down), left trigger `Axis Xr`, right trigger `Axis Yr`. Up is negative.
  * **Built:**
    * `tools/dolphin_setup.py` finds Slippi Dolphin's and Dolphin's settings and shows each port:
      adapter, or a Standard Controller and what it reads. A DirectInput mapping of the GC
      Ultimate is checked input by input ("Buttons/A is Button 1, the controller's X, should be
      Button 0"). It can rewrite a port to match SInput, after copying `GCPadNew.ini` to a
      timestamped `.bak`, and refuses while Dolphin is open (Dolphin rewrites the file on exit).
    * The app's Device tab shows the same, with a Fix button. `serve.py` serves it at
      `/api/dolphin`; the fix only answers the app's own page (same origin plus a custom header),
      so another website can't change Dolphin's settings. The GitHub Pages copy says the check
      needs `serve.py`.
    * The Device tab recommends Slippi mode with the port on "GameCube Adapter for Wii U" for
      Melee: Dolphin does no mapping there, so remaps can't be misread. The Controls screen says
      remaps happen on the controller, so Dolphin's mapping should stay plain.
  * The owner's port 1 is now on the adapter (Slippi mode works since 14c).
  * Tests: `tests/dolphin_setup_test.py` (19 checks on a throwaway copy, including the backup
    and other ports staying untouched); the UI test checks the Device tab, the fix and that a
    request from another origin is refused.
* [x] **14c Slippi mode keeps dropping in Dolphin.**
  * Reported 2026-11-21: in Slippi mode, Dolphin's adapter keeps switching between polling and
    not polling, so it never settles on a GameCube controller in port 1.
  * **Cause 1, the main one: Dolphin read the wrong endpoint.** When the app or `gcu.py` picked
    Slippi mode, HHL's firmware added the app's config interface after the adapter. Dolphin's
    `AddGCAdapter` (Slippi and mainline alike) keeps the last IN and OUT endpoints in the
    descriptor, whatever their interface or type, so it read the app's bulk endpoint (`0x83`)
    instead of the adapter's (`0x82`). The controller counted 0 adapter reads with Dolphin's
    config window open. Picking Slippi on the controller never had this: no config interface.
    * Listing the config interface first while keeping the adapter as interface 0 was tried:
      Windows rejects it ("Invalid Configuration Descriptor").
    * **Fix:** Slippi mode is always the plain adapter (`usb_hal.c`, rp2040 and nrf52). The app
      and `gcu.py` say so before switching; unplugging brings the controller back to them.
    * `tests/slippi_dolphin_poll.py` now fails when Dolphin's endpoint pick isn't the adapter's.
  * **Cause 2: messages to the app blocked the game's reports.** Each one went through
    `hhl_tusb_webusb_report_send`, which waits up to 256 ms for the app to collect the last one,
    on the loop that also sends the game's reports. The poll test saw 7 reads in a row time out
    at Dolphin's 32 ms after any command. No longer reachable in Slippi mode, but the same wait
    hits SInput games while the app is open and not reading.
    * **Fix:** the USB sink in `webusb.c` never waits. Live reports are skipped while the app is
      behind; replies and block chunks wait in a 48-message queue the task loop sends from. A
      full queue means the app is gone, so the stream stops; the queue clears when a session
      starts or ends.
    * Checked on build 1795301007: poll test 30 s with late-latch on and off, no timeouts,
      longest read 2.9 ms; protocol test, live check and a full backup all pass.
  * Also fixed in the app: after Disconnect, it no longer reconnects by itself when the
    controller re-enumerates.
  * Ruled out: late-latch (stalls were the same on and off), and the controller announcing a
    disconnect (every report marks port 1 plugged in after a 150 ms settle).
  * Flashed 2026-11-21 (build 1795303483): poll test passes (30 s, no timeouts, longest read 2.3 ms),
    and the owner confirmed Dolphin holds port 1 steady.
* [ ] **14d Guided calibration, GC Ultimate.**
  * Found: the Live tab shows how far each notch is off but has no way to fix it.
  * **Research, 2026-11-21 (HHL's `analog.c` and `stick_scaling.c`):**
    * The analog block (block 2, 1024 bytes, packed) holds the four centers (15 bits each, after
      an invert bit) at byte 2, then 16 notch slots per stick (21 bytes each: `in_angle`,
      `out_angle`, `deadzone`, `in_distance`, `out_distance` as floats, then `enabled`) at bytes
      10 and 346.
    * A slot maps the raw angle where the stick sits (`in_angle`) to an ideal direction
      (`out_angle`), and scales distance by `out_distance / in_distance`. Between slots it
      interpolates; `deadzone` is an angular snap (GameCube and Slippi modes cap it at 4°
      on cardinals and zero it on diagonals).
    * `CALIBRATE_START` measures both sticks' centers once, resets every slot's distance and
      the curve, and zeroes the sticks' output; rolling the stick then records the furthest
      distance near each slot. `CALIBRATE_STOP` applies it and marks the sticks calibrated.
    * `CAPTURE_JOYSTICK_LEFT`/`RIGHT` return the raw angle and distance (centered) on demand.
    * Writing a block over USB (32-byte chunks, then an end chunk) changes the live settings and
      re-runs the stick setup at once; nothing reaches flash until a save.
  * **So the wizard needs no firmware change**, and skips the rim roll: a notch's raw angle and
    distance, captured with the stick held in it, are exactly that slot's `in_angle` and
    `in_distance`, so the notch reads as the ideal direction at full distance.
  * **Built (app):** a Calibrate button for each stick on the Live tab.
    1. The analog block is backed up.
    2. **Center:** "Let go of both sticks." Once both read still and near center, start and stop
       calibration 0.2 s apart, then write the old block back with only the new centers, so the
       old notches and curve stay while the wizard runs.
    3. **Notches:** a picture marks the next notch; holding still for a quarter second (within
       1° and 20 counts) captures it. A hold short of the rim or in the wrong notch is refused
       with the reason. Back redoes one.
    4. The eight notches are written as slots 0 to 7 (deadzone and output distance carried
       over); extra slots are turned off.
    5. **Check:** the Live tab's notch check, and each notch can be turned half a degree at a
       time, written live.
    6. The save bar says "Stick calibration not saved": **Save to controller** writes flash
       once (with any remaps); **Discard** or Cancel writes the backup back. Needs protocol 2.
    * On connect, if the controller says its sticks were never calibrated, the Live tab says so.
  * Not done yet: offering calibration when the notch check finds a notch more than one unit off,
    and snapback, deadzone and trigger setup (later).
  * Tests: `tests/app/calibration_test.mjs` (22 checks of the block layout and math); the UI test
    runs the wizard on the demo controller (center, a refused wrong notch, eight notches, a turn,
    save; and a cancel that restores the block byte for byte); the protocol test reads the
    block, captures both sticks and writes the block back unchanged.
  * Left: the protocol test on the controller, then the owner's run by hand, checked against GTS
    (15c) and surviving a replug.
* [ ] **14e Guided calibration, Phob.** Started 2026-11-21, after the owner called the GC Ultimate side
  done for now ("it can pretty much do everything the main firmware can do, but a little better").
  * Built:
    * The desktop app reads a GameCube adapter (`adapter_open`, raw reports batched every 8 ms,
      1000 a second on the Lossless adapter) and feeds the Live view from the chosen port. Stick
      positions count from the first reading after the controller connects, as Dolphin does
      (`PAD_GET_ORIGIN`), with a re-zero button. Tabs that need a GC Ultimate are disabled with
      the reason. Connect falls back to the adapter when no GC Ultimate is plugged in.
    * `phob-track.js` follows the Phob from what it shows: a command freeze (every stick axis at
      255; 2 s, or 4 s when safe mode goes back on), the target on the other stick (127.5 plus
      `calcStickValues`, so about 100 out on a 28 degree sphere), measurement's alternating center
      and rim points in `_calOrder`, then the notch step (rim to rim at the measured angles) and
      the end (the other stick back at center). It flags a point measured with the stick pushed
      or centered when it shouldn't be.
    * `phob-calib.js` is the guide: the five steps, one instruction at a time, the target on a
      gate picture, and in the notch step where the notch lands in Melee coordinates with which
      button to tap (X turns clockwise: the firmware lowers the notch angle).
    * Tests: `tests/app/phob_track_test.mjs` (the Phob's own display formula, a whole run, Z,
      Start, warnings, hints) and `tests/app/phob_ui_test.mjs` (the app with a fake desktop
      bridge playing a whole calibration).
  * Fixed after the owner's first run (2026-11-21):
    * Start was never seen. A + X + Y + L acts the moment the fourth button goes down, and the
      Phob blanks the buttons in the same step, so the adapter never shows all four together.
      Now a 2 s freeze while waiting counts as the start; L or R just before picks the stick,
      else the one the player clicked. It also joins a calibration already under way: each
      measuring target is an exact pair of numbers (drawn at `_notchAngleDefaults`).
    * The gates were drawn on the GC Ultimate's scale (128 out), so a Phob's stick (100 out)
      never reached them. The guide and the live gate now use the Phob's: 100 on the cardinals,
      104 on the diagonals.
    * Clearer wording: one short instruction per step ("Push the stick into the up-right notch.
      Hold it there and press A.", "Tap Y."), and in-between spots named "between up and
      up-left", not "up, left a notch".
  * Left: a full run on the owner's Phob (main stick, then the c-stick), then the rest of 13c.
  * A Phob takes no commands over USB. It calibrates with button combos on the controller (A,
    X, Y plus L or R, then A for each point, then notch adjustment).
  * The app can still follow along:
    * It reads the Phob through the adapter, shows the step the Phob is on, where to put the
      stick and which button to press next, and flags a point captured off target.
    * It then runs the same check as 14d, with adjustment hints in Phob terms ("press X once to
      move up-right toward 0.7000").
  * **Step script, 2026-11-21**, from PhobGCC-doc's `Phob_Calibration_Guide_v0.29.md` and the
    v0.29 tag's `common/stick.h` (GPL-3.0; facts only, no code copied):
    1. **Safe mode off:** the Phob boots in safe mode. AXY+Start, held about 1 s, turns it off
       (the controller freezes 2 s; 4 s when it turns back on). Tap B so the sticks go live.
    2. **Start:** AXY+L calibrates the main stick, AXY+R the c-stick. Calibrating turns
       auto-initialize off.
    3. **Measure, 32 presses** (16 centers, 16 rim points, `_noOfCalibrationPoints`): even
       steps are the center (let go, press A, L or R); odd steps are the rim point the *other*
       stick points to (hold the stick there, press A, L or R). Rim order: 0°, 90°, 180°, 270°,
       45°, 135°, 225°, 315°, then the tertiaries 22.5° to 337.5°. All eight cardinals and
       diagonals are required; a tertiary with no notch is pressed at center and skipped later.
       Z steps back to the previous center; Start skips to notch adjustment with the old points.
       It ends by itself after step 31.
    4. **Notch adjustment, 12 notches** (`_notchAdjOrder`): the four diagonals, then the eight
       tertiaries, skipping inactive ones. X turns clockwise, Y counterclockwise, continuously
       while held (rate depends on loop time, not a fixed step); B resets the notch; A, L or R
       goes on; Z goes back. Passing the last notch saves; the target stick returns to center.
       There's no cancel.
  * **What the app can see:** the target point is on the other stick (about 100 units out at the
    rim, 127 at center). No step number is sent, so the app counts center and rim targets to
    know the step, and checks each held point against the target it asked for.
  * Remapping (14m): 0.29 has no free remap, only six jump swaps (XZ, YZ, LX, LY, RX, RY plus
    Start, each a toggle). **PhobGCC 0.31 added full remapping (B+X+Y)**, replacing the swaps. A
    Phob on 0.31 can be remapped on the controller; the app can guide it like calibration. The
    owner's Phob is on 0.29 and needs its USB port repaired to update.
  * Build: once the Rust USB crate reads the adapter (14i), since a browser can't. This is 13c;
    the two are one step.
* [x] **14f Nord theme.** Move the app and the README from Dracula to Ghostty's Nord theme.
  * Done 2026-11-21. Palette checked against Ghostty's theme file (`ghostty/Nord` in
    iTerm2-Color-Schemes): as listed below, except its bright black is `#596377`.
  * Text: primary `#d8dee9` (9.3x), subtle `#b8c1d1` (6.9x), muted `#9aa3b5` (4.9x); border
    `#6b7589` (2.7x; Nord's `#596377` is 2.07x, under the 2.1x floor). Accents: frost `#88c0d0`
    (headings, buttons), purple `#b48ead`, teal `#8fbcbb`; changed is orange `#d08770`.
  * Every color is a variable now, the controller drawing's included (`--pad-*`); no hex is left
    in a rule. A, B and C keep their GameCube colors in Nord's green, red and yellow.
  * README banner re-rendered, screenshot retaken (the live view). UI test passes.
  * Palette, from Ghostty's bundled `Nord` theme (check against the theme file when building):
    * background `#2e3440`, foreground `#d8dee9`
    * Polar Night `#3b4252` `#434c5e` `#4c566a`
    * Snow Storm `#e5e9f0` `#eceff4`
    * Frost `#8fbcbb` `#88c0d0` `#81a1c1` `#5e81ac`
    * Aurora red `#bf616a`, orange `#d08770`, yellow `#ebcb8b`, green `#a3be8c`, purple
      `#b48ead`
  * App: the CSS variables in `style.css`, the controller picture's colors, the live view (stick
    dots, notch colors, oscilloscope lines), and the button colors (A green, B red, Z purple stay
    as GameCube colors in Nord's shades).
  * README: re-render `assets/logo.png` in Nord with `assets/render.mjs`, and take a new
    screenshot.
  * The controller drawing was redrawn 2026-11-21 from a line drawing of a GameCube controller
    the owner picked: dashed body, wells and seam, solid buttons, the GC Ultimate's extra
    buttons added. Its colors are the `--pad-*` variables in `style.css`, so it changes with the
    theme.
  * `CONTRIBUTING.md`'s theme section moves to Nord, with the same contrast floors. Phase 16's
    Dracula LED preset becomes a Nord preset.
  * Check contrast: Nord's muted gray `#4c566a` on the background is too faint for text, so it
    is used for lines only.

### Rust
* [x] **14g Spike.** A `techchase-core` crate plus a CLI matching `gcu.py`.
  * It passes the same checks as `tests/app/protocol_test.mjs` on the real controller.
  * It polls the controller at about 1 kHz with RAW_IO, trying `nusb` first and `rusb` (libusb)
    second.
  * It opens the Lossless adapter and reads port 1.
  * These are the two things a browser can't do, so the spike proves them before anything else is
    built.
  * **Done so far, 2026-11-21** (`rust/`, a workspace with `techchase-core` and `techchase-cli`,
    binary `tc`; `nusb` 0.2.9, which turns on RAW_IO for every IN endpoint itself):
    * [x] Lossless adapter, port 1, Phob plugged in: `tc adapter` reads **1000 reports a second**,
      none malformed; longest gap 1.14 ms over 5 s, 2.38 ms over 60 s (2 gaps over 2 ms in 60 000).
      `rusb` wasn't needed.
    * [x] Every Phob input came through on a 20 s hand test (1000 a second, longest gap 1.66 ms):
      both sticks to about 100 units out at the rim, analog triggers to 255 with digital L and R
      at full press, A, B, X, Y, Z and Start. The L trigger rests at 5 to 13.
    * [x] Core parsing for the adapter report and the GC Ultimate's protocol (INFO, STATS, MAP,
      REVERT, block chunks, the static block), 15 unit tests.
    * [x] On the GC Ultimate (build 1795303483): `tc info` and `tc map` match `gcu.py`; `tc live`
      gets 125 reports a second, none skipped, longest gap 8.5 ms. The maker string isn't in
      Windows' device list, so `tc` reads it from the device, as `gcu.py` does.
    * [x] `tc check`: 27 of 29 passed and the layout was restored. The two REVERT checks found a
      **firmware bug**: an unsaved change sent within about 20 ms of a save was stored with it
      (probed: 0 ms stored, 20/100/500 ms correct). HHL's profile store writes later
      (`profiles_task`, every 16 ms) from what is live *then*; techchase's no-save remaps
      (protocol 2) didn't allow for that. The JS test was too slow to hit it.
      **Fix, flashed as 1795306334:** `profiles_save` copies the live slices, and
      the deferred write of the active profile uses that copy. A profile switch or a copy into
      the active profile still stores what is live, as HHL's design has it. `tc check` now has a
      check for this: save, then an unsaved change at once, then REVERT.
    * [x] Flashed 1795306334: `tc check` all 31 passed three times running; `protocol_test.mjs`
      passed.
    * [x] **Second firmware bug, found right after:** late-latch stuck off ("learning", lead
      1033 us, guard 225) for 30 s and more, until a replug. Late-latch takes a ready-time sample
      only when it fires, and fires only while the lead is under 950 us. One long ready time
      (likely a save's flash write; the stall filter lets in up to twice the window's max) pushed
      the lead over, and nothing could bring it back. A save during play would have switched
      late-latch off silently. **Fix, flashed as 1795306561:** blocked by the lead alone for
      1 s, the ready-time window is cleared and late-latch tries again. Verified: after each of
      three `tc check` runs (a dozen saves each) late-latch was active again within 2 s, input age
      back to 430-540 us; `protocol_test.mjs` passed. Stats call this state "learning", which is
      wrong; a mode of its own is a follow-up.
    * The config interface can't show 1 kHz: the firmware sends a live report every 8 ms
      (`interval_run(timestamp, 8000, ...)` in `webusb.c`), so `tc live` expects about 125 a
      second. The GC Ultimate's 1 kHz path is Slippi mode, where it is a plain adapter
      (057e:0337) and `tc adapter` reads it like the Lossless.
* [x] **14h Core crate.**
  * Protocol, live report parsing, the Melee math (`tools/app/melee.js` and its tests move over),
    layouts and profiles.
  * Pure, no USB. Newtypes for input codes and units, enums for commands and modes.
  * The `scadoshi-rust` lint set and wave's `rustfmt.toml` and `clippy.toml`, warnings as errors.
  * **Done, 2026-11-21:** `techchase-core` has `adapter`, `gcu` (commands, replies, `LatchMode` and
    `ReportFormat` enums), `codes` (`InputCode`, `GcCode`, `SwCode`), `live` (the three live report
    kinds), `melee` (`FwAxis`, `GcAxis`, `MeleeAxis`, notches; the rim scaling is exact integer
    math, checked against the float formula over the whole stick range), `analog` and `calibration`
    (the wizard's math, `StillDetector`), `layout` and `profile` (the app's profile files). 39 tests;
    the JS tests' cases all carried over. Lints and format are thunk's and seethe's (wave isn't
    on this machine; theirs are the same set), with `missing_docs` off for the no-comments rule.
    `tc check` passes on the controller after the move to the code newtypes.
  * `tests/sim_latch.c` gained a scenario for the late-latch bug: reports slowed step by step to
    the stall filter's limit. Without the retry it ends stuck off (lead 1012 us, guard 200, as the
    controller showed) and exits 1; with it, late-latch is back on.
* [ ] **14i USB crate.** GC Ultimate config interface, GameCube adapter (for the Phob), RAW_IO,
  hot-plug.
  * **Built, 2026-11-21:** `techchase-usb` has `Gcu` (every operation the app uses: info, stats,
    map, assign, save, revert, layouts, the analog block, stick capture), `Adapter` (reads in
    flight, a timestamp on each report), typed errors that name the usual cause (Dolphin or the
    app's tab holding the device), and `hotplug::watch` (present, arrived and left events, with a
    retry for Windows opening a composite device before its interfaces are ready). `tc` runs on it;
    `tc watch` is new. On the controller: `tc check` all passed, `tc info`, `tc stats`, `tc live`
    (125/s, none dropped) and `tc watch` (found and opened it).
  * Each 64-byte live report is followed by an empty packet, which `tc live` counted as an
    "other" packet; the crate now drops empty packets.
  * Checked by hand: `tc live` now shows 0 other packets. During `tc watch`, the GC Ultimate and
    the Lossless were each unplugged and replugged; every removal was seen, and every arrival
    opened (the controller answered INFO, the adapter's reports flowed).
  * Left: a full `tc adapter` run on the new crate to confirm the 1000/s rate.
* [ ] **14j Desktop app.** Tauri 2. The current screens (HTML, CSS, JavaScript) move over as they
  are and call the Rust core instead of WebUSB.
  * A single downloadable exe for Windows, no installer (12g). Mac later, as a plain app bundle.
  * One app finds both the GC Ultimate and a Phob on an adapter.
  * **Started 2026-11-21:** `rust/techchase-app` opens `tools/app` in its own window. A small shim
    (`tauri-usb.js`) gives the screens the WebUSB calls they use, backed by `techchase-usb`; the
    Rust side streams each packet to the window and sends hot-plug events, so the screens are
    unchanged. The Dolphin check moved to `techchase-core::dolphin` (its Python tests carried
    over) and the Dolphin tab calls it, so the app needs no local server.
  * Left: release builds with the MSVC toolchain (12g; it also ends the GNU linker's warning about
    merging two Windows manifests).
* [ ] **14k Web build.** The core compiled to WebAssembly for the GitHub Pages version, which stays
  for setting up a GC Ultimate from a phone at a venue.
* [ ] **14l Retire the copies.** Delete the JavaScript protocol module and the Python tools once the
  Rust CLI and the WebAssembly build cover them. The test suites move to `cargo test` plus the UI
  smoke test.
* [ ] **14m Phob parity.** Asked for 2026-11-21: a player connects a Phob and sets it up just as
  they set up a GC Ultimate, in the same app. This comes after the Rust rebuild because only the
  desktop app can read a Phob (through a GameCube adapter, 14i). Phase 13 and 14e are its first
  parts; this step is the rest, feature by feature.
  * The app knows which controller it has (GC Ultimate over its own USB, or a controller on an
    adapter port) and shows each feature that works for it. A feature that can't work says why,
    in one line, instead of disappearing.
  * Feature by feature, the GC Ultimate's way and the Phob's:
    * **Live view and notch check:** the same screens, fed by adapter polls (13b).
    * **Calibration:** the Phob's own button combos, guided step by step (14e), then the same
      check and the same GTS comparison (15c).
    * **Snapback, smoothing, triggers:** guided combos with each value decoded from the reports
      (13c).
    * **Latency:** measured the same way, and a joybus late-latch if the Phob reads early (13e).
    * **Dolphin check:** the same; a Phob on an adapter wants the adapter port setting.
    * **Profiles:** the Phob keeps its settings itself, so the app saves a record of them (read
      during the guided steps) that a player can follow to set the Phob up again.
    * **Remapping:** may not be possible. Remapping is a firmware feature, and PhobGCC changes
      settings only through combos. To find out in 13a: which swaps or options PhobGCC's combos
      offer at all. Routes, most practical first:
      1. whatever PhobGCC itself offers, guided like the other combos
      2. remap support proposed upstream to PhobGCC-SW, alongside the serial settings of 13d
      3. HOJA with the techchase patches on the Phob (13a's `phob_2` check), which brings every
         GC Ultimate feature, for players willing to change firmware
      4. remapping in software (a Dolphin Standard Controller profile), which works in Dolphin
         only and not on a console, so the app says so
  * Done when a Phob owner can go through the same tabs as a GC Ultimate owner, with each
    difference explained on screen.
* Later, not now: rewriting the screens themselves in Rust (Dioxus, as scadoshi's `orangui` uses).
  It's worth it only if the JavaScript UI starts to hurt.

## Phase 15: UI revamp, live controller view
The app's home screen shows the controller live, the way GTS's controller test does in Dolphin, so
calibration and checking happen in one place with no ROM. The same screens serve the GC Ultimate
and, through Phase 13's adapter reading, the Phob.

Reference: GTS's "Controller Test" and "Stick Oscilloscope" screens. On 2026-11-08 they were used to
check the owner's Phob after calibration (eight notches read as Raw XY and Melee coordinates, such
as up-right (76, 73) = (0.7125, 0.6875)).

* [x] **15a Live report (firmware).** A new WebUSB report, `WEBUSB_INPUT_TECHCHASE` (253), about 125
  a second while the app is connected:
  * both sticks as the game gets them (after snapback and deadzone), at full 12-bit precision
  * both sticks calibrated but before snapback and deadzone, to show what the filter does
  * every physical press, both analog triggers, and a counter to spot dropped reports

  HHL's own reports only had sticks (254) or every input cut to 7 bits (255). The app falls back
  to 255 on firmware without 253 and says the view is coarse.
  Flashed 2026-11-21 (build 1795295052, sha256 47899d44...). On hardware: 125 reports a second at
  full precision, none dropped, sticks read (0, 0) at rest (`tests/app/live_check.mjs`). The
  protocol test passes 15 of 15 on the same build.
* [x] **15b Live tab (app), the new first tab.**
  * Main stick and C-stick:
    * the gate, Melee's unit circle and deadzone, notch rays
    * a short trail, and dots for the position before and after the filter
    * readouts: raw XY in GameCube units, Melee coordinates, and the value before filtering
  * Triggers as 0 to 255 bars with the full-press click, and GameCube buttons that light up. A
    remapped button lights its new job, and the pressed list shows "ZR → X".
  * **Notch check** for each stick. Hold the stick still at the rim for 0.25 s and the notch is
    recorded (raw, Melee, and how far it is from 1.0000 or 0.7000). Measured notches redraw the
    gate.
  * **Snapback oscilloscope:** one axis over 2.5 s, with Melee's ±23 deadzone lines, before and
    after the filter.
  * `melee.js` holds the GameCube and Melee math. `tests/app/melee_test.mjs` checks it against all
    nine GTS readings from the owner's Phob (all pass).
  * The demo controller replays those notches with snapback wobble.
  * UI smoke test: 28 of 28.
* [ ] **15c Against GTS.** Compare the live view with GTS on the same controller and notch. Raw XY
  must match in Slippi mode.
* [ ] **15d Guided GC Ultimate calibration in the live view.** Moved up to 14d.
* [ ] **15e The Phob in the same view.** Once Phase 13 reads a Phob through the adapter, it feeds
  this view, and 14e's guided calibration runs here.
* [ ] **15f More GTS tools.** Trigger oscilloscope, button timing (press to release, for
  double-press checks), a 2D plot that records a whole stick sweep, and export of a calibration
  report.
* [ ] **15g Polish.** A first-run walkthrough, a phone layout for venue setup, keyboard use, and
  contrast checks (CONTRIBUTING.md).
* [ ] **15h Controls picture from the owner's outline.** Asked for 2026-11-21: the Controls tab draws
  the controller from the owner's transparent line drawing (500 x 391, the stray page number removed)
  in GameCube colors, and buttons light up as they are pressed, the way GTS's controller test does.
  * The drawing is redrawn as vectors (`tools/app/controller-outline.svg`), so it stays sharp at
    any size: each dash of the 500 px original is found, the dashes are linked into smooth curves
    and drawn with the same dash pattern. The D-pad cross and the solid A, B, X and Y rings come
    from the fitted shapes. It takes the theme's line color through `currentColor`.
  * Colored shapes sit under it, fitted to the drawing: A, B and the sticks by circle fits, X and Y
    traced from their outlines, the d-pad, Start, and L, R and Z from the shoulder curves measured
    column by column. GameCube colors: A green, B red, X and Y light grey, Z purple, C-stick
    yellow.
  * The drawing has no place for ZL, Minus, Home, Capture or Power, so they sit in a row under it.
    L also lights for the analog LT, R for RT.
  * Lighting comes from the live report the app already streams (`presses`), at most once a frame.
  * Built 2026-11-21 and checked in the demo (screenshots). Left: check it on the controller by
    pressing every button.
* [ ] **15i Owner's notes from the first desktop run (2026-11-21).**
  * [ ] **Damaged sticks.** After recalibrating, the sticks went haywire. The analog block read
    back with bytes 682 to 695 (both sticks' deadzones, outer deadzones, snapback types and
    strengths) holding the firmware's default spring numbers (`_spring_default_a1[1..4]`, whose
    own place is 704 on); the notches, centers and curve were sane. What wrote them there is not
    found yet: the app only writes whole blocks and profiles stop before the springs. Saved as
    `backups/sticks-after-recalibration-2026-11-21.bin`. The owner's sticks were put back from the
    settings saved before the tourney flash (not saved to the controller yet).
    Hardening while the cause is open: the settings reader refuses a block whose chunks arrive out
    of order or that is not 1024 bytes, keeps packets that arrive before their reply is awaited
    (with packets already queued, the old reader lost chunks: `tests/app/transport_test.mjs`), and
    a block of the wrong size is never written. Left: find the writer.
  * [x] **Reset sticks to factory.** A button under the live view, and `tc sticks --reset`: both
    sticks get the firmware's shipped notches, deadzones (144, outer 72), snapback (Auto, 600) and
    curve, with centers measured again. It works at once and stays unsaved until Save. The app
    also says when the stick settings look damaged. `tc sticks` shows, backs up and restores them.
  * [ ] **Calibrate needs two clicks.** Not reproduced yet. Lost chunks (above) would fail the
    first try's settings read, so check it again on the controller with this build.
  * [x] **Trails.** The trail kept the last 45 reports, about a third of a second at 125 a second.
    It now keeps 0.6 s and fades out.
  * [x] **Sharper picture** (see 15h) and **theme:** Nord-toned GameCube colors, the press glow in
    the frost accent instead of white, the app's font weight, and the D-pad arrows and the Home,
    Capture, Minus and Power icons drawn as shapes (the font has no such symbols).
* [x] **15j Snapback calibration.** Asked for 2026-11-21. Built the same day as the snapback tuner,
  shared with the Phob (13c): flick and let go, and each direction's worst swing past center is
  measured before and after the filter and graded against Melee's deadzone (0.2875, 23 units;
  0.2 is "close"). On the GC Ultimate the tuner sets the filter in one click (Auto, low-pass 30 to
  150 Hz, off), held until Save like a calibration. Advice: off, turn on Auto; Auto not catching
  it, low-pass 60 Hz; low-pass, 15 Hz lower each time. Left: fitting the spring model from the
  app (the firmware's capture stream is there; HHL's web app does it today). The original ask: Measure each stick's snapback (release
  from the rim, the way the snapback oscilloscope does) and set the filter from what the Melee and
  Smash community knows about it: the firmware already has the low-pass and Auto filters and a
  per-stick spring model (`snapbackSpringCfg_s`, fitted per octant). The live report carries the
  stick before and after the filter, so the app can show the result.

## Phase 16: GC Ultimate LED colors
The GC Ultimate has 12 RGB LEDs in 6 groups: the left stick ring, A, B, X, Y, and the Power
notification LED. HOJA keeps their setup in the RGB settings block (`rgbConfig_s`: mode, speed,
32 packed colors, brightness 0 to 4096, idle glow). HHL's web app edits it; techchase should too,
so players don't need two apps.

Modes in the firmware: authentic (era colors that follow remaps), static, rainbow, react, fairy,
and idle. Breathe is reserved and not wired up yet.

* [ ] **16a Research.**
  * The exact layout of `rgb_colors[]` for the GCU's groups.
  * How a write takes effect: `WEBUSB_ID_WRITE_CONFIG_BLOCK`, then `RGB_CMD_REFRESH`.
  * How the firmware's own status colors take over the LEDs (Quick Remap's purple pulse, mode
    colors, the shutdown animation), so a user color never hides a status.
* [ ] **16b LED screen.**
  * The controller picture with each LED group clickable, a color picker, and brightness, mode and
    speed.
  * A live preview on the controller while editing, then save.
  * Read and write go through the same block path as the settings backup.
* [ ] **16c Presets.** Nord (the app's palette), indigo GameCube, era-authentic, all off.
  Presets are saved with profiles, so a profile can carry its colors.
* [ ] **16d Tournament check.** A one-click "venue" setting: low brightness or off, no animations
  that could distract the opponent. Status colors stay readable. Ties into Phase 11's tournament
  lock.
* [ ] **16e Phob.** A Phob has no RGB, so this phase is GC Ultimate only. The mission's "both
  controllers" rule is met by saying so.

## Rollback
Hold ZL + Start while plugging in, then drag `official/gcu_r4k/gcu_r4k.uf2` onto the drive (or use
the official web app's firmware page).

How this was verified: the HOJA bootloader (`bootloader/boot_main.c`) never rewrites itself. It
exposes a UF2 drive (MSC) in update mode, and it opens update mode when no valid firmware is
present. The ZL+Start check runs in the firmware's `boot_init` (`utilities/boot.c`) as soon as the
buttons are read, before any core, transport or task loop starts, so none of the fork's changes
run ahead of it. Last resort if even that fails: the RP2040's ROM BOOTSEL mode (needs the board's
BOOTSEL pad, which means opening the shell).

Settings backup taken before flashing: `backups/official-settings-before-tourney.json`
(the controller was on official firmware 1775602106, 2026-04-07. The fork is based on upstream
main from 2026-11, so flashing also brings it up to the current upstream base).
