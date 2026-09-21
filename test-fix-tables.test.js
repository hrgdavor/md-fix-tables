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
 * `node tools/inject-examples.mjs`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fixTables, parseArgs, MAX_COL, MIN_COL } from './md-fix-tables.js';
import {
    EXAMPLE_MAX_COL,
    EXAMPLES,
    extractRegion,
    findMarkers,
    markerFor,
    parseMarker,
    regionDirective,
    resolveMarker,
} from './test-fixtures.js';

const README = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

/** The body of the fenced block that follows `marker` in README.md. */
function readmeBlock(marker) {
    const lines = README.split('\n');
    const markerIndex = lines.findIndex((line) => line.trim() === marker);
    if (markerIndex === -1) throw new Error(`marker not found in README.md: ${marker}`);

    const open = lines.findIndex((line, i) => i > markerIndex && line.startsWith('```'));
    if (open === -1) throw new Error(`no code block after ${marker}`);

    const close = lines.findIndex((line, i) => i > open && line.startsWith('```'));
    if (close === -1) throw new Error(`unclosed code block after ${marker}`);

    return lines.slice(open + 1, close).join('\n');
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

    test('alignment colons are dropped', () => {
        const before = ['| A | B |', '| :--- | ---: |', '| 1 | 2 |'].join('\n');
        const after = fixTables(before);

        expect(after).not.toContain(':');
        expect(after.split('\n')[1]).toBe('| --- | --- |');
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
            const source = [start, 'body', end].join('\n');
            expect(regionDirective(start)).toEqual({ kind: 'region', name: 'demo' });
            expect(extractRegion(source, 'demo')).toBe('body');
        }
    });

    test('a markdown heading is prose, not a directive', () => {
        expect(regionDirective('# Region of interest')).toBeNull();
        expect(regionDirective('## Region')).toBeNull();
        expect(regionDirective('region of interest')).toBeNull();
        expect(regionDirective('#region of interest')).toEqual({ kind: 'region', name: 'of interest' });
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

        expect(extractRegion(source, 'one')).toBe('first');
        expect(extractRegion(source, 'two')).toBe('second');
    });

    test('keeps the body byte for byte, indentation included', () => {
        const source = ['#region demo', '  indented  ', '', 'last', '#endregion'].join('\n');
        expect(extractRegion(source, 'demo')).toBe('  indented  \n\nlast');
    });

    test('a missing region is an error', () => {
        const source = ['#region demo', 'body', '#endregion'].join('\n');
        expect(() => extractRegion(source, 'nope')).toThrow(/no "#region nope" found/);
    });

    test('a duplicated region name is an error', () => {
        const source = ['#region demo', 'a', '#endregion', '#region demo', 'b', '#endregion'].join('\n');
        expect(() => extractRegion(source, 'demo')).toThrow(/appears 2 times/);
    });

    test('an unterminated region is an error', () => {
        const source = ['#region demo', 'a'].join('\n');
        expect(() => extractRegion(source, 'demo')).toThrow(/never closed/);
    });
});

describe('markers', () => {
    const wholeFile = '[fixtures/example-1/before.md](./fixtures/example-1/before.md)';
    const regionFile = '[fixtures/example-4/source.md](./fixtures/example-4/source.md#region:table)';

    test('reads a whole-file marker', () => {
        expect(parseMarker(wholeFile)).toEqual({
            raw: wholeFile,
            path: 'fixtures/example-1/before.md',
            region: null,
        });
    });

    test('reads a region marker', () => {
        expect(parseMarker(regionFile)).toEqual({
            raw: regionFile,
            path: 'fixtures/example-4/source.md',
            region: 'table',
        });
    });

    test('ignores lines that are not a bare link', () => {
        expect(parseMarker('see [the docs](https://example.com) first')).toBeNull();
        expect(parseMarker('')).toBeNull();
        expect(parseMarker('```markdown')).toBeNull();
    });

    test('ignores a link whose label is not its own path', () => {
        expect(parseMarker('[the docs](https://example.com)')).toBeNull();
        expect(parseMarker('[before.md](./fixtures/example-1/before.md)')).toBeNull();
    });

    test('ignores an ordinary anchor fragment', () => {
        expect(parseMarker('[fixtures/example-1/before.md](./fixtures/example-1/before.md#section)')).toBeNull();
    });

    test('resolves the region a marker names', () => {
        const marker = parseMarker(markerFor('example-4', 'before'));
        const example = EXAMPLES.find((candidate) => candidate.id === 'example-4');

        expect(marker.region).toBe('table');
        expect(resolveMarker(marker)).toBe(example.before);
    });

    test('every marker in README.md resolves to the block below it', () => {
        const markers = findMarkers(README.split('\n'));

        expect(markers.length).toBe(EXAMPLES.length * 2);
        for (const marker of markers) {
            expect(readmeBlock(marker.raw)).toBe(resolveMarker(marker));
        }
    });

    test('example-4 takes its before from a region, not a whole file', () => {
        expect(markerFor('example-4', 'before')).toContain('#region:table');
        expect(markerFor('example-4', 'after')).not.toContain('#region:');
        expect(EXAMPLES.find((example) => example.id === 'example-4').before).not.toContain('#region');
    });
});
