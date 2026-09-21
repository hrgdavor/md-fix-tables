# Improvement plan

Where the tool is now, and what to do next. Each item is written so it can be
turned into a test directly — the fixture files under `fixtures/`, plus
`tools/inject-examples.mjs`, mean a behaviour change can never leave the README
telling a different story than the code.

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

## Next

1. **Skip fenced code blocks.** A table inside a ```` ``` ```` fence is realigned
   today — running the tool on this repository's own README rewrites the `Before`
   examples it is meant to display. Track fence state (```` ``` ````/`~~~`, with a
   matching closing run) and copy fenced regions through untouched.
2. **Skip indented code blocks.** A pipe line indented by four spaces or a tab is a
   Markdown code block; it is currently de-indented and re-padded. Require the `|`
   at column 0, or make tolerance an explicit opt-in.
3. **Preserve alignment colons.** `| :--- | ---: |` comes back as `| --- | --- |`,
   silently dropping left/right/centre alignment. Keep the colons and rebuild the
   separator cell as `:` + dashes (+ `:`) at the measured width.
4. **Preserve line endings.** Table rows are re-emitted LF-only, so a CRLF file ends
   up with mixed endings. Split with the terminator retained (or detect the dominant
   EOL) and re-emit the same one.
5. **Wide-character-aware widths.** `cell.length` counts UTF-16 code units, so CJK
   text, emoji and combining marks misalign. Measure grapheme clusters
   (`Intl.Segmenter`) and use display width, not code-unit count.
6. **Separator policy.** A block whose row 2 is not a separator row is still
   realigned, but no separator is generated. Add `--strict` (leave anything without
   a separator row alone) and `--add-separator` (synthesise a GFM separator), then
   decide which should be the default.
7. **`--check` for CI.** Exit 1 and print a diff when a file would change, so the
   tool can gate a pre-commit hook or a GitHub Action.
8. **Batch input.** Accept several paths and/or globs, and add `--out <dir>` so a
   run does not have to rewrite in place.
9. **Backslash runs.** `\\|` (a literal backslash followed by a real delimiter) is
   currently read as an escaped pipe. Count the run of backslashes instead of
   toggling a flag.
10. **Property tests, not just fixtures.** Generate random tables and assert the two
    invariants that matter: running twice changes nothing, and no cell content is
    ever lost or truncated.
11. **Packaging.** Add `bin`, `files` and repository metadata to `package.json`,
    publish to npm, and ship the `--check` action.
