# Improvement plan

Where the tool is now, and what to do next. Each item is written so it can be
turned into a test directly — the fixture files under `fixtures/`, plus the
published `@hrg/inject-examples` tool (run through bunx), mean a behaviour
change can never leave the README telling a different story than the code.

## Done in this round

* **One implementation.** `md-fix-tables.js` is the only script. A second,
  duplicated copy (`index.js`) existed and did not even parse — it has been
  deleted, and the `.bat` wrapper and the docs now point at the real file.
* **Importable.** `fixTables`, `parseArgs` and the constants are exported and the
  CLI is behind an `isMain()` guard, so tests can import the script instead of
  shelling out to it.
* **`--max-col`.** The 100-character measurement cutoff is now a per-run option
  (`--max-col=50`, `--max-col 50`, `-m 50`); the default is unchanged.
* **Escaped pipes.** `\|` no longer splits a cell, so the advice the README has
  always given actually works.
* **`check-pipes.mjs`** reports per-pipe alignment across the rows of a block.
  It used to compare the first two pipes *of the same line*, which never meant
  anything.
* **Docs that cannot rot.** The README examples are injected from the fixture
  files in `fixtures/` and asserted by `bun test`.
* **Region markers.** A marker can name a `#region <name>` … `#endregion` block
  inside a larger file, so one snippet in the docs stays in sync with part of one
  document. The directive is accepted under any language's comment prefix, which
  is how the editors that support regions spell it.
* **Narrow examples.** The README examples are generated at `--max-col=25` while the
  tool's default stays 100, so no example line exceeds 72 columns and the tables do
  not wrap in a preview. Tests pin that width, and pin the pipe indexes the prose
  quotes, so the numbers in the docs cannot go stale quietly.
* **Alignment colons are preserved.** `| :--- | ---: | :---: |` comes back as the
  alignment it declared: the separator cell is rebuilt at the measured column width
  with its colon written back inside it, so left/right/centre survive and the pipes
  still line up. The separator row is measured like any other row, which is what
  makes a rebuilt separator exactly as wide as the cell it replaces. A column at the
  3-character floor gets `:--` rather than a one-dash `:-`.

## Done in the packaging round

* **Published shape.** `package.json` is scoped (`@hrg/md-fix-tables`), public
  (`publishConfig.access`), and carries the `bin`, `files`, `exports` and repository
  metadata, so the one file is both the library and the `md-fix-tables` command — a
  shebang and a `files` whitelist are all it took. The version is pinned in three
  places (`package.json`, `src/root.zig`, `build.zig.zon`) and a test asserts they
  agree.
* **`--check` and the other flags.** `-c`/`--check` writes nothing and exits 1 when
  the input is not already aligned (stdin or file, any `--max-col`); `-h`/`--help`
  and `-V`/`--version` print and exit 0. Every one is mirrored in the Zig port —
  including the help text, byte for byte — and the differential harness compares
  them on both modes, aligned and ragged.

## Done in the 1.1.0 and 1.2.0 rounds (2026-10-03)

Both implementations — the JavaScript reference and the Zig port — moved together, so the differential
harness (`node tools/compare-zig.mjs`, 1039 comparisons) still agrees byte for byte, and every behaviour
below is pinned by a test in **both** suites (85 JS, 43 Zig).

* **Skip fenced code blocks** (item 1, 1.1.0). Three or more backticks or tildes, a closing run at least as
  long as the opener, an info string, an unclosed fence running to the end of the document: a code sample
  that shows a table, draws with `|`, or holds a Java `||` continuation comes through untouched. Measured
  before the fix: a diagram's `|` shaft came back as `|  |`, and a Java line became
  `|     | resolution…, |` with the operator and the indentation gone.
* **Skip indented code blocks** (item 2, 1.2.0). A run of lines four columns or more past whatever list item
  contains them, beginning after a blank line, is code. The container is what keeps a nested table a table:
  `- x` puts its content at column 2, so four spaces under it is the item's own indentation 2 and is still
  formatted, while six is a code block inside the item. A line indented four spaces with no blank line before
  it is a paragraph continuation, and is still read as a row.
* **Preserve line endings** (item 4, 1.1.0). Every line keeps its own terminator, so a CRLF document stays
  CRLF and a document with mixed endings stays mixed row by row. The tool used to write LF on every row it
  rewrote.
* **Backslash runs** (item 8, already correct — now measured and pinned). `\|` is literal, `\\|` is a real
  delimiter (the row gains a cell, kept unpadded), `\\\|` is literal again: the flag that walks a row toggles
  per backslash rather than latching, so a run of any length reads correctly.

Two further behaviours were found by running the tool over the JCodeBuddy repository and are fixed here,
because they damaged documents rather than tables:

* A row is re-emitted at its **block's own indentation**; it used to be pulled to column 0, which ends the
  list item the table was nested in. Two documents were damaged that way and repaired there.
* A row with **more cells than the header** no longer widens the table — GFM ignores the excess, so the
  header and delimiter rows declare the columns and the extra cells stay in their row, unpadded.

## Next

The numbers are the ones this list has always used, so a reference to one still resolves; items 1, 2, 4
and 8 are done and are recorded above.

3. **Alignment when there is no separator row.** A block whose row 2 is not a
   separator row has no alignment to keep, and it is realigned without any separator
   being generated. That is the same question as item 6 (`--strict` vs
   `--add-separator`), so settle it there rather than here.
5. **Wide-character-aware widths.** `cell.length` counts UTF-16 code units, so CJK
   text, emoji and combining marks misalign. Measure grapheme clusters
   (`Intl.Segmenter`) and use display width, not code-unit count.
6. **Separator policy.** A block whose row 2 is not a separator row is still
   realigned, but no separator is generated. Add `--strict` (leave anything without
   a separator row alone) and `--add-separator` (synthesise a GFM separator), then
   decide which should be the default.
7. **Batch input.** Accept several paths and/or globs, and add `--out <dir>` so a
   run does not have to rewrite in place. (`--check` today takes one path, and the
   last positional wins.)
9. **Property tests, not just fixtures.** Generate random tables and assert the two
   invariants that matter: running twice changes nothing, and no cell content is
   ever lost or truncated. (`tools/compare-zig.mjs` already fuzzes both
   implementations against each other; this is about the invariants themselves.)
10. **A diff in `--check`.** It reports only `<path> is not aligned` and the exit
    code; print the lines that would change, so a CI log says what to fix.
11. **A `--check` GitHub Action.** Wrap the CLI in an action that fails a pull
    request when a document is stale.
