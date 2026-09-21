#!/usr/bin/env node

/**
 * md-fix-tables — Markdown table aligner
 * 
 * Re-formats every pipe table in a Markdown file so that column delimiters line up
 * as far as the content allows, without ever truncating a cell.
 */

import { readFileSync, writeFileSync } from 'fs';

const MAX_COL = 100;   // at/above this, a cell neither sets a width nor gets padding (default)
const MIN_COL = 3;     // smallest separator (---)

/**
 * Measure column widths for a table block.
 * Returns an array of widths, one per column.
 */
function measureColumns(lines, maxCol = MAX_COL) {
    const nCols = Infinity;
    let maxColWidth = -1;
    
    // First pass: find the maximum number of columns
    for (const line of lines) {
        if (!line.startsWith('|')) continue;
        
        // Count delimiters to determine column count
        const matches = line.matchAll(/(?<!\\)\|/g);
        let colCount = 0;
        for (const match of matches) {
            colCount++;
        }
        maxColWidth = Math.max(maxColWidth, colCount);
    }
    
    if (maxColWidth === -1 || maxColWidth === Infinity) return [];
    
    // Initialize widths to MIN_COL
    const widths = new Array(maxColWidth).fill(MIN_COL);
    
    // Second pass: measure each column
    for (const line of lines) {
        if (!line.startsWith('|')) continue;
        
        // Extract cell contents and their lengths
        const cells = [];
        let pos = 1; // Start after first |
        
        while (pos < line.length) {
            const delimIdx = line.indexOf('|', pos);
            if (delimIdx === -1) break;
            
            const cellContent = line.slice(pos, delimIdx).trim();
            cells.push(cellContent);
            
            pos = delimIdx + 1;
        }
        
        // Update widths for each column
        for (let i = 0; i < cells.length && i < maxColWidth; i++) {
            const len = cells[i].length;
            if (len < maxCol) {
                widths[i] = Math.max(widths[i], len);
            }
        }
    }
    
    return widths;
}

/**
 * Check if a line is a separator row.
 */
function isSeparatorRow(line) {
    // Extract cell contents and check if all match ^:?-{3,}:?$
    const cells = [];
    let pos = 1;
    
    while (pos < line.length) {
        const delimIdx = line.indexOf('|', pos);
        if (delimIdx === -1) break;
        
        const cellContent = line.slice(pos, delimIdx).trim();
        cells.push(cellContent);
        
        pos = delimIdx + 1;
    }
    
    // Check if all cells match the separator pattern
    for (const cell of cells) {
        if (!/^:?-{3,}:?$/.test(cell)) return false;
    }
    
    return true;
}

/**
 * Process a complete table block.
 */
function processTable(block, maxCol = MAX_COL) {
    // Parse the line into cells and delimiters
    const parts = [];
    let pos = 0;
    
    if (line.startsWith('|')) {
        pos = 1;
        parts.push({ content: '', len: 0 });
    }
    
    while (pos < line.length) {
        const delimIdx = line.indexOf('|', pos);
        if (delimIdx === -1) break;
        
        const cellContent = line.slice(pos, delimIdx).trim();
        parts.push({ content: cellContent });
        
        pos = delimIdx + 1;
    }
    
    // Handle trailing content after last |
    if (pos < line.length) {
        parts.push({ content: line.slice(pos).trim() });
    }
    
    // Render with padding
    let result = '|';
    let cursor = 0;
    
    for (let i = 0; i < parts.length - 1 && i < widths.length; i++) {
        const cell = parts[i];
        
        // Calculate how much we can pad this cell
        const idealEnd = 2 + widths.slice(0, i).reduce((a, b) => a + b + 3, 0);
        const availablePadding = Math.max(0, idealEnd - cursor - cell.content.length);
        
        // Pad the cell if needed
        let paddedContent = cell.content;
        if (availablePadding > 0 && i < widths.length) {
            paddedContent = cell.content.padEnd(cursor + widths[i] + 3 - availablePadding, ' ');
        } else {
            paddedContent = cell.content.padEnd(cursor + widths[i], ' ');
        }
        
        result += paddedContent;
        cursor += paddedContent.length + 3; // +3 for " | "
    }
    
    // Handle last column (no trailing space before delimiter)
    if (parts.length - 1 < widths.length) {
        const cell = parts[parts.length - 1];
        const idealEnd = 2 + widths.slice(0, widths.length - 1).reduce((a, b) => a + b + 3, 0);
        const availablePadding = Math.max(0, idealEnd - cursor - cell.content.length);
        
        let paddedContent = cell.content;
        if (availablePadding > 0) {
            paddedContent = cell.content.padEnd(cursor + widths[widths.length - 1], ' ');
        } else {
            paddedContent = cell.content;
        }
        
        result += paddedContent;
    }
    
    // Add trailing | if needed
    if (result.endsWith('|')) {
        result += '|';
    }
    
    return result;
}

/**
 * Main function to fix tables in a markdown file.
 */
function fixTables(content, maxCol = MAX_COL) {
    const lines = content.split('\n');
    let resultLines = [];
    let tableBlock = false;
    let headerFound = false;
    let separatorFound = false;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Detect start of a new table block (line starting with |)
        if (line.startsWith('|')) {
            // If we were in a table and hit a non-table line, process the previous block
            if (tableBlock && !headerFound && !separatorFound) {
                // Incomplete table, skip it
                resultLines.push(line);
                continue;
            } else if (tableBlock && headerFound && separatorFound) {
                // Complete table, process it
                const processed = processTable(lines.slice(i - Math.max(0, i - 10), i + 1), maxCol);
                resultLines.push(...processed);
                tableBlock = false;
                headerFound = false;
                separatorFound = false;
            } else if (tableBlock && !headerFound) {
                // Header row of a new table
                const widths = measureColumns(lines.slice(i - Math.max(0, i - 10), i + 1), maxCol);
                
                // Process this block with the measured widths
                const processed = processTable(lines.slice(i - Math.max(0, i - 10), i + 1), maxCol);
                resultLines.push(...processed);
                tableBlock = false;
                headerFound = true;
                separatorFound = false;
            } else if (tableBlock && headerFound) {
                // Check if this is a separator row
                if (isSeparatorRow(line)) {
                    separatorFound = true;
                    const processed = processTable(lines.slice(i - Math.max(0, i - 10), i + 1), maxCol);
                    resultLines.push(...processed);
                    tableBlock = false;
                    headerFound = false;
                    separatorFound = false;
                } else {
                    // Regular row in the table
                    const widths = measureColumns(lines.slice(i - Math.max(0, i - 10), i + 1), maxCol);
                    
                    if (headerFound && separatorFound) {
                        // Complete table block, process it
                        const processed = processTable(lines.slice(i - Math.max(0, i - 10), i + 1), maxCol);
                        resultLines.push(...processed);
                        tableBlock = false;
                        headerFound = false;
                        separatorFound = false;
                    } else {
                        // Incomplete table block, skip it
                        resultLines.push(line);
                    }
                }
            } else if (!tableBlock) {
                // Not in a table yet, check if this line starts one
                if (line.startsWith('|')) {
                    tableBlock = true;
                    headerFound = false;
                    separatorFound = false;
                }
                resultLines.push(line);
            }
        } else {
            // Non-table line
            if (tableBlock) {
                // End of table block, process it
                const processed = processTable(lines.slice(i - Math.max(0, i - 10), i + 1), maxCol);
                resultLines.push(...processed);
                tableBlock = false;
                headerFound = false;
                separatorFound = false;
            }
            resultLines.push(line);
        }
    }
    
    // Handle any remaining table block at end of file
    if (tableBlock) {
        const processed = processTable(lines.slice(Math.max(0, lines.length - 15), lines.length), maxCol);
        resultLines.push(...processed);
    }
    
    return resultLines.join('\n');
}

/**
 * Process a complete table block.
 */
function processTable(block, maxCol = MAX_COL) {
    const lines = block;
    const widths = measureColumns(lines, maxCol);
    
    if (widths.length === 0) return lines;
    
    // Separate header, separator, and data rows
    let headerLine = null;
    let separatorLine = null;
    const dataLines = [];
    
    for (const line of lines) {
        if (!line.startsWith('|')) continue;
        
        if (!headerLine && !separatorFound) {
            // First | line is likely the header
            headerLine = line;
        } else if (!separatorLine && separatorFound === false) {
            // Check if this could be a separator
            if (isSeparatorRow(line)) {
                separatorLine = line;
                separatorFound = true;
            } else if (headerLine !== null) {
                // This is a data row after header but before separator
                dataLines.push(line);
            }
        } else if (separatorLine === null && !separatorFound) {
            // Before finding separator, treat as potential header or skip
            if (!headerLine) {
                headerLine = line;
            }
        } else {
            // After separator, all | lines are data rows
            dataLines.push(line);
        }
    }
    
    // If no valid table found (no header and separator), return as-is
    if (!headerLine || !separatorLine) return lines;
    
    // Reconstruct the table with proper alignment
    const result = [];
    
    // Add header row
    result.push(headerLine);
    
    // Add separator row with measured widths
    let sep = '|';
    for (let i = 0; i < widths.length; i++) {
        sep += '-'.repeat(widths[i]);
        if (i < widths.length - 1) sep += ' | ';
    }
    sep += '|';
    result.push(sep);
    
    // Add data rows with proper padding
    for (const line of dataLines) {
        const parts = parseLine(line);
        let rendered = '|';
        let cursor = 0;
        
        for (let i = 0; i < Math.min(parts.length - 1, widths.length); i++) {
            const cellContent = parts[i].content.trim();
            
            // Calculate ideal end position for this column
            const idealEnd = 2 + widths.slice(0, i).reduce((a, b) => a + b + 3, 0);
            const availablePadding = Math.max(0, idealEnd - cursor - cellContent.length);
            
            let paddedContent;
            if (availablePadding > 0 && i < widths.length) {
                // Pad to fit within column width
                const targetLen = cursor + widths[i] + 3 - availablePadding;
                paddedContent = cellContent.padEnd(targetLen, ' ');
            } else {
                // No padding possible, just use content length
                paddedContent = cellContent;
            }
            
            rendered += paddedContent;
            cursor += paddedContent.length + 3;
        }
        
        // Handle last column (no trailing space before delimiter)
        if (parts.length - 1 < widths.length) {
            const cellContent = parts[parts.length - 1].content.trim();
            
            const idealEnd = 2 + widths.slice(0, widths.length - 1).reduce((a, b) => a + b + 3, 0);
            const availablePadding = Math.max(0, idealEnd - cursor - cellContent.length);
            
            let paddedContent;
            if (availablePadding > 0) {
                const targetLen = cursor + widths[widths.length - 1];
                paddedContent = cellContent.padEnd(targetLen, ' ');
            } else {
                paddedContent = cellContent;
            }
            
            rendered += paddedContent;
        }
        
        // Add trailing | if needed
        if (!rendered.endsWith('|')) {
            rendered += '|';
        }
        
        result.push(rendered);
    }
    
    return result;
}

/**
 * Parse a line into cells and their contents.
 */
function parseLine(line) {
    const parts = [];
    let pos = 0;
    
    if (line.startsWith('|')) {
        pos = 1;
        parts.push({ content: '' });
    }
    
    while (pos < line.length) {
        const delimIdx = line.indexOf('|', pos);
        if (delimIdx === -1) break;
        
        const cellContent = line.slice(pos, delimIdx).trim();
        parts.push({ content: cellContent });
        
        pos = delimIdx + 1;
    }
    
    // Handle trailing content after last |
    if (pos < line.length) {
        parts.push({ content: line.slice(pos).trim() });
    }
    
    return parts;
}

// Export for use as module
export { fixTables };

// Run as script when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    
    // Parse options: --max-col <value> or -m <value>
    let maxCol = MAX_COL;
    for (const arg of args) {
        if (arg.startsWith('--max-col=')) {
            maxCol = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('-m ')) {
            maxCol = parseInt(arg.split(' ')[1], 10);
        }
    }
    
    const options = {
        filePath: args.find(a => !a.startsWith('--') && !a.startsWith('-')),
        maxCol: maxCol,
    };
    
    if (options.filePath) {
        // File mode: read file, fix tables, write back in place
        try {
            const content = readFileSync(options.filePath, 'utf8');
            const fixed = fixTables(content, options.maxCol);
            writeFileSync(options.filePath, fixed, 'utf8');
        } catch (err) {
            console.error(err.message);
            process.exit(1);
        }
    } else {
        // Stdin mode: read stdin, output to stdout
        let content = '';
        process.stdin.setEncoding('utf8');
        
        for await (const chunk of process.stdin) {
            content += chunk;
        }
        
        try {
            const fixed = fixTables(content, options.maxCol);
            process.stdout.write(fixed);
        } catch (err) {
            console.error(err.message);
            process.exit(1);
        }
    }
}
