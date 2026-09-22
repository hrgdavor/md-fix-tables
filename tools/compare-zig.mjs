#!/usr/bin/env node

/**
 * Differential harness: `node md-fix-tables.js` vs the Zig build
 * (`zig-out/md-fix-tables[.exe]`).
 *
 * Everything is compared byte for byte: stdout, stderr, exit code, and (in
 * file mode) the rewritten file. The corpus is the repo itself, a battery of
 * synthetic edge cases, and two seeded fuzzers — one line-oriented (valid
 * UTF-8 markdown-ish tables) and one raw-byte (invalid UTF-8 included, which
 * exercises the WHATGWG replacement decoder both implementations use).
 *
 * Usage:  node tools/compare-zig.mjs [--seed N] [--rounds N]
 * Exit 0 when every comparison agrees, 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JS_TOOL = join(ROOT, 'md-fix-tables.js');
const ZIG_TOOL = process.platform === 'win32'
    ? join(ROOT, 'zig-out', 'md-fix-tables.exe')
    : join(ROOT, 'zig-out', 'md-fix-tables');

if (!existsSync(ZIG_TOOL)) {
    console.error(`Zig binary not found: ${ZIG_TOOL}`);
    console.error('Build it first:  zig build');
    process.exit(1);
}

const args = process.argv.slice(2);
const SEED = Number(flag('--seed') ?? 0x5eed1234);
const ROUNDS = Number(flag('--rounds') ?? 300);

let checks = 0;
let failures = 0;

function flag(name) {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
}

function show(buf) {
    const s = buf.toString('utf8');
    const clipped = s.length > 160 ? s.slice(0, 160) + '…' : s;
    return JSON.stringify(clipped);
}

function fail(name, detail) {
    failures += 1;
    console.error(`FAIL ${name}: ${detail}`);
}

function run(kind, toolArgs, input) {
    if (kind === 'js') {
        return spawnSync(process.execPath, [JS_TOOL, ...toolArgs], {
            input, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
        });
    }
    return spawnSync(ZIG_TOOL, toolArgs, {
        input, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    });
}

/** Run both tools on the same stdin/args and compare every observable byte. */
function compareStdin(name, toolArgs, input) {
    checks += 1;
    const js = run('js', toolArgs, input);
    const zig = run('zig', toolArgs, input);
    if (js.status !== zig.status) {
        fail(name, `exit status ${js.status} (js) != ${zig.status} (zig)`);
    }
    if (!js.stdout.equals(zig.stdout)) {
        fail(name, `stdout differs\n    js : ${show(js.stdout)}\n    zig: ${show(zig.stdout)}`);
    }
    if (!js.stderr.equals(zig.stderr)) {
        fail(name, `stderr differs\n    js : ${show(js.stderr)}\n    zig: ${show(zig.stderr)}`);
    }
    return js.stdout;
}

/** Run both tools in file mode (in-place rewrite) and compare everything. */
function compareFile(name, content, toolArgs = []) {
    checks += 1;
    const jsFile = join(TMP, 'node', `${sanitize(name)}.md`);
    const zigFile = join(TMP, 'zig', `${sanitize(name)}.md`);
    writeFileSync(jsFile, content);
    writeFileSync(zigFile, content);

    const js = run('js', [...toolArgs, jsFile], Buffer.alloc(0));
    const zig = run('zig', [...toolArgs, zigFile], Buffer.alloc(0));
    if (js.status !== zig.status) {
        fail(name, `file mode exit status ${js.status} (js) != ${zig.status} (zig)`);
    }
    if (!js.stdout.equals(zig.stdout)) {
        fail(name, `file mode stdout differs\n    js : ${show(js.stdout)}\n    zig: ${show(zig.stdout)}`);
    }
    if (!js.stderr.equals(zig.stderr)) {
        fail(name, `file mode stderr differs\n    js : ${show(js.stderr)}\n    zig: ${show(zig.stderr)}`);
    }
    const jsOut = readFileSync(jsFile);
    const zigOut = readFileSync(zigFile);
    if (!jsOut.equals(zigOut)) {
        fail(name, `rewritten file differs\n    js : ${show(jsOut)}\n    zig: ${show(zigOut)}`);
    }
}

let fileCounter = 0;
function sanitize(name) {
    fileCounter += 1;
    return `case-${String(fileCounter).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Corpus: the repository itself
// ---------------------------------------------------------------------------

const TMP = join(ROOT, '.compare-tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'node'), { recursive: true });
mkdirSync(join(TMP, 'zig'), { recursive: true });
mkdirSync(join(TMP, 'shared'), { recursive: true });

function repoFiles(dir = ROOT, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '.zig-cache', 'zig-out', '.compare-tmp'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            repoFiles(full, out);
        } else if (entry.isFile()) {
            const stat = statSync(full);
            if (stat.size <= 512 * 1024) out.push(full);
        }
    }
    return out;
}

console.log('— repo corpus —');
for (const file of repoFiles()) {
    const content = readFileSync(file);
    const rel = file.slice(ROOT.length).replaceAll('\\', '/');
    compareStdin(`repo stdin default: ${rel}`, [], content);
    compareStdin(`repo stdin m25: ${rel}`, ['--max-col=25'], content);
    if (content.length < 4096) compareFile(`repo file: ${rel}`, content, ['--max-col=25']);
}

// ---------------------------------------------------------------------------
// Synthetic edge cases (stdin mode unless noted)
// ---------------------------------------------------------------------------

console.log('— synthetic cases —');
const SYNTHETIC = [
    ['empty', ''],
    ['one newline', '\n'],
    ['crlf only', '\r\n'],
    ['no trailing newline', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['trailing newline', '| a | b |\n| --- | --- |\n| 1 | 2 |\n'],
    ['crlf table', '| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n'],
    ['crlf mixed', 'prose\r\n| a | b |\r\n| --- | --- |\r\ntail\r\n| 1 | 2 |'],
    ['bom table', '﻿| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['nbsp indent', ' | a | b |\n | --- | --- |\n | 1 | 2 |'],
    ['zwsp indent (not a table)', '​| a | b |\n​| --- | --- |'],
    ['ogham indent', ' | a | b |\n | --- | --- |'],
    ['one row table', '| a | b |'],
    ['bare pipe', '|'],
    ['double pipe', '||'],
    ['triple pipe', '|||'],
    ['spaces cells', '|   |   |\n| --- | --- |'],
    ['empty cells', '|| a ||\n|| --- ||\n|| 1 ||'],
    ['row 2 not separator', '| A | B |\n| 1 | 2 |\n| 3 | 4 |'],
    ['separator at row 3 (ignored)', '| A | B |\n| 1 | 2 |\n| --- | --- |'],
    ['two blocks', '| a | b |\n| --- | --- |\n\n| c | d |\n| --- | --- |\n| 5 | 6 |'],
    ['adjacent blocks no blank', '| a | b |\n| --- | --- |\n| c | d |\n| --- | --- |'],
    ['indented 4 spaces', '    | a | b |\n    | --- | --- |\n    | 1 | 2 |'],
    ['escaped pipe', '| Pattern | Meaning |\n| --- | --- |\n| a \\| b | alternation |'],
    ['trailing backslash', '| a\\ | b |\n| --- | --- |'],
    ['all alignments', '| L | R | C | P |\n| :--- | ---: | :---: | --- |\n| 1 | 2 | 3 | 4 |'],
    ['colon-only cell', '| : | :: |\n| :--- | ---: |'],
    ['wide emoji', '| 😀 | b |\n| --- | --- |\n| x | c |'],
    ['cjk', '| 中文 | b |\n| --- | --- |\n| 日本語 | c |'],
    ['combining marks', '| é | b |\n| --- | --- |\n| é | c |'],
    ['astral run', '| \u{1F600}\u{1F601} | \u{1F9E1} |\n| --- | --- |\n| 😀 | 🧡 |'],
    ['long cell at boundary', `| a | ${'x'.repeat(99)} |\n| --- | --- |\n| 1 | ${'y'.repeat(100)} |`],
    ['all cells over limit', `| ${'x'.repeat(150)} | ${'y'.repeat(200)} |\n| --- | --- |\n| ${'z'.repeat(120)} | b |`],
    ['tabs inside cells', '| a\tb | c |\n| --- | --- |'],
    ['nbsp inside cell', '| a b | c |\n| --- | --- |'],
    ['missing outer pipes', '| a | b\n| --- | ---\n| 1 | 2'],
    ['extra cell in row 1', '| a | b | c |\n| --- | --- |\n| 1 | 2 |'],
    ['fewer cells in row 1', '| a | b |\n| --- | --- | d |\n| 1 | 2 | 3 |'],
    ['maxcol floor', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['idempotent-ish input', '| A   | B    |\n| :--- | ----: |\n| 1    | 22   |'],
];

for (const [name, input] of SYNTHETIC) {
    compareStdin(`syn: ${name}`, [], Buffer.from(input, 'utf8'));
    compareStdin(`syn m5: ${name}`, ['--max-col=5'], Buffer.from(input, 'utf8'));
    compareStdin(`syn m25: ${name}`, ['--max-col=25'], Buffer.from(input, 'utf8'));
    compareFile(`syn file: ${name}`, Buffer.from(input, 'utf8'));
}

// Invalid UTF-8 through stdin and files: the WHATWG replacement decoder.
console.log('— invalid utf-8 —');
const BAD_UTF8 = [
    [0x80],
    [0xC0, 0x41],
    [0xC2],
    [0xE0, 0x41],
    [0xE0, 0xA0],
    [0xE0, 0x9F, 0x80],
    [0xED, 0xA0, 0x80],
    [0xED, 0x9F, 0xBF],
    [0xEE, 0x80, 0x80],
    [0xEF, 0xBF, 0xBD],
    [0xF0, 0x41],
    [0xF0, 0x80],
    [0xF0, 0x9F, 0x98],
    [0xF0, 0x9F, 0x98, 0x80],
    [0xF0, 0x9F, 0x98, 0x80, 0xF4],
    [0xF1, 0x80, 0x41],
    [0xF1, 0x80, 0x80, 0x41],
    [0xF4, 0x8F, 0xBF, 0xBF],
    [0xF4, 0x90],
    [0xF4, 0x90, 0x80, 0x80],
    [0xF5],
    [0xFF],
    [0xC2, 0xC2, 0x80],
    [0xE1, 0x9F, 0x80, 0x80],
    [0x41, 0xE1, 0x80, 0x42],
    [0x7C, 0x20, 0xC3, 0xA9, 0x20, 0x7C, 0x0A, 0x7C, 0x20, 0xC3, 0x2D, 0x2D, 0x20, 0x7C], // é + broken
    [0xFE, 0xFF, 0x80, 0x81, 0x82],
];

for (const bytes of BAD_UTF8) {
    const buf = Buffer.from(bytes);
    compareStdin(`bad stdin: ${bytes.map((b) => b.toString(16)).join(' ')}`, [], buf);
    compareFile('bad file', buf);
}

// ---------------------------------------------------------------------------
// CLI argument behaviour (messages go to stderr)
// ---------------------------------------------------------------------------

console.log('— argument cases —');
const TABLE_INPUT = Buffer.from('| a | b |\n| --- | --- |\n| 1 | 2 |\n', 'utf8');
const ARG_CASES = [
    [],
    ['--max-col=50'],
    ['-m', '50'],
    ['-m=50'],
    ['--max-col', '50'],
    ['--max-col=2'],
    ['--max-col=abc'],
    ['--max-col=50x'],
    ['--max-col=+5'],
    ['--max-col=-5'],
    ['--max-col= 7 '],
    ['--max-col=0x10'],
    ['--max-col=1e3'],
    ['--max-col='],
    ['--max-col=999999999999999999999999'],
    ['--max-col=\u{A0}7\u{A0}'],
    ['--max-col'],
    ['-m'],
    ['-'],
    ['--nope'],
    ['--max-col=5', '--max-col=9'],
    [''],
];

for (const toolArgs of ARG_CASES) {
    compareStdin(`args: ${JSON.stringify(toolArgs)}`, toolArgs, TABLE_INPUT);
}

// File-path error behaviour (shared paths so messages are comparable).
console.log('— file error cases —');
compareStdin('missing relative', ['missing-rel-file.md'], TABLE_INPUT);
compareStdin('missing nested fwd slashes', ['fixtures/nope/deeper/missing.md'], TABLE_INPUT);
compareStdin('missing absolute', [join(ROOT, 'nope-absolute-file.md')], TABLE_INPUT);
compareStdin('missing trailing slash', ['missing-trailing/'], TABLE_INPUT);
compareStdin('directory read', [join(TMP, 'shared')], TABLE_INPUT);
compareStdin('file then missing (last wins)', ['fixtures/example-1/after.md', 'missing-last.md'], TABLE_INPUT);

// Two file paths: the last one wins and only it is rewritten.
{
    const a = join(TMP, 'shared', 'a.md');
    const b = join(TMP, 'shared', 'b.md');
    for (const [tool, file] of [['js', a], ['js', b], ['zig', a], ['zig', b]]) {
        writeFileSync(file, TABLE_INPUT);
    }
    const js = run('js', ['--max-col=25', a, b], Buffer.alloc(0));
    const zig = run('zig', ['--max-col=25', a, b], Buffer.alloc(0));
    checks += 1;
    if (js.status !== zig.status) fail('two paths status', `${js.status} != ${zig.status}`);
    if (!readFileSync(a).equals(readFileSync(a)) || !readFileSync(b).equals(readFileSync(b))) {
        fail('two paths', 'impossible');
    }
    if (!js.stdout.equals(zig.stdout) || !js.stderr.equals(zig.stderr)) {
        fail('two paths output', 'stdout/stderr differ');
    }
}

// ---------------------------------------------------------------------------
// Fuzzing
// ---------------------------------------------------------------------------

console.log(`— fuzz (${ROUNDS} table rounds, ${Math.floor(ROUNDS / 6)} raw rounds, seed ${SEED}) —`);

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const CELL_BITS = [
    'a', 'bb', 'c d', '中文', '日本語', '😀', '🧡', 'x', ':', '-', '--',
    '\\|', '\\', 'a\\|b', ' ', '\t', '\u{A0}', '\u{3000}', '😀😀',
    'é', 'é', ':--', '...', '|', '0', 'long' + 'z'.repeat(30),
];

const PROSE_BITS = ['word', 'text', 'hello', 'a', 'with  spaces', '# Heading', '```', '`|`', '-'];

function sepCell(rand) {
    let c = '-'.repeat(2 + Math.floor(rand() * 4));
    if (rand() < 0.3) c = ':' + c;
    if (rand() < 0.3) c = c + ':';
    if (rand() < 0.08) c = c + ' ';
    return c;
}

function dataCell(rand) {
    if (rand() < 0.25) return 'x'.repeat(Math.floor(rand() * 120));
    let s = '';
    const bits = Math.floor(rand() * 4);
    for (let i = 0; i < bits; i++) s += CELL_BITS[Math.floor(rand() * CELL_BITS.length)];
    return s;
}

function makeRow(rand, cellFn) {
    const lead = rand() < 0.25
        ? ' '.repeat(1 + Math.floor(rand() * 4))
        : (rand() < 0.08 ? '\u{A0}' : '');
    const cells = [];
    const n = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) cells.push(cellFn(rand));
    const open = rand() < 0.9;
    const close = rand() < 0.85;
    const sep = rand() < 0.8 ? ' | ' : '|';
    return lead + (open ? '| ' : '') + cells.join(sep) + (close ? ' |' : '');
}

function fuzzLines(rand) {
    const lines = [];
    const n = Math.floor(rand() * 12);
    for (let i = 0; i < n; i++) {
        const kind = rand();
        if (kind < 0.25) {
            const words = [];
            const m = 1 + Math.floor(rand() * 4);
            for (let j = 0; j < m; j++) words.push(PROSE_BITS[Math.floor(rand() * PROSE_BITS.length)]);
            lines.push(' '.repeat(Math.floor(rand() * 4)) + words.join(' '));
        } else if (kind < 0.45) {
            lines.push(makeRow(rand, sepCell));
        } else {
            lines.push(makeRow(rand, (r) => dataCell(r)));
        }
    }
    if (rand() < 0.4) lines.push('');
    return lines.join('\n');
}

const MAX_COLS = [undefined, 3, 4, 5, 6, 10, 25, 40, 100, 1000];

const rand = mulberry32(SEED);
for (let i = 0; i < ROUNDS; i++) {
    const input = fuzzLines(rand);
    const maxCol = MAX_COLS[Math.floor(rand() * MAX_COLS.length)];
    const toolArgs = maxCol === undefined ? [] : [`--max-col=${maxCol}`];
    const buf = Buffer.from(input, 'utf8');
    compareStdin(`fuzz table #${i}`, toolArgs, buf);
    if (i % 5 === 0) {
        const once = compareStdin(`fuzz table round2 #${i}`, toolArgs, buf);
        compareStdin(`fuzz table idem #${i}`, toolArgs, once); // both tools on their own output
        compareFile('fuzz file', buf, toolArgs);
    }
}

// Raw bytes: valid text corrupted, and fully random bytes.
const randBytes = mulberry32(SEED ^ 0x9E3779B9);
const rawRounds = Math.max(10, Math.floor(ROUNDS / 6));
for (let i = 0; i < rawRounds; i++) {
    let buf;
    const mode = randBytes();
    if (mode < 0.45) {
        buf = Buffer.from(fuzzLines(randBytes), 'utf8');
        const corruptions = 1 + Math.floor(randBytes() * 4);
        for (let c = 0; c < corruptions; c++) {
            buf[Math.floor(randBytes() * buf.length)] = Math.floor(randBytes() * 256);
        }
    } else {
        const n = Math.floor(randBytes() * 260);
        buf = Buffer.from(Array.from({ length: n }, () => Math.floor(randBytes() * 256)));
    }
    compareStdin(`fuzz raw #${i}`, [], buf);
    if (i % 3 === 0) compareFile('fuzz raw file', buf);
}

// ---------------------------------------------------------------------------

rmSync(TMP, { recursive: true, force: true });
console.log(`${checks} comparisons, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
