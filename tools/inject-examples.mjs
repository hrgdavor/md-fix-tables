#!/usr/bin/env node

/**
 * Injects file content into README.md, at the markers that name it.
 *
 * A marker is a line that is nothing but a link to a real path, labelled with
 * that same path:
 *
 *     [fixtures/example-1/before.md](./fixtures/example-1/before.md)
 *
 *     ```markdown
 *     ...                      <- replaced byte-for-byte from that file
 *     ```
 *
 * The fragment can name a region, to inject part of a larger file rather than
 * all of it:
 *
 *     [fixtures/example-4/source.md](./fixtures/example-4/source.md#region:table)
 *
 * A region runs from `#region <name>` to the matching `#endregion`, under any
 * language's comment prefix (`#region`, `// #region`, `//region`,
 * `<!-- #region -->`, or a C-style block comment), and the directive lines
 * themselves are not injected — only what lies between them.
 *
 * Because the content is copied verbatim, the README cannot show a block that
 * differs from the file the tests use.
 *
 *   node tools/inject-examples.mjs            rewrite README.md in place
 *   node tools/inject-examples.mjs --check     exit 1 if README.md is stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findMarkers, resolveMarker } from '../test-fixtures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');
const FENCE = '```';

/**
 * Replace the body of the fenced block that follows `marker` in `lines`.
 * Returns the new line array, or throws when the marker/fence is malformed.
 */
function injectInto(lines, marker, content) {
    const markerIndex = lines.findIndex((line) => line.trim() === marker);
    if (markerIndex === -1) throw new Error(`marker not found in README.md: ${marker}`);

    let open = -1;
    for (let i = markerIndex + 1; i < lines.length; i++) {
        if (lines[i].startsWith(FENCE)) { open = i; break; }
        if (lines[i].trim() !== '') {
            throw new Error(`expected a fenced code block right after ${marker}`);
        }
    }
    if (open === -1) throw new Error(`no code block after ${marker}`);

    let close = -1;
    for (let i = open + 1; i < lines.length; i++) {
        if (lines[i].startsWith(FENCE)) { close = i; break; }
    }
    if (close === -1) throw new Error(`unclosed code block after ${marker}`);

    const current = lines.slice(open + 1, close).join('\n');
    const next = [...lines.slice(0, open + 1), ...content.split('\n'), ...lines.slice(close)];

    return { lines: next, changed: current !== content };
}

function main(argv) {
    const check = argv.includes('--check');
    const original = readFileSync(README, 'utf8');
    let lines = original.split('\n');

    const markers = findMarkers(lines);
    if (markers.length === 0) throw new Error('no injection markers found in README.md');

    const seen = new Set();
    const results = [];

    for (const marker of markers) {
        if (seen.has(marker.raw)) throw new Error(`duplicate marker in README.md: ${marker.raw}`);
        seen.add(marker.raw);

        let content;
        try {
            content = resolveMarker(marker);
        } catch (err) {
            throw new Error(`${marker.raw}: ${err.message}`);
        }

        const result = injectInto(lines, marker.raw, content);
        lines = result.lines;
        results.push({ marker, changed: result.changed });
    }

    const updated = lines.join('\n');
    const stale = results.filter((result) => result.changed);

    for (const { marker, changed } of results) {
        console.log(`${changed ? 'updated ' : 'ok      '} ${marker.raw}`);
    }

    if (check) {
        if (stale.length > 0) {
            console.error(`\nREADME.md is stale: ${stale.length} of ${results.length} block(s) differ from their files.`);
            console.error('Run: npm run inject:examples');
            return 1;
        }
        console.log(`\nREADME.md matches all ${results.length} markers.`);
        return 0;
    }

    if (updated !== original) writeFileSync(README, updated, 'utf8');
    console.log(`\nREADME.md ${updated === original ? 'already up to date' : 'updated'}.`);
    return 0;
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
}
