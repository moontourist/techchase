# Code rules

techchase follows the `scadoshi-rust` rules, the audit rules thunk, seethe and wave use (from
scadoshi's zwipe). They were written for Rust; this file says what each one means in the C,
JavaScript and Python here. When the desktop app moves to Rust (PLAN.md, 12g), its crates take
`rustfmt.toml`, `clippy.toml` and the lint set from wave word for word.

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

## Comments

A comment says what the code does, in the present tense, and only when the code doesn't say it
itself.

- No history: no "previously", "now", "used to", dates or issue numbers. Git has the history.
- No sermon: say what the line does. If the consequence is what isn't obvious, give it one clause.
- No restating the name, and no pointers to docs: write the reason in a line instead.
- Do write units, ranges, formats, invariants and surprises (`// µs since boot, wraps after 71 min`).
- Every file opens with a one-line header saying what it is.
- Section banners are one line: `// == stats ==`.
- No em dashes, in code or prose. Use a sentence, a colon or a comma. American spelling.
- Upstream files mark each change with a `// techchase:` comment, so a rebase finds them.

## Theme

The app's colors are CSS variables in `tools/app/style.css`, all from the Dracula palette. Text
must stay readable against `--bg-primary`:

| Variable | Contrast | Floor |
|---|---|---|
| `--text-primary` | 13.4x | 7.0x (WCAG AAA) |
| `--text-subtle` | 7.0x | 6.0x |
| `--text-muted` | 5.2x | 4.5x (WCAG AA) |
| `--border-primary` | 2.3x | 2.1x |

New colors go in as variables, never as hex values in a rule.

## Commits

- One line, saying what changed. Multi-line only when there are many changes.
- Related files go together. No emoji.
- No AI-agent signatures or co-author lines.
- Run the checks in the README's Develop section before pushing.
