# Code rules

techchase follows the `scadoshi-rust` rules, the audit rules thunk, seethe and wave use (from
scadoshi's zwipe). They were written for Rust; this file says what each one means in the C,
JavaScript and Python here. The Rust crates in `rust/` take `rustfmt.toml`, `clippy.toml` and the
lint set from thunk and seethe word for word, with one change: `missing_docs` is off, because the
code carries no comments (below). `cargo clippy --workspace --all-targets -- -D warnings` must pass,
and `cargo +nightly fmt` formats.

Every rule applies to code this project writes or changes. HHL's upstream code is left in its own
style, so the patches stay small and rebase cleanly.

## No panics outside tests

Tests may fail loudly: a failed check is how a test fails. Everywhere else:

- **C (firmware):** no `assert`, `abort`, `panic` or busy-wait that never ends on a path a player
  can reach. Bad input from USB is dropped or answered with an error byte, never trusted.
- **JavaScript (app):** every `async` call is awaited inside a handler that catches and shows the
  error in the toast. No floating promises.
- **Python (tools):** a player error (no controller, wrong firmware, Dolphin holding the device)
  prints one line and exits non-zero. No traceback, no bare `except:`.

## No unchecked casts or indexing

- A narrowing cast (`(uint8_t)x`, `x | 0`, `int(x)`) is range-checked first, or carries a comment
  saying why it can't go out of range.
- A buffer index from outside (a USB packet, a file, a URL parameter) is checked against the
  buffer's length before it's used. Fixed-size reads in the WebUSB handler check `size` first.
- Arithmetic on timestamps uses unsigned wraparound on purpose, and says so where it matters.

## Warnings are errors

- **C:** the files this project owns build clean with `-Wall -Wextra`. PLAN.md 12e adds
  `-Wconversion -Wsign-conversion -Werror` for them.
- **JavaScript and Python:** ESLint and `ruff` come in with 12e. Until then, `node --check` and
  `python -m py_compile` pass on every file.

## Every lint exception is explained

A suppression sits on the narrowest line it can, with the reason on the same line. For example:

```js
// eslint-disable-next-line no-await-in-loop -- commands must reach the controller in order
```
```python
import gcu  # noqa: E402  the path to tools/ is added just above
```

## No comments

The code carries no comments. Names, small functions and tests say what it does. A unit, range or
format goes in the name (`age_us`, `lt12`). The reason for a change goes in its commit message, and
the plan and measurements go in PLAN.md.

- The one exception is a lint suppression, which needs its reason on the same line (above).
- HHL's own comments in upstream files stay as they are. `firmware/patches/` shows every line this
  project changed there.
- No em dashes in prose. Use a sentence, a colon or a comma. American spelling.

## Theme

The app's colors are CSS variables in `tools/app/style.css`, from the Nord palette as Ghostty
ships it (`ghostty/Nord` in iTerm2-Color-Schemes). Text must stay readable against `--bg-primary`
(`#2e3440`):

| Variable | Contrast | Floor |
|---|---|---|
| `--text-primary` | 9.3x | 7.0x (WCAG AAA) |
| `--text-subtle` | 6.9x | 6.0x |
| `--text-muted` | 4.9x | 4.5x (WCAG AA) |
| `--border-primary` | 2.7x | 2.1x |

Nord's own grays (`#4c566a`, `#596377`) are under the floors, so they're used for lines and fills
only; muted text and the primary border are Nord-toned grays lightened to pass. The controller
drawing's colors are `--pad-*` variables.

New colors go in as variables, never as hex values in a rule.

## Commits

- One line, saying what changed. Multi-line only when there are many changes.
- Related files go together. No emoji.
- Run the checks in the README's Develop section before pushing.
