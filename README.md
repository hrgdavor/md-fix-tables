# `md-fix-tables` — Markdown table aligner



### Basic usage

```bash
# Fix a file in place (no output)
bun md-fix-tables.js input.md

# Using stdin/stdout for piping
type input.md | bun md-fix-tables.js > output.md
```

### Configurable max column width

By default, cells with **100 or more characters** don't affect column width
measurement. The limit is the `MAX_COL` constant, and it can be overridden per run:

```bash
# Use a smaller threshold (50 chars) - overrides the 100 char default
bun md-fix-tables.js --max-col=50 input.md

# Or a larger one, which lets long cells set the column width again
bun md-fix-tables.js --max-col=200 input.md

# The space-separated form works too, as does the short flag
bun md-fix-tables.js -m 200 input.md

# Combine with stdin/stdout
type input.md | bun md-fix-tables.js --max-col=75 > output.md
```

`--max-col` must be an integer of at least 3 (the minimum legal separator);
anything else exits 1 with a message on stderr.

---

## Before & After Examples

The examples are generated with `--max-col=25` rather than the tool's default 100,
so the tables stay narrow enough not to wrap in a Markdown preview. The rules below
describe the limit in terms of the default; the examples apply the same rules at 25.

### Example 1: Ragged source, aligned result

The source pads nothing at all; every cell is written flush against its pipes. The
tool measures the columns and pads every cell out to a single grid.

[fixtures/example-1/before.md](./fixtures/example-1/before.md)

```markdown
| Name | Role | Notes |
| --- | --- | --- |
| Ada | Engineer | First algorithm |
| Grace | Rear Admiral | Coined "debugging" |
| Linus | Maintainer | Started a kernel |
```

[fixtures/example-1/after.md](./fixtures/example-1/after.md)

```markdown
| Name  | Role         | Notes              |
| ----- | ------------ | ------------------ |
| Ada   | Engineer     | First algorithm    |
| Grace | Rear Admiral | Coined "debugging" |
| Linus | Maintainer   | Started a kernel   |
```

Every row now ends its cells on the same indexes: the pipes sit at 8, 23 and 44 in
all five lines.

### Example 2: Missing closing pipes, and a row with a cell to spare

A line only has to *start* with `|` to belong to the table, so rows that were never
closed get their trailing pipe added. Row 1 also has one cell fewer than the widest
row, so an empty `Owner` cell is appended for it.

[fixtures/example-2/before.md](./fixtures/example-2/before.md)

```markdown
| Step | Action | Owner
| --- | --- | ---
| 1 | Cut the release branch
| 2 | Announce the release | Ada
| 3 | Write the retrospective | Grace
```

[fixtures/example-2/after.md](./fixtures/example-2/after.md)

```markdown
| Step | Action                  | Owner |
| ---- | ----------------------- | ----- |
| 1    | Cut the release branch  |       |
| 2    | Announce the release    | Ada   |
| 3    | Write the retrospective | Grace |
```

### Example 3: A long cell is neither truncated nor allowed to widen the column

Row 2's summary is 36 characters, so at this setting Rule 1 ignores it while
measuring — `Summary` stays as wide as the longest cell under the limit (24) and the
other rows stay narrow. Rule 2 refuses to cut the text, so the pipe straight after
that cell moves right (33 → 45). The `Note` column has padding to spare, so it hands
that padding back and the **last** pipe still lands on 57, the same index as every
other row.

[fixtures/example-3/before.md](./fixtures/example-3/before.md)

```markdown
| ID | Summary | Note |
| --- | --- | --- |
| 1 | Documented the fox today | Follow up with vendor |
| 2 | Rewrote the whole parser again today | Done |
| 3 | Short summary. | Also short. |
```

[fixtures/example-3/after.md](./fixtures/example-3/after.md)

```markdown
| ID  | Summary                  | Note                  |
| --- | ------------------------ | --------------------- |
| 1   | Documented the fox today | Follow up with vendor |
| 2   | Rewrote the whole parser again today | Done      |
| 3   | Short summary.           | Also short.           |
```

---

### Verify alignment

`check-pipes.mjs` prints the character index of every pipe in a table and reports
which indexes are shared by every row, so alignment can be confirmed instead of
eyeballed:

```bash
node check-pipes.mjs input.md
node check-pipes.mjs input.md --anchor "| Name" --lines 13
```

A pipe position reported with two different indexes is an overrun: a cell whose
content is longer than its column, which no padding can fix without truncating it.

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
padding). The separator row is written as `W[i]` dashes, so every pipe in it lands
on the same indexes as the rows around it.

---

## What it changes, and what it leaves alone

**Changes**

* Re-pads every cell and re-emits the row as `| … | … |`, so a missing leading or
  trailing outer pipe is added.
* Regenerates row 2 as the separator row, as plain dashes of the measured width.
* Rows with fewer cells than the widest row get empty cells appended.

**Leaves alone**

* Every line whose first non-space character is not `|` is copied verbatim — a
  table written *without* outer pipes (`A | B` on the first line) is not recognised
  at all and passes through untouched.
* Cell content is never truncated or re-wrapped. Only whitespace padding is added
  or removed.
* A line that already starts with `|` but is indented keeps its cells, but not its
  indentation: the row is re-emitted from column 0. A 4-space-indented table inside
  a Markdown code block is therefore rewritten as a table.
* **Fenced code blocks are not recognised.** Pipe lines inside a fence are treated
  as table rows, so a code sample containing a table is realigned — running this
  tool on this README rewrites its own `Before` examples.
* **Line endings are not preserved for table rows.** The document is split on `\n`
  and rows are re-emitted without a trailing `\r`, so in a CRLF file the table rows
  come back LF-only while the surrounding lines keep their CRLF.

---

## Behaviour to be aware of

* **Alignment colons are lost.** `| :--- | ---: |` is regenerated as `| --- | --- |`,
  so left/right/centre alignment markers are not preserved. Add them back by hand
  if the table relies on them.
* **Cells are trimmed.** Intentional leading/trailing spaces inside a cell are
  removed before measuring.
* **Row 2 is the separator row** (standard GFM) when every one of its cells matches
  `^:?-{3,}:?$`. A data row full of dashes in that position is therefore treated as
  the separator. If row 2 does *not* match, the block is still aligned, but no
  separator is generated for it.
* **A `|` inside a cell** (for example inside inline code) splits that cell. Write
  `\|` to keep it literal — the backslash is preserved and the cell is not split.
* **Idempotent.** Re-running produces a byte-identical file: padding is trimmed
  before measuring, so widths and cursor positions are recomputed identically.

---

## Development

```bash
bun test                                 # run the test suite
node tools/inject-examples.mjs           # copy fixtures/ into README.md
node tools/inject-examples.mjs --check   # exit 1 if README.md is stale
```

Each example lives in its own folder under `fixtures/`, as two real files:
`fixtures/example-1/before.md` and `fixtures/example-1/after.md`. A `before.md` is a
table as written by hand; its `after.md` is byte-for-byte what `fixTables` returns
for it. Do not run the tool over a `before.md` — it is ragged on purpose.

Every fenced block above is preceded by a link to the file it was copied from, so
the README points at the bytes it shows. `test-fix-tables.test.js` asserts both the
tool output and those README bytes, so the two can never disagree.

### Markers and regions

A marker is a line that is nothing but a link to a real path, labelled with that
same path. The fenced block under it is that file's content, byte for byte. Name a
region in the fragment to inject only part of a file:

    [fixtures/example-1/before.md](./fixtures/example-1/before.md)               whole file
    [fixtures/example-4/source.md](./fixtures/example-4/source.md#region:table)   one region

A region runs from `#region <name>` to the matching `#endregion`, and the directive
lines are never injected. The directive is accepted under any language's comment
prefix, because that is how the editors that support regions spell it:

| spelling                             | used by                               |
| ------------------------------------ | ------------------------------------- |
| `#region` / `#endregion`             | C#, and VS Code for several languages |
| `// #region` / `// #endregion`       | VS Code                               |
| `//region` / `//endregion`           | JetBrains IDEs                        |
| `<!-- #region -->` / `/* #region */` | Markdown and C-style languages        |

Without a comment prefix the `#` must be attached, so a heading such as
`# Region of interest` is prose and not a directive. Region names must be unique in
a file, and an unterminated region is an error rather than a silent no-op.

---

## Constants

| Constant   | Value           | Meaning                                                      |
| ---------- | --------------- | ------------------------------------------------------------ |
| `MAX_COL`  | 100             | at/above this, a cell neither sets a width nor gets padding  |
| `MIN_COL`  | 3               | smallest separator (`---`)                                   |
| `SEP_CELL` | `/^:?-{3,}:?$/` | what makes a cell part of a separator row                    |
