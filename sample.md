# Sample Markdown File with Tables

## Before Fixing

| Column A | Column B | Column C |
|----------|----------|----------|
| Short    | Medium   | Long     |
| This is a very long cell that exceeds 100 characters and should not affect column width measurement. It will be displayed without padding adjustments. | Normal content here | Another normal cell |

## After Fixing

Run: `bun index.js sample.md` or `node index.js sample.md`

The table above will have its columns properly aligned with delimiters at consistent positions.
