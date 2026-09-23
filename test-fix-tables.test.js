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
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixTables, parseArgs, MAX_COL, MIN_COL } from './md-fix-tables.js';
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

    test('MAX_COL is 100', () => {
        expect(MAX_COL).toBe(100);
    });
});

describe('parseArgs', () => {
    test('defaults', () => {
        expect(parseArgs([])).toEqual({ filePath: null, maxCol: MAX_COL });
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
        expect(parseArgs(['--max-col=50', 'notes.md'])).toEqual({ filePath: 'notes.md', maxCol: 50 });
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
