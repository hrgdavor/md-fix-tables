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

### Example 4: A table lifted out of a larger document

The README blocks do not have to be whole files. This side of the example comes from
one *region* of `fixtures/example-4/source.md` — the lines between `<!-- #region table -->`
and `<!-- #endregion -->` — so the file can carry prose that the README does not need to
repeat. The directive lines are never injected, and the rest of the file is untouched.

[fixtures/example-4/source.md](./fixtures/example-4/source.md#region:table)

```markdown
| When | What | Who |
| --- | --- | --- |
| Mon | Cut the release branch | Ada |
| Tue | Announce it | Grace |
```

[fixtures/example-4/after.md](./fixtures/example-4/after.md)

```markdown
| When | What                   | Who   |
| ---- | ---------------------- | ----- |
| Mon  | Cut the release branch | Ada   |
| Tue  | Announce it            | Grace |
```

### Example 5: Alignment markers are kept

The separator row also says how each column is aligned (`:---` left, `---:` right,
`:---:` centre), and that hint is preserved: the colon is written back into the
regenerated cell and the dashes give it room, so the cell is still exactly as wide as
the column it heads. `Qty` below is right-aligned and `Price` centred; `Item` and
`Notes` carry no marker. The cells themselves are still padded on the right — it is the
renderer that applies the alignment when the table is displayed.

[fixtures/example-5/before.md](./fixtures/example-5/before.md)

```markdown
| Item | Qty | Price | Notes |
| :--- | ---: | :---: | --- |
| Widget | 12 | 4.50 | In stock |
| Gadget | 3 | 12.00 | Back-ordered |
```

[fixtures/example-5/after.md](./fixtures/example-5/after.md)

```markdown
| Item   | Qty  | Price | Notes        |
| :----- | ---: | :---: | ------------ |
| Widget | 12   | 4.50  | In stock     |
| Gadget | 3    | 12.00 | Back-ordered |
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

The separator row is measured like any other row even though it is rebuilt: that is
what keeps the rebuilt cell exactly as wide as the one it replaces. An aligning colon
is a real character, so a `:---:` cell measures five and the column under it takes
that width.

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
W[i] = max length of cells in column i whose length < 100
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
padding).

**4. Rebuild the separator row**

```
for i in 0..n-1:
    write dashes filling W[i], with the colon of A[i] (left, right, centre) kept
```

`A[i]` is the alignment row 2 declared: none, `:`… (left), …`:` (right) or `:`…`:`
(centre). The colon sits inside the `W[i]` characters rather than beside them, so
every pipe still lands on the same indexes as the rows around it.

`A` comes from the separator row itself, so the two feed each other: that row is
measured in step 1 as the text it is, colons and all, which is what makes the cell
rebuilt in step 4 exactly as wide as the one it replaces. At the 3-character floor
there is only room for the colon plus two dashes, so a column that narrow gets
`:--` or `--:` — legal GFM, and it stays that way on the next run.

---

## What it changes, and what it leaves alone

**Changes**

* Re-pads every cell and re-emits the row as `| … | … |`, so a missing leading or
  trailing outer pipe is added.
* Regenerates row 2 as the separator row, at the measured width of each column.
* Keeps the alignment row 2 declared: a `:---` cell is rebuilt as `:` plus dashes
  filling the column, a `:---:` one keeps both colons.
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

* **Alignment is kept, not re-decided.** The separator row comes back as the
  alignment it declared — `:---` left, `---:` right, `:---:` centre — with the colon
  written back inside the measured width. A column with no marker gains none, and a
  column too narrow for a third dash gets the two it can hold (`:--`, `--:`).
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
bun test                                  # run the test suite
npm run inject:examples                   # copy fixtures/ into README.md
npm run check:examples                    # exit 1 if README.md is stale
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
same path. The fenced block under it is that file's content, byte for byte. Add a
region to the fragment to inject only part of a file:

| line                                     | injects                |
| ---------------------------------------- | ---------------------- |
| `[path/to/notes.md](./path/to/notes.md)` | the whole file         |
| `[…]` with a `#region:demo` fragment     | just that region of it |

The examples above are spelled inside inline code on purpose: a line that *is* the
link, with nothing around it, is a live marker for the injector, and every one of
those must name a real file (as the ten under the examples do).

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

## The Zig port

`build.zig`, `build.zig.zon` and `src/` hold a second implementation of this
exact tool in Zig, written against Zig 0.16.0 (this checkout used the toolchain
at `D:\wrk\zig\16\zig.exe`). It is not a rewrite-with-ideas: its job is to
produce the same bytes the JavaScript one produces, in every mode, on every
input.

```bash
zig build                     # → zig-out/md-fix-tables(.exe)
zig build test                # the ported test suite (fixtures included)
node tools/compare-zig.mjs    # differential harness: JS vs Zig, byte by byte
```

The binary is a drop-in stand-in for `bun md-fix-tables.js`: same flags
(`--max-col` in all four spellings), same stdin/stdout and rewrite-in-place
modes, same `Error: …` messages on stderr and exit code 1 on failure.

Tagging `v*` runs `.github/workflows/release.yml` (adapted from
zig-watch-scp), which cross-builds `ReleaseSafe` binaries for x86_64 Linux,
Windows and macOS (x86_64 and aarch64) and attaches them to a GitHub
release.

Four JavaScript details decide byte equality, so the Zig code mirrors them
exactly instead of approximating:

| JS behaviour                              | how the Zig port mirrors it                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `String.length` counts UTF-16 code units  | every width and padding count is a UTF-16 count, so an emoji pads one space    |
| `String.trim`'s whitespace set            | the same NBSP/BOM/ogham/… set is trimmed, which is what makes `\u00a0\|` a row |
| `Number.parseInt(x, 10)`                  | leading whitespace, one sign and trailing junk are all tolerated                |
| `readFileSync(path, 'utf-8')` decoding    | the WHATWG utf-8 decoder: each invalid maximal subpart becomes one U+FFFD      |

The library side is importable as well: `fixTables`, `parseArgs`, `decodeUtf8`
and the constants live in `src/root.zig`, exposed as the `md_fix_tables`
module of the package.

`tools/compare-zig.mjs` is the proof. It runs both tools over every file in
the repository, a battery of edge cases (CRLF, BOM, astral-plane cells,
invalid UTF-8, every argument spelling, missing files, directories), and two
seeded fuzzers — table-shaped input and raw random bytes — and compares
stdout, stderr, exit code and in-place rewrites byte for byte. `--seed N` and
`--rounds N` vary the corpus.

---

## Constants

| Constant   | Value           | Meaning                                                      |
| ---------- | --------------- | ------------------------------------------------------------ |
| `MAX_COL`  | 100             | at/above this, a cell neither sets a width nor gets padding  |
| `MIN_COL`  | 3               | smallest separator (`---`)                                   |
| `SEP_CELL` | `/^:?-{3,}:?$/` | what makes a cell part of a separator row                    |
