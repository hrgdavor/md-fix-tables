#!/usr/bin/env node

/**
 * md-fix-tables — re-align every pipe table in a Markdown document.
 *
 * One file, two roles. Imported, it is a library: `fixTables`, `parseArgs` and
 * the constants. Run (the `md-fix-tables` bin), it is the CLI documented in
 * `HELP` below — a file is rewritten in place, or stdin is aligned to stdout,
 * with `--check` reporting instead of writing.
 *
 * `src/root.zig` is a byte-for-byte port of this file: when the two disagree,
 * this one is right, and `tools/compare-zig.mjs` is what proves they do not.
 */

import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

// A cell at/over MAX_COL never sets a column width and is never padded.
export const MAX_COL = 100;
export const MIN_COL = 3; // smallest legal markdown separator

export const SEP_CELL = /^:?-{3,}:?$/;

/** The name `--check` reports for the stdin/stdout mode. */
const STDIN_NAME = '<stdin>';

/**
 * `md-fix-tables --help`. The Zig port prints these same bytes, so the two
 * implementations have to be edited together.
 */
export const HELP = `md-fix-tables — re-align every pipe table in a Markdown document

Usage:
  md-fix-tables [options] [file]

  With a file, its tables are rewritten in place and nothing is printed.
  Without one, stdin is read and the aligned document goes to stdout.

Options:
  -m, --max-col <n>  cells at or over <n> characters neither set a column
                     width nor get padding (default 100, minimum 3);
                     --max-col=<n>, -m <n> and -m=<n> also work
  -c, --check        write nothing and exit 1 when the input is not
                     already aligned
  -h, --help         show this help
  -V, --version      show the version

Exit codes:
  0  the tables were written, or --check found the input aligned
  1  a bad option, a file that cannot be read or written, or --check
     found the input unaligned
`;

// A line is part of a table when its first non-space character is a pipe.
function isTableLine(line) {
  return line.trim().startsWith('|');
}

// The leading run of spaces and tabs: the table's own indentation, which a row
// keeps so a table inside a list item stays inside it.
function indentOf(line) {
  return /^[ \t]*/.exec(line)[0];
}

// The column a list item's content starts at, or null when the line is not a
// list item. `- x` puts its content at column 2, so a table indented four spaces
// under it sits at the item's own indentation 2 and is a table, not an indented
// code block. (Approximation: the marker plus one space, and tabs count as one
// column, which is enough for the documents this tool meets.)
function listMarkerWidth(line) {
  const bullet = /^[ \t]*[-*+][ \t]/.exec(line);
  if (bullet !== null) return bullet[0].length;
  const ordered = /^[ \t]*\d{1,9}[.)][ \t]/.exec(line);
  return ordered === null ? null : ordered[0].length;
}

// A fenced code block marker: three or more backticks or tildes, indented or
// not, with the rest of the line after the run. CommonMark: a backtick fence's
// info string may not contain a backtick, and a closing fence has nothing but
// spaces after it.
function fenceMarker(line) {
  const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
  if (m === null) return null;
  return { char: m[1][0], length: m[1].length, rest: m[2] };
}

const isFenceClose = (marker, open) =>
  marker !== null && marker.char === open.char && marker.length >= open.length && marker.rest.trim() === '';

// Everything between a fence and its closing marker is a code sample, never a
// table. A code sample that happens to show a table — or that draws with `|`,
// or holds a Java `||` continuation — must survive a run untouched.
const opensFence = (marker) => marker !== null && (marker.char === '~' || !marker.rest.includes('`'));

// Split a row into trimmed cells. `\|` is an escaped pipe: it stays literal and
// does not split the cell. A leading/trailing empty cell is the row's outer pipe.
function parseRow(row) {
  const raw = [];
  let cell = '';
  let escaped = false;

  for (const ch of row) {
    if (escaped) {
      cell += ch;
      escaped = false;
    } else if (ch === '\\') {
      cell += ch;
      escaped = true;
    } else if (ch === '|') {
      raw.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  raw.push(cell);

  const cells = raw.map(c => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function isSeparatorRow(row, rowIndex) {
  return rowIndex === 1 && row.length > 0 && row.every(c => SEP_CELL.test(c));
}

// Which way a separator cell points its column: `| :--- |` left, `| ---: |`
// right, `| :---: |` centre, `| --- |` unchanged.
function alignmentOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return 'none';
}

// Rebuild one separator cell at the column's width, keeping any alignment
// markers. A colon occupies a character of the cell, so the dashes give it room
// — the cell spans the column width, except for the narrowest aligned column
// (width 3), where keeping two dashes costs it one character too many.
function separatorCell(alignment, width) {
  if (alignment === 'none') return '-'.repeat(width);
  if (alignment === 'center') return `:${'-'.repeat(Math.max(width - 2, 2))}:`;
  if (alignment === 'left') return `:${'-'.repeat(Math.max(width - 1, 2))}`;
  return `${'-'.repeat(Math.max(width - 1, 2))}:`; // right
}

// How many columns the table has. GFM: the header row and the delimiter row
// declare them, and a row with more cells than that has its excess *ignored* by
// the renderer — so the table is never widened to fit such a row, which is what
// used to turn one unescaped `|` inside a cell into an extra column for the
// whole table. A block whose row 2 is no delimiter row has only its widest row
// to go on.
function columnCount(tableData) {
  if (tableData.length >= 2 && isSeparatorRow(tableData[1], 1)) {
    return Math.max(tableData[0].length, tableData[1].length);
  }
  return tableData.reduce((widest, row) => Math.max(widest, row.length), 0);
}

// Align a table block. Row 2's separator cells are regenerated at each measured
// column width, keeping whatever alignment (`:---`, `---:`, `:---:`) they
// declared; the colons stay inside the cell, so every pipe still lands on the
// same index as the rows around it.
//
// `rows` are `{ body, cr }`: the line without its carriage return, and whether
// it had one. Each row is emitted at the block's own indentation and with its
// own line ending, so a table keeps its place in a document and a CRLF file
// stays CRLF.
function alignTable(rows, maxCol) {
  const tableData = rows.map(r => parseRow(r.body));
  const numCols = columnCount(tableData);
  const indent = indentOf(rows[0].body);

  // The alignment row, for the columns it covers. A block whose row 2 is not a
  // separator row has no alignment to keep.
  const separator = isSeparatorRow(tableData[1] ?? [], 1) ? tableData[1] : null;
  const alignments = Array.from({ length: numCols }, (_, i) =>
    separator ? alignmentOf(separator[i] ?? '') : 'none');

  // Rule 1: a column's width is the longest content that is still under maxCol.
  // A cell at/over maxCol is ignored while measuring, so one huge cell cannot
  // widen the column and force every shorter cell to pad out to it.
  //
  // Row 2 is measured along with every other row even though it is regenerated:
  // its colons are the only content that takes up room without being text, and
  // counting the whole cell is what makes the rebuilt separator exactly as wide
  // as the one it replaces.
  //
  // Cells past `numCols` are not measured at all: they are outside the table the
  // header declared, and the renderer does not show them.
  const colWidths = Array(numCols).fill(0);
  const longestCell = Array(numCols).fill(0);

  tableData.forEach(row => {
    row.forEach((cell, i) => {
      if (i >= numCols) return;
      if (cell.length > longestCell[i]) longestCell[i] = cell.length;
      if (cell.length < maxCol && cell.length > colWidths[i]) {
        colWidths[i] = cell.length;
      }
    });
  });

  for (let i = 0; i < numCols; i++) {
    // Every cell in this column was >= maxCol: fall back to the widest, capped.
    if (colWidths[i] === 0) colWidths[i] = Math.min(longestCell[i], maxCol);
    if (colWidths[i] < MIN_COL) colWidths[i] = MIN_COL;
  }

  // Absolute position at which each cell's content should end, and therefore
  // where the next cell's content should begin.
  //   "| " starts cell 0 at 2, each cell is followed by " | " (3 chars).
  const idealEnd = [];
  let cursor = 2;
  for (let i = 0; i < numCols; i++) {
    cursor += colWidths[i];
    idealEnd[i] = cursor;
    cursor += 3;
  }

  // Rule 2: a cell may only pad as far as its own boundary. Once an earlier
  // oversized cell has pushed the row right, the remaining padding is shrunk —
  // and dropped entirely if the boundary is already behind us — so the padding
  // never carries this row further into the next column's space.
  const bodies = tableData.map((row, rowIndex) => {
    if (isSeparatorRow(row, rowIndex)) {
      return indent + `| ${colWidths.map((w, i) => separatorCell(alignments[i], w)).join(' | ')} |`;
    }

    const cells = [];
    let pos = 2;
    for (let i = 0; i < numCols; i++) {
      const cell = row[i] ?? "";
      const len = Math.max(cell.length, idealEnd[i] - pos);
      cells.push(len > cell.length ? cell.padEnd(len) : cell);
      pos += len + 3;
    }
    // Cells past the declared columns are kept verbatim rather than dropped: a
    // renderer ignores them, and this tool never truncates a line.
    const extra = row.length > numCols ? ` | ${row.slice(numCols).join(' | ')} |` : ' |';
    return indent + `| ${cells.join(' | ')}${extra}`;
  });

  return bodies.map((body, i) => body + (rows[i].cr ? '\r' : '')).join('\n');
}

/**
 * Re-align every pipe table in markdown text.
 *
 * `maxCol` is the width at/above which a cell stops counting towards its
 * column's width (default MAX_COL, 100).
 *
 * Lines are split on `\n` and a trailing `\r` is kept per line, so a CRLF
 * document stays CRLF: a table row comes back with the ending it arrived with,
 * not the one the other rows happen to use. Three things are never a table, and
 * each is copied verbatim: a fenced code block, an indented code block (a run of
 * lines at four spaces or more, measured from whatever list item contains them,
 * that begins after a blank line), and a line that starts with `|` but is not part
 * of a block of at least two such lines (a lone `|` in prose, say).
 */
export function fixTables(content, maxCol = MAX_COL) {
  const lines = content.split('\n').map(line => (
    line.endsWith('\r') ? { body: line.slice(0, -1), cr: true } : { body: line, cr: false }
  ));

  const result = []; // whole lines, each already carrying its own `\r` if it had one
  let table = [];
  let fence = null; // the open fence marker while inside a code block
  let indentedCode = false; // inside a run of indented code
  let container = 0; // the column the enclosing list item's content starts at
  let afterBlank = true; // the start of a document is a blank line for this purpose

  const verbatim = (line) => line.body + (line.cr ? '\r' : '');

  // A block of one line is not a table: `|` alone on a line is prose, art, or
  // the tail of something else, and re-emitting it as `|  |` was the tool
  // inventing a table where the document had none.
  const flush = () => {
    if (table.length >= 2) {
      // `alignTable` emits the rows with their own line endings.
      result.push(alignTable(table, maxCol));
    } else {
      for (const row of table) result.push(verbatim(row));
    }
    table = [];
  };

  for (const line of lines) {
    const marker = fenceMarker(line.body);

    if (fence !== null) {
      if (isFenceClose(marker, fence)) fence = null;
      flush();
      result.push(verbatim(line));
      afterBlank = false;
      continue;
    }
    if (opensFence(marker)) {
      flush();
      fence = marker;
      result.push(verbatim(line));
      afterBlank = false;
      continue;
    }

    // A blank line ends a table, and keeps an indented code block open (the
    // block ends at the next line that is indented less than four).
    if (line.body.trim() === '') {
      flush();
      result.push(verbatim(line));
      afterBlank = true;
      continue;
    }

    // An indented code block: four columns past whatever contains it, and only
    // where a paragraph could not be continuing — CommonMark's rule, which is
    // what "after a blank line" stands in for here.
    const indent = indentOf(line.body).length;
    if (indentedCode) {
      if (indent >= container + 4) {
        flush();
        result.push(verbatim(line));
        afterBlank = false;
        continue;
      }
      indentedCode = false;
    }
    if (indent >= container + 4 && afterBlank) {
      indentedCode = true;
      flush();
      result.push(verbatim(line));
      afterBlank = false;
      continue;
    }

    const markerWidth = listMarkerWidth(line.body);
    if (markerWidth !== null) {
      container = markerWidth;
    } else if (indent === 0) {
      container = 0;
    }

    afterBlank = false;
    if (isTableLine(line.body)) {
      table.push(line);
      continue;
    }
    flush();
    result.push(verbatim(line));
  }
  flush();

  return result.join('\n');
}

/**
 * Parse the command line. Accepts a single file path plus the options:
 *
 *   -c, --check                    -h, --help                    -V, --version
 *   --max-col=<n>   --max-col <n>   -m <n>   -m=<n>
 *
 * `--help` and `--version` are reported here rather than acted on, so the
 * caller decides the precedence; like every other option they are still
 * subject to the whole command line parsing, so a bad option anywhere is an
 * error even beside `--help`.
 */
export function parseArgs(argv) {
  let maxCol = MAX_COL;
  let filePath = null;
  let check = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value = null;

    if (arg === '-c' || arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '-V' || arg === '--version') {
      version = true;
      continue;
    }

    if (arg.startsWith('--max-col=')) {
      value = arg.slice('--max-col='.length);
    } else if (arg === '--max-col' || arg === '-m') {
      value = argv[++i];
    } else if (arg.startsWith('-m=')) {
      value = arg.slice('-m='.length);
    } else if (!arg.startsWith('-')) {
      filePath = arg;
      continue;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < MIN_COL) {
      throw new Error(`--max-col needs an integer >= ${MIN_COL}, got: ${value}`);
    }
    maxCol = parsed;
  }

  return { filePath, maxCol, check, help, version };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

function reportError(err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
}

/** The published version, read from the package.json next to this file. */
function version() {
  return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version;
}

// `import.meta.main` is Bun-only; under node, compare argv[1] with this file.
function isMain() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  try {
    const { filePath, maxCol, check, help, version: showVersion } = parseArgs(process.argv.slice(2));

    if (help) {
      process.stdout.write(HELP);
    } else if (showVersion) {
      process.stdout.write(`${version()}\n`);
    } else if (filePath) {
      // File mode: rewrite in place and print nothing (--check only reports).
      const content = readFileSync(filePath, 'utf-8');
      const fixed = fixTables(content, maxCol);
      if (check) {
        if (fixed !== content) throw new Error(`${filePath} is not aligned`);
      } else {
        writeFileSync(filePath, fixed);
      }
    } else {
      // Stdin mode: read stdin and write the aligned result to stdout.
      const content = await readStdin();
      const fixed = fixTables(content, maxCol);
      if (check) {
        if (fixed !== content) throw new Error(`${STDIN_NAME} is not aligned`);
      } else {
        process.stdout.write(fixed);
      }
    }
  } catch (err) {
    reportError(err);
  }
}
