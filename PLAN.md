# [tc] techchase: plan

techchase is tournament firmware and a setup app for the Hand Held Legend GC Ultimate: a fork of
HHL's HOJA firmware, public at `github.com/moontourist/techchase`. Working name before 2026-11-21:
"GCU Tourney". HHL's own firmware has a feature called tourney mode (`macro_tourney.c`), which
this project leaves alone and never renames.

Target hardware: **Hand Held Legend GC Ultimate, revision R4K** (USB product string `GCU-R4K`,
FCC ID 2BM3E-GCU-R4K). Upstream firmware target: `hoja-device-fw/rp2040/gcu_1`.

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
  choices), in the **Dracula** palette, the nearest match to the indigo GameCube controller. Purple
  title, pink `tc`, JetBrains Mono.
* **Repo:** public, README in the thunk/seethe/wave format (banner, what it does, install,
  controls, how it's built, develop, roadmap, credits).
* **Code rules:** the `scadoshi-rust` rules (from scadoshi's zwipe, as copied into wave, thunk and
  seethe), applied to C, JavaScript and Python. Written out in `CONTRIBUTING.md`. In short:
  * no panics outside tests (no `assert`/`abort` in firmware paths, no unhandled throw or
    rejection in the app, no bare `except` or traceback for a user error in the tools)
  * no unchecked casts or indexing: every narrowing cast and every buffer index is range-checked or
    carries a comment saying why it can't go wrong
  * every lint exception explained, on the narrowest line it can be
  * comments say what the code does, in the present tense, with no history and no em dashes
  * one-line commit messages, no emoji, no AI signatures
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
* **Slippi mode switched there by an app (this tool or HHL's web app) doesn't work in Dolphin.**
  The config interface added beside the adapter makes Dolphin's endpoint scan pick the wrong IN
  endpoint (0 reports in Dolphin, even in-game). This is upstream behaviour. Selecting Slippi mode on
  the controller itself (no config interface) is what's used for play.
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
* [x] **12c Theme.** Dracula, see Phase 6 status.
* [ ] **12d Code audit.** Hold every file this project wrote to `CONTRIBUTING.md`: comments that
  tell history ("techchase: 15 -> 4 us per row"), unexplained casts, unchecked buffer indexes in the
  WebUSB handler, Python errors that print a traceback to a player.
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
* [ ] **12g Desktop app.** One installable app for the GC Ultimate now and the Phob later
  (Phase 13).
  * Recommendation: **Rust + Tauri 2** around the existing web UI.
    * Rust talks USB directly (`nusb` or `rusb` with RAW_IO), so there's no 470 reads/s WinUSB cap
      and no Chrome device chooser. It can also reach a GameCube adapter, which a browser can't
      do well and Phase 13 needs.
    * The `scadoshi-rust` rules then apply word for word: copy wave's `rustfmt.toml`,
      `clippy.toml` and lint set.
    * The HTML/CSS/JS screens move over as they are.
  * The browser version stays, on GitHub Pages, for setting up at a venue from a phone.
  * `gcu.py` stays as a test tool until the app's CLI covers it.

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
* [ ] **13b Read the Phob.** Poll it through the GameCube adapter (Lossless or official, WinUSB,
  RAW_IO, like `tools/slippi_poll_ab.py`) from the desktop app. Dolphin must be closed while it
  runs.
* [ ] **13c Guided setup.**
  * Live stick and trigger view with the Melee notches overlaid.
  * Step-by-step calibration that prompts each combo.
  * Snapback, smoothing and trigger settings, with each value decoded from the reports.
  * A check of the result against the coordinates GTS shows.
  * The app reads and guides. It can't send settings through an adapter, which only passes polls
    and rumble.
* [ ] **13d Two-way settings (stretch).** For Phobs whose USB works: a small serial command set
  (read and write settings) proposed upstream to PhobGCC-SW as a pull request, so players don't
  need a fork.
* [ ] **13e License check.** Talking to a Phob needs none of its code. Any PhobGCC code copied in
  (for example, its notch math) stays GPL-3.0 and goes in its own module. Decide this before
  copying anything.

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
