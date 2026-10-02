#!/usr/bin/env bun

/**
 * Tests for md-fix-tables.
 *
 * Two guarantees are checked here:
 *   1. fixTables() turns every fixture `before` into exactly its `after`.
 *   2. README.md contains those same two strings byte-for-byte, in the block
 *      following each `<!-- inject:<id>:before|after -->` marker.
 *
 * Run with `bun test`. Regenerate the README blocks with
 * `npm run inject:examples`, which runs the published `@hrg/inject-examples`
 * through bunx (version pinned in package.json).
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixTables, parseArgs, MAX_COL, MIN_COL, HELP } from './md-fix-tables.js';
import { EXAMPLE_MAX_COL, EXAMPLES, markerFor } from './test-fixtures.js';

const README = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

/** The published inject-examples CLI, run through bunx (no local install). */
const INJECT_EXAMPLES = '@hrg/inject-examples@1.0.0';

/** The repository root, independent of the test runner's working directory. */
const REPO = fileURLToPath(new URL('.', import.meta.url));

/** The body of the fenced block that follows `markerLine` in `text`. */
function blockAfter(text, markerLine) {
    const lines = text.split('\n');
    const markerIndex = lines.findIndex((line) => line.trim() === markerLine);
    if (markerIndex === -1) throw new Error(`marker not found: ${markerLine}`);

    const open = lines.findIndex((line, i) => i > markerIndex && line.startsWith('```'));
    if (open === -1) throw new Error(`no code block after ${markerLine}`);

    const close = lines.findIndex((line, i) => i > open && line.startsWith('```'));
    if (close === -1) throw new Error(`unclosed code block after ${markerLine}`);

    return lines.slice(open + 1, close).join('\n');
}

/** The body of the fenced block that follows `marker` in README.md. */
function readmeBlock(marker) {
    return blockAfter(README, marker);
}

/** Run the inject-examples CLI with `args` in `cwd`, capturing everything. */
function invokeInjector(args, cwd) {
    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
        stdout = execFileSync('bunx', [INJECT_EXAMPLES, ...args], { cwd, encoding: 'utf8' });
    } catch (err) {
        code = typeof err.status === 'number' ? err.status : 1;
        stdout = err.stdout ? String(err.stdout) : '';
        stderr = err.stderr ? String(err.stderr) : '';
    }
    return { code, stdout, stderr };
}

/**
 * Run the inject-examples CLI in a throwaway directory holding `files`
 * (name to text), on `doc.md`. `args` are passed before the file name.
 * Returns { code, stdout, stderr, document }, where `document` is the final
 * content of doc.md, read before the directory is removed.
 */
function runInjectorInTemp(files, args = []) {
    const dir = mkdtempSync(join(tmpdir(), 'inject-examples-'));
    const documentPath = join(dir, 'doc.md');
    try {
        for (const [name, text] of Object.entries(files)) {
            writeFileSync(join(dir, name), text, 'utf8');
        }
        const result = invokeInjector([...args, 'doc.md'], dir);
        return { ...result, document: readFileSync(documentPath, 'utf8') };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Character index of every unescaped `|` in a line. */
function pipes(line) {
    const indexes = [];
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') { i++; continue; }
        if (line[i] === '|') indexes.push(i);
    }
    return indexes;
}

describe('fixtures', () => {
    test('there is at least one example', () => {
        expect(EXAMPLES.length).toBeGreaterThan(0);
    });

    test('every example has a unique id and non-empty before/after', () => {
        const ids = EXAMPLES.map((example) => example.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const example of EXAMPLES) {
            expect(example.before.length).toBeGreaterThan(0);
            expect(example.after.length).toBeGreaterThan(0);
            expect(example.before).not.toBe(example.after);
        }
    });

    test('fixtures load with LF endings, whatever the checkout did', () => {
        for (const example of EXAMPLES) {
            expect(example.before).not.toContain('\r');
            expect(example.after).not.toContain('\r');
        }
    });

    test('the examples use a limit below the tool default', () => {
        expect(EXAMPLE_MAX_COL).toBe(25);
        expect(EXAMPLE_MAX_COL).toBeLessThan(MAX_COL);
    });

    test('no example block is wide enough to wrap in a preview', () => {
        for (const example of EXAMPLES) {
            for (const block of [example.before, example.after]) {
                for (const line of block.split('\n')) {
                    expect(line.length).toBeLessThanOrEqual(72);
                }
            }
        }
    });

    for (const example of EXAMPLES) {
        test(`${example.id}: fixTables(before) === after`, () => {
            expect(fixTables(example.before, EXAMPLE_MAX_COL)).toBe(example.after);
        });

        test(`${example.id}: re-running is idempotent`, () => {
            expect(fixTables(example.after, EXAMPLE_MAX_COL)).toBe(example.after);
        });

        test(`${example.id}: README "before" block matches the fixture`, () => {
            expect(readmeBlock(markerFor(example.id, 'before'))).toBe(example.before);
        });

        test(`${example.id}: README "after" block matches the fixture`, () => {
            expect(readmeBlock(markerFor(example.id, 'after'))).toBe(example.after);
        });
    }
});

describe('fixTables', () => {
    test('lines that do not start with a pipe are copied verbatim', () => {
        const input = [
            '# Title',
            '',
            'A | B',
            '--- | ---',
            '1 | 2',
            '',
            'trailing prose',
        ].join('\n');

        expect(fixTables(input)).toBe(input);
    });

    test('a block whose row 2 is not a separator is still aligned, but gets no separator', () => {
        const input = ['| A | B |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
        const after = fixTables(input).split('\n');

        expect(after).toHaveLength(3);
        for (const line of after) expect(pipes(line)).toEqual(pipes(after[0]));
        expect(after[1]).not.toContain('-');
    });

    test('every row ends its columns on the same pipe indexes', () => {
        const before = EXAMPLES[0].before;
        const after = fixTables(before, EXAMPLE_MAX_COL);
        const expected = pipes(after.split('\n')[0]);

        // These are the indexes the README quotes for example 1.
        expect(expected).toEqual([0, 8, 23, 44]);
        for (const line of after.split('\n')) {
            expect(pipes(line)).toEqual(expected);
        }
    });

    test('Rule 1: a cell at or over the limit does not widen its column', () => {
        const huge = 'x'.repeat(150);
        const before = [
            '| ID | Summary |',
            '| --- | --- |',
            `| 1 | ${huge} |`,
            '| 2 | Short. |',
        ].join('\n');

        const after = fixTables(before).split('\n');
        const widthOfShortRow = pipes(after[3]);

        // The short row still aligns with the header: the huge cell was ignored.
        expect(widthOfShortRow).toEqual(pipes(after[0]));
        // ...and the huge cell is the only thing that runs long.
        expect(after[2]).toContain(huge);
        expect(pipes(after[2])[2]).toBeGreaterThan(pipes(after[0])[2]);
    });

    test('Rule 2: padding after an overrun returns to the column boundary', () => {
        const after = fixTables(EXAMPLES[2].before, EXAMPLE_MAX_COL).split('\n');
        const last = pipes(after[0]).at(-1);

        for (const line of after) {
            expect(pipes(line).at(-1)).toBe(last);
        }
        // The delimiter right after the oversized cell is the one that moves...
        const longRow = pipes(after[3]);
        expect(longRow[2]).toBeGreaterThan(pipes(after[1])[2]);
        // ...and these are the indexes the README quotes for example 3.
        expect(pipes(after[2])).toEqual([0, 6, 33, 57]);
        expect(longRow).toEqual([0, 6, 45, 57]);
    });

    test('content is never truncated', () => {
        const before = EXAMPLES[2].before;
        const after = fixTables(before, EXAMPLE_MAX_COL);

        for (const line of before.split('\n')) {
            for (const cell of line.split('|').map((c) => c.trim()).filter(Boolean)) {
                expect(after).toContain(cell);
            }
        }
    });

    test('a row with fewer cells gets empty cells appended', () => {
        const after = fixTables(EXAMPLES[1].before, EXAMPLE_MAX_COL).split('\n');
        expect(after[2]).toBe('| 1    | Cut the release branch  |       |');
    });

    test('the separator is regenerated with at least MIN_COL dashes', () => {
        const after = fixTables(['| Name | Role |', '| --- | --- |', '| Ada | Engineer |'].join('\n'));
        const separator = after.split('\n')[1];
        const widths = separator.split('|').slice(1, -1).map((cell) => cell.trim().length);

        expect(widths).toEqual([4, 8]);
        for (const width of widths) expect(width).toBeGreaterThanOrEqual(MIN_COL);
    });

    test('alignment colons are preserved', () => {
        const before = ['| A | B |', '| :--- | ---: |', '| 1 | 2 |'].join('\n');
        const after = fixTables(before).split('\n');

        // Left and right alignment keep their colon on its own side, and the
        // separator cell stays the same width as the column it heads.
        expect(after[1]).toBe('| :--- | ---: |');
        expect(after[0]).toBe('| A    | B    |');
        for (const line of after) expect(pipes(line)).toEqual([0, 7, 14]);
    });

    test('every alignment survives: left, right, centre and plain', () => {
        const before = [
            '| Left | Right | Centre | Plain |',
            '| :--- | ---: | :---: | --- |',
            '| 1 | 2 | 3 | 4 |',
        ].join('\n');
        const after = fixTables(before).split('\n');

        expect(after[1]).toBe('| :--- | ----: | :----: | ----- |');
        for (const line of after) expect(pipes(line)).toEqual([0, 7, 15, 24, 32]);
    });

    test('a separator wider than the content keeps its columns aligned', () => {
        const before = ['| A | B |', '| :--- | :---: |', '| 1 | 2 |'].join('\n');
        const after = fixTables(before).split('\n');

        // The `:---:` cell is five characters wide, so its column measures five
        // even though the text above it is one character.
        expect(after).toEqual([
            '| A    | B     |',
            '| :--- | :---: |',
            '| 1    | 2     |',
        ]);
        for (const line of after) expect(pipes(line)).toEqual([0, 7, 15]);
    });

    test('a narrow aligned column keeps two dashes beside its colon', () => {
        const before = ['| A | B |', '| :--- | ---: |'].join('\n');
        const after = fixTables(before);

        // Both cells carry one character. The `:---` cell is four wide, so the
        // column measures four — and the rebuilt cell is `:` plus three dashes,
        // never the illegal-in-spirit `:-` that would fit a bare 3-wide column.
        expect(after).toBe([
            '| A    | B    |',
            '| :--- | ---: |',
        ].join('\n'));
        expect(fixTables(after)).toBe(after);
    });

    test('a 3-wide column keeps a legal colon form', () => {
        // Already at the floor: one character of content and a two-dash
        // separator, so there is no room for a third dash.
        const before = ['| A |', '| :-- |'].join('\n');
        expect(fixTables(before)).toBe('| A   |\n| :-- |');
    });

    test('a table with no alignment markers gains none', () => {
        const before = ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
        expect(fixTables(before)).not.toContain(':');
    });

    test('preserved alignment is idempotent', () => {
        const before = [
            '| Left | Right | Centre | Plain |',
            '| :--- | ---: | :---: | --- |',
            '| 1 | 2 | 3 | 4 |',
        ].join('\n');

        const once = fixTables(before);
        expect(fixTables(once)).toBe(once);
    });

    test('an escaped pipe does not split its cell', () => {
        const before = ['| Pattern | Meaning |', '| --- | --- |', '| a \\| b | alternation |'].join('\n');
        const after = fixTables(before).split('\n');

        expect(after[2]).toContain('a \\| b');
        expect(pipes(after[2])).toEqual(pipes(after[0]));
    });

    test('a shorter max column width ignores more cells', () => {
        const before = ['| A | B |', '| --- | --- |', `| ${'x'.repeat(20)} | short |`].join('\n');

        // With the default 100, the 20-char cell sets the width of column A.
        expect(fixTables(before).split('\n')[0]).toBe('| ' + 'A'.padEnd(20) + ' | B     |');
        // With maxCol = 10, it is ignored and the header alone sets the width.
        expect(fixTables(before, 10).split('\n')[0]).toBe('| A   | B     |');
    });

    test('a fenced code block is never a table', () => {
        const untouched = [
            // A code sample that shows a table.
            'before:\n\n```markdown\n| A | B |\n|---|---|\n| 1 | 2 |\n```\n',
            // A diagram drawn with pipes.
            'flow:\n\n~~~\nstart\n   |\n   v\nend\n~~~\n',
            // A Java continuation line that starts with `||`.
            '```java\nassertTrue(a.contains("x")\n        || b.contains("y"));\n```\n',
            // A fence closes only on its own character, at least as long: a
            // tilde run inside a backtick fence is content.
            '```\n| a | b |\n~~~\n| c | d |\n```\n',
            // An unclosed fence swallows the rest of the document.
            '```\n| a | b |\n| --- | --- |\n',
        ];
        for (const input of untouched) expect(fixTables(input)).toBe(input);

        // A table on either side of a fence is still aligned.
        const around = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\n| x | y |\n```\n\n| c | d |\n| --- | --- |\n';
        expect(fixTables(around)).toBe(
            '| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\n```\n| x | y |\n```\n\n| c   | d   |\n| --- | --- |\n');
    });

    test('a table row keeps the line ending it arrived with', () => {
        const before = 'prose\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\ntail\r\n';
        expect(fixTables(before))
            .toBe('prose\r\n| a   | b   |\r\n| --- | --- |\r\n| 1   | 2   |\r\ntail\r\n');

        // Mixed endings stay mixed: a row is re-emitted with its own.
        const mixed = '| a | b |\r\n| --- | --- |\n| 1 | 2 |\r\n';
        expect(fixTables(mixed)).toBe('| a   | b   |\r\n| --- | --- |\n| 1   | 2   |\r\n');
    });

    test('an indented table keeps its indentation, so it stays in its list item', () => {
        const nested = '- item\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |\n';
        expect(fixTables(nested)).toBe('- item\n\n  | A   | B   |\n  | --- | --- |\n  | 1   | 2   |\n');

        // The block's indentation is the first row's; a ragged row follows it.
        const ragged = '\t| A | B |\n\t| --- | --- |\n| 1 | 2 |\n';
        expect(fixTables(ragged)).toBe('\t| A   | B   |\n\t| --- | --- |\n\t| 1   | 2   |\n');
    });

    test('a row with more cells than the header never widens the table', () => {
        // The unescaped pipe in the code span splits that cell, exactly as GFM
        // renders it — and a renderer ignores the excess cell, so the header
        // keeps its three columns and the extra cell is kept where it is.
        const before = '| A | B | C |\n| --- | --- | --- |\n| code | `x | y` | note |\n';
        expect(fixTables(before))
            .toBe('| A    | B   | C   |\n| ---- | --- | --- |\n| code | `x  | y`  | note |\n');

        // Fewer cells than the header is the other half: appended empty.
        const fewer = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |\n';
        expect(fixTables(fewer)).toBe('| A   | B   | C   |\n| --- | --- | --- |\n| 1   | 2   |     |\n');
    });

    test('a lone pipe line is not a table', () => {
        expect(fixTables('text\n\n   |\n\nmore text\n')).toBe('text\n\n   |\n\nmore text\n');
        expect(fixTables('|')).toBe('|');
    });

    test('an indented code block is never a table', () => {
        // Four spaces after a blank line is CommonMark's indented code block, and
        // a code sample that shows a table must come through byte for byte.
        const block = 'text\n\n    | A | B |\n    | --- | --- |\n    | 1 | 2 |\n';
        expect(fixTables(block)).toBe(block);

        // It runs to the first line indented less than four, blank lines inside it
        // included.
        const open = 'text\n\n    | A | B |\n\n    | --- | --- |\ntail\n';
        expect(fixTables(open)).toBe(open);

        // At the very start of a document, with no blank line before it.
        const first = '    | A | B |\n    | --- | --- |\n';
        expect(fixTables(first)).toBe(first);

        // A line indented four spaces with no blank line before it is a paragraph
        // continuation, not code — an indented code block cannot interrupt one.
        const afterText = 'text\n    | A | B |\n    | --- | --- |\n';
        expect(fixTables(afterText)).not.toBe(afterText);
    });

    test('a table indented inside a list item is still a table', () => {
        // `- ` puts the item's content at column 2, so four spaces is the item's
        // own indentation 2 — a table, and it keeps its place in the item.
        const nested = '- item\n\n    | A | B |\n    | --- | --- |\n    | 1 | 2 |\n';
        expect(fixTables(nested))
            .toBe('- item\n\n    | A   | B   |\n    | --- | --- |\n    | 1   | 2   |\n');

        // Six spaces under `- ` is four past the item's content, so that one *is*
        // an indented code block inside the item.
        const code = '- item\n\n      | A | B |\n      | --- | --- |\n';
        expect(fixTables(code)).toBe(code);

        // An ordered marker is wider, so its content starts at column 3.
        const ordered = '1. item\n\n   | A | B |\n   | --- | --- |\n';
        expect(fixTables(ordered))
            .toBe('1. item\n\n   | A   | B   |\n   | --- | --- |\n');
    });

    test('MAX_COL is 100', () => {
        expect(MAX_COL).toBe(100);
    });
});

describe('parseArgs', () => {
    /** The parse of an argument list with nothing set. */
    const defaults = { filePath: null, maxCol: MAX_COL, check: false, help: false, version: false };

    test('defaults', () => {
        expect(parseArgs([])).toEqual(defaults);
    });

    test('reads the file path', () => {
        expect(parseArgs(['notes.md']).filePath).toBe('notes.md');
    });

    test('accepts every spelling of max-col', () => {
        expect(parseArgs(['--max-col=50']).maxCol).toBe(50);
        expect(parseArgs(['--max-col', '50']).maxCol).toBe(50);
        expect(parseArgs(['-m', '50']).maxCol).toBe(50);
        expect(parseArgs(['-m=50']).maxCol).toBe(50);
    });

    test('keeps the file path and the option together', () => {
        expect(parseArgs(['--max-col=50', 'notes.md']))
            .toEqual({ ...defaults, filePath: 'notes.md', maxCol: 50 });
    });

    test('accepts -c, -h and -V in both spellings', () => {
        const spellings = [
            [['-c'], 'check'],
            [['--check'], 'check'],
            [['-h'], 'help'],
            [['--help'], 'help'],
            [['-V'], 'version'],
            [['--version'], 'version'],
        ];

        for (const [argv, field] of spellings) {
            expect(parseArgs(argv)).toEqual({ ...defaults, [field]: true });
        }
    });

    test('flags combine with a file path and a width, in any order', () => {
        expect(parseArgs(['--check', '--max-col=25', 'notes.md']))
            .toEqual({ ...defaults, filePath: 'notes.md', maxCol: 25, check: true });
        expect(parseArgs(['notes.md', '-c']).check).toBe(true);
        expect(parseArgs(['-c', '-c']).check).toBe(true);
        expect(parseArgs(['-V', '--help'])).toEqual({ ...defaults, help: true, version: true });
    });

    test('a bad option is still an error beside --help', () => {
        expect(() => parseArgs(['--help', '--nope'])).toThrow('Unknown option: --nope');
        expect(() => parseArgs(['-C'])).toThrow('Unknown option: -C');
        expect(() => parseArgs(['--check=true'])).toThrow('Unknown option: --check=true');
        expect(() => parseArgs(['-c', '--max-col=2'])).toThrow();
    });

    test('rejects a max-col below MIN_COL', () => {
        expect(() => parseArgs(['--max-col=2'])).toThrow();
    });

    test('rejects a non-numeric max-col', () => {
        expect(() => parseArgs(['--max-col=abc'])).toThrow();
    });

    test('rejects an unknown option', () => {
        expect(() => parseArgs(['--nope'])).toThrow();
    });
});

describe('cli', () => {
    const CLI = fileURLToPath(new URL('./md-fix-tables.js', import.meta.url));
    const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

    /** Run the CLI with `args` and `input` on stdin, from `cwd`. */
    function cli(args, input = '', cwd = REPO) {
        const result = spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8' });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    /** Write `content` (LF) as `name` in a fresh temp directory; return dir and path. */
    function tempFile(name, content) {
        const dir = mkdtempSync(join(tmpdir(), 'md-fix-tables-'));
        const path = join(dir, name);
        writeFileSync(path, content, 'utf8');
        return { dir, path };
    }

    const RAGGED = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';

    test('--help prints the usage on stdout and exits 0', () => {
        const result = cli(['--help']);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(HELP);
        expect(result.stderr).toBe('');
        expect(cli(['-h']).stdout).toBe(HELP);
    });

    test('--version prints the published version and exits 0', () => {
        expect(cli(['--version'])).toEqual({ code: 0, stdout: `${PKG.version}\n`, stderr: '' });
        expect(cli(['-V']).stdout).toBe(`${PKG.version}\n`);
    });

    test('--help wins when both are given, and a file is ignored', () => {
        expect(cli(['-V', '--help', 'notes.md']).stdout).toBe(HELP);
    });

    test('--check passes on aligned input and writes nothing', () => {
        const aligned = fixTables(RAGGED);
        expect(cli(['--check'], aligned)).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(cli(['-c', '--max-col=100'], aligned).code).toBe(0);

        const { dir, path } = tempFile('table.md', aligned);
        try {
            expect(cli(['--check', path])).toEqual({ code: 0, stdout: '', stderr: '' });
            expect(readFileSync(path, 'utf8')).toBe(aligned);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('--check fails on unaligned input, in both modes', () => {
        const stdinResult = cli(['--check'], RAGGED);
        expect(stdinResult.code).toBe(1);
        expect(stdinResult.stdout).toBe('');
        expect(stdinResult.stderr).toBe('Error: <stdin> is not aligned\n');

        const { dir, path } = tempFile('table.md', RAGGED);
        try {
            const fileResult = cli(['--check', path]);
            expect(fileResult.code).toBe(1);
            expect(fileResult.stderr).toContain('is not aligned');
            // The file is reported, never repaired.
            expect(readFileSync(path, 'utf8')).toBe(RAGGED);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('--check obeys --max-col', () => {
        // 30 characters: a column of its own at the default limit, ignored at 25.
        const input = `| a | ${'x'.repeat(30)} |\n| --- | --- |\n| 1 | 2 |\n`;
        const aligned = fixTables(input);

        expect(cli(['--check'], aligned).code).toBe(0);
        expect(cli(['--check', '--max-col=25'], aligned).code).toBe(1);
        expect(cli(['--check', '--max-col=25'], fixTables(input, 25)).code).toBe(0);
    });

    test('--check reports a file it cannot read like any other run', () => {
        const result = cli(['--check', 'no-such-file-here.md']);
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/^Error: ENOENT/);
    });

    test('a normal run still rewrites the file in place', () => {
        const { dir, path } = tempFile('table.md', RAGGED);
        try {
            const result = cli([path]);
            expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
            expect(readFileSync(path, 'utf8')).toBe(fixTables(RAGGED));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('packaging', () => {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    const rootZig = readFileSync(new URL('./src/root.zig', import.meta.url), 'utf8');
    const buildZon = readFileSync(new URL('./build.zig.zon', import.meta.url), 'utf8');

    test('the JS, the Zig port and build.zig.zon agree on the version', () => {
        // `--version` reads package.json on the JS side and the literal in
        // root.zig on the Zig side, so a bump that misses one of these would
        // make the two tools disagree.
        expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(rootZig).toContain(`pub const VERSION = "${pkg.version}"`);
        expect(buildZon).toContain(`.version = "${pkg.version}"`);
    });

    test('the package publishes the CLI, the README and the LICENSE', () => {
        expect(pkg.name).toBe('@hrg/md-fix-tables');
        expect(pkg.bin).toEqual({ 'md-fix-tables': 'md-fix-tables.js' });
        expect(pkg.files).toEqual(['md-fix-tables.js', 'README.md', 'LICENSE']);
        expect(pkg.publishConfig).toEqual({ access: 'public' });
    });
});

describe('region directives', () => {
    /** A document with one region marker and an empty block, over `source` as source.txt. */
    function regionFiles(source, region) {
        return {
            'source.txt': source,
            'doc.md': `[source.txt](./source.txt#region:${region})\n\n\`\`\`markdown\n\n\`\`\``,
        };
    }

    /** The block the CLI wrote after the marker in the updated document. */
    function injectedBlock(result, region) {
        return blockAfter(result.document, `[source.txt](./source.txt#region:${region})`);
    }

    test('accepts the spelling of every editor that supports regions', () => {
        const spellings = [
            ['#region demo', '#endregion'],
            ['// #region demo', '// #endregion'],
            ['//region demo', '//endregion'],
            ['    // #region demo', '  // #endregion'],
            ['<!-- #region demo -->', '<!-- #endregion -->'],
            ['/* #region demo */', '/* #endregion */'],
            ['-- #region demo', '-- #endregion'],
            ['; #region demo', '; #endregion'],
        ];

        for (const [start, end] of spellings) {
            const result = runInjectorInTemp(regionFiles([start, 'body', end].join('\n'), 'demo'));
            expect(result.code).toBe(0);
            expect(injectedBlock(result, 'demo')).toBe('body');
        }
    });

    test('a markdown heading or bare prose line is not a directive', () => {
        // A line that looks like a region directive must not be read as one:
        // without a comment prefix the C# `#region` spelling is required, and a
        // space after the `#` already breaks it. Each line below contains the
        // region name it would claim, yet naming that region fails.
        const prose = [
            ['# Region of interest', 'interest'],
            ['## Region', 'Region'],
            ['region of interest', 'interest'],
            ['# region demo', 'demo'],
        ];

        for (const [heading, name] of prose) {
            const result = runInjectorInTemp(regionFiles(heading, name));
            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(new RegExp(`no "#region ${name}" found`));
        }

        // The unambiguous C# spelling, by contrast, is a directive.
        const result = runInjectorInTemp(regionFiles(['#region demo', 'body', '#endregion'].join('\n'), 'demo'));
        expect(result.code).toBe(0);
        expect(injectedBlock(result, 'demo')).toBe('body');
    });

    test('picks the region by name and ignores the others', () => {
        const source = [
            '#region one',
            'first',
            '#endregion',
            '#region two',
            'second',
            '#endregion',
        ].join('\n');

        const one = runInjectorInTemp(regionFiles(source, 'one'));
        expect(one.code).toBe(0);
        expect(injectedBlock(one, 'one')).toBe('first');

        const two = runInjectorInTemp(regionFiles(source, 'two'));
        expect(two.code).toBe(0);
        expect(injectedBlock(two, 'two')).toBe('second');
    });

    test('keeps the body byte for byte, indentation included', () => {
        const source = ['#region demo', '  indented  ', '', 'last', '#endregion'].join('\n');
        const result = runInjectorInTemp(regionFiles(source, 'demo'));
        expect(result.code).toBe(0);
        expect(injectedBlock(result, 'demo')).toBe('  indented  \n\nlast');
    });

    test('a missing region is an error', () => {
        const result = runInjectorInTemp(regionFiles(['#region demo', 'body', '#endregion'].join('\n'), 'nope'));
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/no "#region nope" found/);
    });

    test('a duplicated region name is an error', () => {
        const source = ['#region demo', 'a', '#endregion', '#region demo', 'b', '#endregion'].join('\n');
        const result = runInjectorInTemp(regionFiles(source, 'demo'));
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/appears 2 times/);
    });

    test('an unterminated region is an error', () => {
        const result = runInjectorInTemp(regionFiles(['#region demo', 'a'].join('\n'), 'demo'));
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/never closed/);
    });
});

describe('markers', () => {
    const wholeFile = '[fixtures/example-1/before.md](./fixtures/example-1/before.md)';

    /** A document holding just `marker` and an empty block, plus any extra files. */
    function markerFiles(marker, extraFiles = {}) {
        return {
            ...extraFiles,
            'doc.md': `${marker}\n\n\`\`\`markdown\n\n\`\`\``,
        };
    }

    test('reads a whole-file marker', () => {
        const result = runInjectorInTemp(markerFiles(wholeFile), ['--root', REPO]);
        expect(result.code).toBe(0);
        expect(blockAfter(result.document, wholeFile)).toBe(EXAMPLES[0].before);
    });

    test('reads a region marker', () => {
        const marker = '[source.txt](./source.txt#region:table)';
        const result = runInjectorInTemp(markerFiles(marker, {
            'source.txt': ['#region table', '| A | B |', '#endregion'].join('\n'),
        }));
        expect(result.code).toBe(0);
        expect(blockAfter(result.document, marker)).toBe('| A | B |');
    });

    test('ignores lines that are not a bare link', () => {
        const lines = [
            'see [the docs](https://example.com) first',
            '',
            '```markdown',
        ];

        for (const line of lines) {
            const result = runInjectorInTemp({ 'doc.md': line }, ['--check', '--allow-empty']);
            expect(result.code).toBe(0);
            expect(result.stdout).toMatch(/no markers, nothing to do/);
        }
    });

    test('ignores a link whose label is not its own path', () => {
        const lines = [
            '[the docs](https://example.com)',
            '[before.md](./fixtures/example-1/before.md)',
        ];

        for (const line of lines) {
            const result = runInjectorInTemp({ 'doc.md': line }, ['--check', '--allow-empty']);
            expect(result.code).toBe(0);
            expect(result.stdout).toMatch(/no markers, nothing to do/);
        }
    });

    test('ignores an ordinary anchor fragment', () => {
        const line = '[fixtures/example-1/before.md](./fixtures/example-1/before.md#section)';
        const result = runInjectorInTemp({ 'doc.md': line }, ['--check', '--allow-empty']);
        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/no markers, nothing to do/);
    });

    test('resolves the region a marker names', () => {
        const marker = markerFor('example-4', 'before');
        const result = runInjectorInTemp(markerFiles(marker), ['--root', REPO]);
        expect(result.code).toBe(0);
        expect(blockAfter(result.document, marker)).toBe(readmeBlock(marker));
    });

    test('every marker in README.md resolves to the block below it', () => {
        const result = invokeInjector(['--check', '--no-gitignore', 'README.md'], REPO);
        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(new RegExp(`matches all ${EXAMPLES.length * 2} marker\\(s\\)`));
    });

    test('example-4 takes its before from a region, not a whole file', () => {
        expect(markerFor('example-4', 'before')).toContain('#region:table');
        expect(markerFor('example-4', 'after')).not.toContain('#region:');
        expect(EXAMPLES.find((example) => example.id === 'example-4').before).not.toContain('#region');
    });
});
