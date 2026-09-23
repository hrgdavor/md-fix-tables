/**
 * Example fixtures — one source of truth for the README examples, the tests and
 * the links in the docs.
 *
 * Each example is a folder under fixtures/ holding two files:
 *
 *     fixtures/example-1/before.md   a table as written by hand
 *     fixtures/example-1/after.md    byte-for-byte what fixTables(before) returns
 *
 * A `before.md` is deliberately ragged — do not run md-fix-tables.js over one.
 * The published `@hrg/inject-examples` tool (run through bunx, see package.json)
 * copies both into README.md after the link that names them, so the README
 * cannot drift from them, and test-fix-tables.test.js fails if the tool stops
 * agreeing with any `after`.
 *
 * A side of an example can also come from one *region* of a larger file, so a
 * README block can show part of a document instead of the whole thing. Mark the
 * part to inject with the region convention the major editors share:
 *
 *     // #region table          (VS Code; `#region` is the C# spelling and
 *     ...lines to inject...      `//region` the JetBrains one — any comment
 *     // #endregion              prefix is accepted)
 *
 * and name that region in the marker:
 *
 *     [fixtures/example-4/source.md](./fixtures/example-4/source.md#region:table)
 *
 * The marker and region grammar itself lives in the published tool, so the docs
 * it generates and the tests that check them cannot disagree about it.
 */

import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('.', import.meta.url);
const WHICH = ['before', 'after'];

/**
 * The README examples are generated with a smaller limit than the tool's default
 * (`MAX_COL` = 100) so the tables stay narrow enough not to wrap in a Markdown
 * preview. Every fixture's `after.md` is `fixTables(before, EXAMPLE_MAX_COL)`.
 */
export const EXAMPLE_MAX_COL = 25;

/** Examples whose side comes from a region of a larger file, not a whole file. */
const REGION_SOURCES = {
    'example-4': { before: { file: 'source.md', region: 'table' } },
};

/** Fixture folder names, e.g. ['example-1', 'example-2', 'example-3', ...]. */
export const IDS = readdirSync(new URL('fixtures/', ROOT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

function readRepoFile(relativePath) {
    return readFileSync(new URL(relativePath, ROOT), 'utf8');
}

/** LF endings, no trailing newline: the text a block should hold. */
function normalize(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

/**
 * The lines of the named `#region` block in a fixture source. Fixture loading
 * only: the full region grammar (every spelling, every error) is what the
 * CLI-based tests in test-fix-tables.test.js verify against the published tool.
 */
function regionOf(text, name) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex((line) => line.includes(`#region ${name}`));
    if (start === -1) throw new Error(`no "#region ${name}" in fixture source`);
    const end = lines.findIndex((line, i) => i > start && line.includes('#endregion'));
    if (end === -1) throw new Error(`"#region ${name}" is never closed`);
    return lines.slice(start + 1, end).join('\n');
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

function sourceFor(id, which) {
    if (!WHICH.includes(which)) throw new Error(`which must be one of ${WHICH}, got: ${which}`);
    const spec = REGION_SOURCES[id]?.[which];
    return spec
        ? { file: spec.file, region: spec.region ?? null }
        : { file: `${which}.md`, region: null };
}

/** Path of the file one side of an example comes from, relative to README.md. */
export function fixturePath(id, which) {
    return `fixtures/${id}/${sourceFor(id, which).file}`;
}

/** The marker line that precedes that side's block in README.md. */
export function markerFor(id, which) {
    const { region } = sourceFor(id, which);
    const path = fixturePath(id, which);
    return region ? `[${path}](./${path}#region:${region})` : `[${path}](./${path})`;
}

/** The text that side stands for — resolving a region when it has one. */
export function fixtureContent(id, which) {
    const { region } = sourceFor(id, which);
    const text = readRepoFile(fixturePath(id, which));
    return normalize(region ? regionOf(text, region) : text);
}

export const EXAMPLES = IDS.map((id) => ({
    id,
    before: fixtureContent(id, 'before'),
    after: fixtureContent(id, 'after'),
}));

/** Look up a fixture by id, throwing if the id is unknown. */
export function exampleById(id) {
    const found = EXAMPLES.find((example) => example.id === id);
    if (!found) throw new Error(`Unknown example id: ${id}`);
    return found;
}
