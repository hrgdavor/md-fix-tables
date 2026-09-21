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
 * tools/inject-examples.mjs copies both into README.md after the link that names
 * them, so the README cannot drift from them, and test-fix-tables.test.js fails
 * if the tool stops agreeing with any `after`.
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

/** LF endings, and no trailing newline: exactly the text between README's fences. */
function normalize(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

// `//`, `#`, `--`, `;`, `%`, `'`, REM, <!-- and /* ... */ are all comment
// spellings seen in the wild; strip whichever one opens the line.
const COMMENT_OPENER = /^(?:(?:\/\/|--|;|%|'|REM\b|<!--|\/\*|\*)\s*)+/i;
const COMMENT_CLOSER = /\s*(?:-->|\*\/)$/;

/**
 * Read one line as a region directive, or return null.
 * Returns `{ kind: 'region' | 'endregion', name }`.
 */
export function regionDirective(line) {
    let text = line.trim();

    const closer = COMMENT_CLOSER.exec(text);
    if (closer) text = text.slice(0, closer.index).trim();

    const commented = COMMENT_OPENER.test(text);
    if (commented) text = text.replace(COMMENT_OPENER, '').trim();

    const match = /^(#?)(region|endregion)\b\s*(.*)$/i.exec(text);
    if (!match) return null;
    // A bare `region foo` line is prose, not a directive: without a comment
    // prefix the C# spelling (`#region`) is required.
    if (!commented && match[1] !== '#') return null;

    return { kind: match[2].toLowerCase(), name: match[3].trim() };
}

/** The lines between `#region <name>` and the next `#endregion`, exclusive. */
export function extractRegion(text, name) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const starts = [];
    const ends = [];

    lines.forEach((line, index) => {
        const directive = regionDirective(line);
        if (!directive) return;
        if (directive.kind === 'region') {
            if (directive.name === name) starts.push(index);
        } else {
            ends.push(index);
        }
    });

    if (starts.length === 0) throw new Error(`no "#region ${name}" found`);
    if (starts.length > 1) {
        throw new Error(`"#region ${name}" appears ${starts.length} times; region names must be unique`);
    }

    const end = ends.find((index) => index > starts[0]);
    if (end === undefined) throw new Error(`"#region ${name}" is never closed by an #endregion`);

    return lines.slice(starts[0] + 1, end).join('\n');
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

/**
 * Read one README line as an injection marker, or return null.
 *
 * A marker is a line that is nothing but a link to a real path, labelled with
 * that same path — optionally naming a region in the fragment:
 *
 *     [fixtures/example-1/before.md](./fixtures/example-1/before.md)
 *     [fixtures/example-4/source.md](./fixtures/example-4/source.md#region:table)
 *
 * Returns `{ raw, path, region }`.
 */
export function parseMarker(line) {
    const match = LINK.exec(line.trim());
    if (!match) return null;

    const [, label, destination] = match;
    const hash = destination.indexOf('#');
    const path = hash === -1 ? destination : destination.slice(0, hash);
    const fragment = hash === -1 ? '' : destination.slice(hash + 1);

    const withoutDotSlash = (value) => value.replace(/^\.\//, '');
    if (withoutDotSlash(label) !== withoutDotSlash(path)) return null;

    // Normalise away a leading `./` so `path` is directly usable as a path.
    const relativePath = withoutDotSlash(path);

    if (fragment === '') return { raw: line.trim(), path: relativePath, region: null };

    // An unknown fragment means this is an ordinary link, not a marker.
    const region = /^region:(.+)$/.exec(fragment);
    if (!region) return null;
    return { raw: line.trim(), path: relativePath, region: region[1] };
}

/** Every marker line in a document, in order. */
export function findMarkers(lines) {
    const markers = [];
    for (const line of lines) {
        const marker = parseMarker(line);
        if (marker) markers.push(marker);
    }
    return markers;
}

/** The text a marker stands for: a whole file, or one region of one. */
export function resolveMarker(marker) {
    const text = readRepoFile(marker.path);
    return marker.region ? extractRegion(text, marker.region) : normalize(text);
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
    return region ? extractRegion(text, region) : normalize(text);
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
