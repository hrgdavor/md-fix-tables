import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

// A cell at/over MAX_COL never sets a column width and is never padded.
export const MAX_COL = 100;
export const MIN_COL = 3; // smallest legal markdown separator

export const SEP_CELL = /^:?-{3,}:?$/;

// A line is part of a table when its first non-space character is a pipe.
function isTableLine(line) {
  return line.trim().startsWith('|');
}

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

// Align a table block. Row 2's separator cells are regenerated at each measured
// column width, keeping whatever alignment (`:---`, `---:`, `:---:`) they
// declared; the colons stay inside the cell, so every pipe still lands on the
// same index as the rows around it.
function alignTable(rows, maxCol) {
  const tableData = rows.map(parseRow);
  const numCols = Math.max(...tableData.map(r => r.length));

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
  const colWidths = Array(numCols).fill(0);
  const longestCell = Array(numCols).fill(0);

  tableData.forEach(row => {
    row.forEach((cell, i) => {
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
  return tableData.map((row, rowIndex) => {
    if (isSeparatorRow(row, rowIndex)) {
      return `| ${colWidths.map((w, i) => separatorCell(alignments[i], w)).join(' | ')} |`;
    }

    const cells = [];
    let pos = 2;
    for (let i = 0; i < numCols; i++) {
      const cell = row[i] ?? "";
      const len = Math.max(cell.length, idealEnd[i] - pos);
      cells.push(len > cell.length ? cell.padEnd(len) : cell);
      pos += len + 3;
    }
    return `| ${cells.join(' | ')} |`;
  }).join('\n');
}

/**
 * Re-align every pipe table in markdown text.
 *
 * `maxCol` is the width at/above which a cell stops counting towards its
 * column's width (default MAX_COL, 100).
 */
export function fixTables(content, maxCol = MAX_COL) {
  const lines = content.split('\n');
  let result = [], currentTable = [];

  for (const line of lines) {
    if (isTableLine(line)) {
      currentTable.push(line);
    } else {
      if (currentTable.length > 0) {
        result.push(alignTable(currentTable, maxCol));
        currentTable = [];
      }
      result.push(line);
    }
  }
  if (currentTable.length > 0) result.push(alignTable(currentTable, maxCol));
  return result.join('\n');
}

/**
 * Parse the command line. Accepts a single file path plus an optional width:
 *
 *   --max-col=<n>   --max-col <n>   -m <n>   -m=<n>
 */
export function parseArgs(argv) {
  let maxCol = MAX_COL;
  let filePath = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value = null;

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

  return { filePath, maxCol };
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

// `import.meta.main` is Bun-only; under node, compare argv[1] with this file.
function isMain() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  try {
    const { filePath, maxCol } = parseArgs(process.argv.slice(2));
    if (filePath) {
      // File mode: rewrite in place and print nothing.
      const content = readFileSync(filePath, 'utf-8');
      writeFileSync(filePath, fixTables(content, maxCol));
    } else {
      // Stdin mode: read stdin and write the aligned result to stdout.
      process.stdout.write(fixTables(await readStdin(), maxCol));
    }
  } catch (err) {
    reportError(err);
  }
}
