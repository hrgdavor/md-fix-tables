#!/usr/bin/env node

/**
 * check-pipes — show where the pipes in a table land, so alignment can be
 * verified instead of eyeballed.
 *
 *   node check-pipes.mjs <file.md> [--anchor "| Name"] [--lines 13]
 *
 * Prints the character index of every pipe in the table block, then summarises
 * which indexes are shared by every row. An index that only one row deviates on
 * is an overrun: a cell whose content is longer than its column, which no amount
 * of padding can fix without truncating the text.
 */

import { readFileSync } from 'fs';

const DEFAULT_LINES = 0; // 0 = whole block

function usage() {
  console.error('Usage: node check-pipes.mjs <file.md> [--anchor "<text>"] [--lines <n>]');
}

/** Character indexes of the unescaped pipes in a line. */
function pipeIndexes(line) {
  const indexes = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '|') indexes.push(i);
  }
  return indexes;
}

const isTableLine = (line) => line.trim().startsWith('|');

/** Contiguous table block containing `anchorIndex` (or the first one). */
function findBlock(lines, anchorIndex) {
  if (anchorIndex === -1) {
    const first = lines.findIndex(isTableLine);
    if (first === -1) return null;
    anchorIndex = first;
  }

  let start = anchorIndex;
  while (start > 0 && isTableLine(lines[start - 1])) start--;
  let end = anchorIndex;
  while (end + 1 < lines.length && isTableLine(lines[end + 1])) end++;

  return { start, end };
}

function main(argv) {
  const filePath = argv.find((arg) => !arg.startsWith('--')) ?? null;
  const anchorIndex = argv.indexOf('--anchor');
  const anchor = anchorIndex === -1 ? null : argv[anchorIndex + 1];
  const linesIndex = argv.indexOf('--lines');
  const maxLines = linesIndex === -1 ? DEFAULT_LINES : Number.parseInt(argv[linesIndex + 1], 10);

  if (!filePath) {
    usage();
    return 1;
  }

  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const anchorAt = anchor ? lines.findIndex((line) => line.includes(anchor)) : -1;

  if (anchor && anchorAt === -1) {
    console.error(`Anchor not found: ${anchor}`);
    return 1;
  }

  const block = findBlock(lines, anchorAt);
  if (!block) {
    console.error('No table found (a table line is one whose first non-space character is "|").');
    return 1;
  }

  let rows = [];
  for (let i = block.start; i <= block.end; i++) rows.push({ line: lines[i], indexes: pipeIndexes(lines[i]) });
  if (Number.isInteger(maxLines) && maxLines > 0) rows = rows.slice(0, maxLines);

  console.log(`${filePath}: table on lines ${block.start + 1}-${block.end + 1}\n`);

  for (const [offset, row] of rows.entries()) {
    const shown = row.line.length > 70 ? `${row.line.slice(0, 70)}…` : row.line;
    console.log(`line ${String(block.start + offset + 1).padStart(4)}  ${shown}`);
    console.log(`            pipes at ${row.indexes.join(', ') || '(none)'}`);
  }

  // Summarise per pipe position: which indexes appear, and on how many rows.
  const positions = Math.max(...rows.map((row) => row.indexes.length));
  const summary = [];
  for (let p = 0; p < positions; p++) {
    const counts = new Map();
    for (const row of rows) {
      const value = row.indexes[p];
      if (value === undefined) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    summary.push({ position: p + 1, entries });
  }

  console.log('');
  let aligned = true;
  for (const { position, entries } of summary) {
    if (entries.length === 1) {
      console.log(`pipe ${position}: aligned at ${entries[0][0]} on all ${entries[0][1]} rows`);
    } else {
      aligned = false;
      const detail = entries.map(([index, count]) => `${index} (${count} row${count === 1 ? '' : 's'})`).join(', ');
      console.log(`pipe ${position}: NOT aligned — ${detail}`);
    }
  }
  console.log(aligned ? '\nEvery pipe is aligned.' : '\nSome pipes are not aligned (see above).');

  return 0;
}

process.exitCode = main(process.argv.slice(2));
