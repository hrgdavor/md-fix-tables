import { readFileSync, writeFileSync } from 'fs';

// A cell at/over MAX_COL never sets a column width and is never padded.
const MAX_COL = 100;
const MIN_COL = 3; // smallest legal markdown separator

const SEP_CELL = /^:?-{3,}:?$/;

function parseRow(row) {
  return row.split('|')
    .map(cell => cell.trim())
    .filter((cell, index, arr) => {
      if (index === 0 && cell === "") return false;
      if (index === arr.length - 1 && cell === "") return false;
      return true;
    });
}

function isSeparatorRow(row, rowIndex) {
  return rowIndex === 1 && row.length > 0 && row.every(c => SEP_CELL.test(c));
}

function alignTable(rows) {
  const tableData = rows.map(parseRow);
  const numCols = Math.max(...tableData.map(r => r.length));

  // Rule 1: a column's width is the longest content that is still under MAX_COL.
  // A cell at/over MAX_COL is ignored while measuring, so one huge cell cannot
  // widen the column and force every shorter cell to pad out to it.
  const colWidths = Array(numCols).fill(0);
  const longestCell = Array(numCols).fill(0);

  tableData.forEach((row, rowIndex) => {
    if (isSeparatorRow(row, rowIndex)) return; // regenerated, never measured
    row.forEach((cell, i) => {
      if (cell.length > longestCell[i]) longestCell[i] = cell.length;
      if (cell.length < MAX_COL && cell.length > colWidths[i]) {
        colWidths[i] = cell.length;
      }
    });
  });

  for (let i = 0; i < numCols; i++) {
    // Every cell in this column was >= MAX_COL: fall back to the widest, capped.
    if (colWidths[i] === 0) colWidths[i] = Math.min(longestCell[i], MAX_COL);
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
      return `| ${colWidths.map(w => '-'.repeat(w)).join(' | ')} |`;
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

function processContent(content) {
  const lines = content.split('\n');
  let result = [], currentTable = [];

  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      currentTable.push(line);
    } else {
      if (currentTable.length > 0) {
        result.push(alignTable(currentTable));
        currentTable = [];
      }
      result.push(line);
    }
  }
  if (currentTable.length > 0) result.push(alignTable(currentTable));
  return result.join('\n');
}

const filePath = process.argv[2];
if (filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, processContent(content));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
} else {
  let input = '';
  process.stdin.on('data', d => input += d);
  process.stdin.on('end', () => process.stdout.write(processContent(input)));
}
