#!/usr/bin/env node

/**
 * check-pipes — Verify table delimiter alignment in a markdown file.
 * 
 * Prints the character index of each `|` delimiter for lines containing tables,
 * allowing you to confirm that columns are properly aligned.
 */

import { readFileSync } from 'fs';

const DEFAULT_ANCHOR = '| Part';
const DEFAULT_LINES = 13;

/**
 * Find all lines starting with | in a file and print their delimiter positions.
 */
function checkPipes(filePath, anchor = DEFAULT_ANCHOR, linesToPrint = DEFAULT_LINES) {
    try {
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        // Find the line containing the anchor string
        let anchorIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(anchor)) {
                anchorIdx = i;
                break;
            }
        }
        
        // If anchor not found, start from beginning
        if (anchorIdx === -1) {
            console.error(`Anchor string "${anchor}" not found in file.`);
            process.exit(1);
        }
        
        // Print delimiter positions for lines around the anchor
        const start = Math.max(0, anchorIdx - Math.floor(linesToPrint / 2));
        const end = Math.min(lines.length, anchorIdx + Math.ceil(linesToPrint / 2) + 1);
        
        console.log(`File: ${filePath}`);
        console.log(`Anchor: "${anchor}" at line ${anchorIdx + 1}`);
        console.log(`Printing lines ${start + 1} to ${end}:`);
        console.log('');
        
        for (let i = start; i < end; i++) {
            const line = lines[i];
            
            // Skip non-table lines
            if (!line.startsWith('|')) continue;
            
            // Extract delimiter positions
            const delimiters = [];
            let pos = 0;
            
            while ((pos = line.indexOf('|', pos)) !== -1) {
                delimiters.push(pos);
                pos++;
            }
            
            if (delimiters.length > 0) {
                console.log(`Line ${i + 1}: "${line.substring(0, Math.min(80, line.length))}..."`);
                console.log(`         Delimiter positions: [${delimiters.join(', ')}]`);
                
                // Check if delimiters are aligned (same position across rows)
                if (delimiters.length >= 2) {
                    const firstDelim = delimiters[0];
                    const secondDelim = delimiters[1];
                    
                    if (firstDelim === secondDelim) {
                        console.log(`         Status: ✓ Aligned`);
                    } else {
                        console.log(`         Status: ✗ Misaligned (diff: ${secondDelim - firstDelim})`);
                    }
                }
                
                console.log('');
            }
        }
        
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

// Run as script when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    
    if (args.length >= 1) {
        checkPipes(args[0], args[1] || DEFAULT_ANCHOR, args[2] ? parseInt(args[2]) : DEFAULT_LINES);
    } else {
        console.log('Usage: node check-pipes.mjs <file.md> [anchor] [lines]');
        console.log(`Example: node check-pipes.mjs codebuddy.md "| Part" 13`);
        process.exit(0);
    }
}
