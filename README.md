# `md-fix-tables.js` — Markdown table aligner

Re-formats every pipe table in a Markdown file so that column delimiters line up
as far as the content allows, without ever truncating a cell.

```bat
md-fix-tables.bat <file.md>      :: wrapper, runs the script under bun
node md-fix-tables.js <file.md>  :: same thing under node
bun  md-fix-tables.js <file.md>
type in.md | node md-fix-tables.js > out.md   :: stdin -> stdout, no file touched
```

With a file argument the file is rewritten **in place** and nothing is printed.
With no argument the script reads stdin and writes the result to stdout, so it
composes in pipes. Any error goes to stderr with exit code 1.

---

## The two rules

### Rule 1 — a column's width comes only from cells shorter than 100 characters

A cell whose content is **100 characters or longer** is ignored when measuring the
column. One huge cell therefore cannot widen a column and drag every short cell in
that column out to a silly width.

* width = longest cell in the column **with length < 100**
* if *every* cell in the column is >= 100, fall back to the longest cell, capped at 100
* floor of 3, so the separator is always a legal Markdown separator (`---`)

### Rule 2 — padding never crosses a column boundary

Cells are **not** simply padded to the column width. Every row is written with a
running cursor, and a cell may only pad as far as its own boundary. Two
consequences:

* A cell longer than its column (a >= 100-char cell, or any content overrun) gets
  **no padding at all** — its trailing `|` sits immediately after the text.
* When an earlier oversized cell has already pushed the row to the right, the
  **following cells give their padding back** so the later delimiters return to the
  column boundary. This is what keeps the 3rd, 4th, … columns aligned even on a row
  whose first cell blew past its width.

If the overrun is larger than the remaining padding, the padding drops to zero and
the row stays shifted — the closest it can get without cutting text.

---

## Algorithm

For a table with `n` columns:

**1. Measure**

```
W[i] = max length of cells in column i whose length < 100      (separator row excluded)
W[i] = min(longest cell, 100)      if no cell in column i was under 100
W[i] = max(W[i], 3)
```

**2. Lay out the ideal grid** — where each cell's content *should* end, i.e. where
the next cell's content should begin:

```
cursor = 2                          // "| " puts cell 0's content at index 2
for i in 0..n-1:
    cursor   += W[i]
    idealEnd[i] = cursor
    cursor   += 3                   // " | " between cells
```

**3. Render each row** — pad up to the ideal end, but never past it:

```
pos = 2
for i in 0..n-1:
    len_i = max(contentLength_i, idealEnd[i] - pos)
    write content padded to len_i
    pos += len_i + 3
```

`idealEnd[i] - pos` is the whole column width on an unshifted row (normal
padding), less than it when the row has been pushed right (padding shrinks), and
negative once the push has passed the boundary (`max` keeps the raw content, zero
padding). The separator row is written as `W[i]` dashes.

---

## Worked example

The `## 1. Which JCodeBuddy parts this module actually uses` table in
`codebuddy.md` has four columns and measures as `W = [91, 69, 42, 79]`. One row
starts with a 118-character cell (`**Cooperative codegen** — DEC-020 …`), which
overruns column 1 by **27**.

Delimiter positions (character index of each `|` between cells), from
`check-pipes.mjs`:

| line | what              | delimiters      |
| ---- | ----------------- | --------------- |
| 48   | header            | `94  166  211`  |
| 49   | separator         | `94  166  211`  |
| 56   | **118-char cell** | `121  166  211` |
| 59   | ordinary row      | `94  166  211`  |

Only delimiter 1 moves (94 → 121), because that cell's *content* is too long —
nothing can be done about that. Column 2's padding shrank from 69 to 42 (exactly
the 27 characters of overrun), so **delimiters 2 and 3 stay on 166 and 211**,
identical to the header and to every other row. Columns 3 and 4 of that row are
therefore perfectly aligned with the table.

Where the overrun is in the content rather than the padding — section 0's
321-character cell against a 60-wide column — there is no padding left to give
back, so those rows stay ragged. That is unavoidable without truncating text.

---

## What it changes, and what it leaves alone

**Changes**

* Re-pads every cell and re-emits the row as `| … | … |`, so leading and trailing
  outer pipes are added if they were missing.
* Regenerates the separator row as plain dashes of the measured width.
* Rows with fewer cells than the widest row get empty cells appended.

**Leaves alone**

* Every line that does not start with `|` is copied verbatim — a table written
  *without* outer pipes (`A | B` on the first line) is not recognised and passes
  through untouched.
* Cell content is never truncated or re-wrapped. Only whitespace padding is added
  or removed.

---

## Behaviour to be aware of

* **Alignment colons are lost.** `| :--- | ---: |` is regenerated as `| --- | --- |`,
  so left/right/centre alignment markers are not preserved. Add them back by hand
  if the table relies on them.
* **Cells are trimmed.** Intentional leading/trailing spaces inside a cell are
  removed before measuring.
* **The separator must be row 2** of the block (standard GFM). It is recognised as
  a separator when every cell matches `^:?-{3,}:?$`; a data row full of dashes in
  that position would be treated as the separator row.
* **A `|` inside a cell** (for example inside inline code) splits that cell —
  escape it as `\|` in the source if you need it literal.
* **Idempotent.** Re-running produces a byte-identical file: padding is trimmed
  before measuring, so widths and cursor positions are recomputed identically.
  Verified with SHA-256 on repeated runs under both `node` and `bun`.

---

## Verifying alignment

`check-pipes.mjs` (same folder) prints the delimiter positions of a table so you
can confirm the alignment claim instead of eyeballing it:

```bat
node check-pipes.mjs codebuddy.md "| Part" 13
```

Arguments: file, an anchor string identifying a line inside the table (default
`| Part`), and how many lines to print (default 13). Columns whose delimiters hold
the same index on every row are aligned; a row where only the *first* delimiter
moves is an overrun that the padding of later cells successfully absorbed.

---

## Usage Examples

### Basic usage

```bash
# Fix a file in place (no output)
bun md-fix-tables.js input.md
node md-fix-tables.js input.md

# Using stdin/stdout for piping
echo "table content" | bun md-fix-tables.js > output.md

# Windows batch wrapper
md-fix-tables.bat input.md
```

### Configurable max column width

By default, cells with **100 or more characters** don't affect column width measurement. This limit can be overridden:

```bash
# Use a smaller threshold (50 chars) - overrides the 100 char default
bun md-fix-tables.js --max-col=50 input.md

# Or use a larger threshold (200 chars)  
bun md-fix-tables.js -m 200 input.md

# Combine with stdin/stdout
echo "table" | bun md-fix-tables.js --max-col=75 > output.md
```

### Verify alignment

Use `check-pipes.mjs` to verify that delimiters are aligned:

```bash
node check-pipes.mjs input.md "| Column A" 13
```

---

## Constants

| Constant   | Value           | Meaning                                                     |
| ---------- | --------------- | ----------------------------------------------------------- |
| `MAX_COL`  | 100             | at/above this, a cell neither sets a width nor gets padding |
| `MIN_COL`  | 3               | smallest separator (`---`)                                  |
| `SEP_CELL` | `/^:?-{3,}:?$/` | what makes a row count as the separator                     |
