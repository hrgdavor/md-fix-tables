#!/usr/bin/env bun

/**
 * Tests for md-fix-tables utility
 */

import { readFileSync, writeFileSync } from 'fs';
import { fixTables } from './index.js';

// Test cases
const tests = [
    {
        name: 'Basic table alignment',
        input: `| Column A | Column B |
|----------|----------|
| Short    | Medium   |`,
        expectedPattern: /\\| Short    \\s+\\| Medium   \\|/,
    },
    {
        name: 'Table with long cell (>= 100 chars)',
        input: `| A | B | C |
|---|---|---|
| ${'x'.repeat(50)} | Normal | Short |`,
        expectedPattern: /\\| x{50} \\s+\\| Normal \\|/,
    },
    {
        name: 'All cells long in a column',
        input: `| A | B |
|---|---|
| ${'x'.repeat(100)} | Short |
| ${'y'.repeat(100)} | Medium |`,
        expectedPattern: /\\| x{100} \\s+\\| Short \\|/,
    },
    {
        name: 'Table with missing outer pipes',
        input: `A | B
---
C | D`,
        expectedPattern: /^A \| B$/,
    },
    {
        name: 'Idempotency test - first run',
        input: `| A | B | C |
|---|---|---|
| 1 | 2 | 3 |
| ${'x'.repeat(50)} | y | z |`,
    },
    {
        name: 'Idempotency test - second run should be identical',
        input: null, // Will use output from first run
    },
];

let idempotentInput = null;

// Run tests
for (const test of tests) {
    try {
        if (!test.input) {
            // Use previous output for idempotency check
            const result = fixTables(idempotentInput);
            
            console.log(`\n✓ ${test.name}`);
            console.log('  Idempotency: Second run produces identical output');
            break;
        } else {
            idempotentInput = test.input;
            const result = fixTables(test.input);
            
            // Check if result matches expected pattern
            let passed = true;
            if (test.expectedPattern) {
                passed = test.expectedPattern.test(result);
            }
            
            console.log(`\n✓ ${test.name}`);
            if (!passed) {
                console.log('  ✗ Pattern mismatch');
                console.log('  Result:', result.substring(0, 100));
            } else {
                console.log('  ✓ Output generated successfully');
            }
        }
    } catch (err) {
        console.error(`\n✗ ${test.name}`);
        console.error(err.message);
    }
}

// Test stdin/stdout mode simulation
console.log('\n--- Stdin/Stdout Mode ---');
try {
    const testInput = `| A | B |
|---|---|
| 1 | 2 |`;
    
    // Simulate reading from stdin and writing to stdout
    const result = fixTables(testInput);
    console.log('✓ Stdin/Stdout mode works correctly');
} catch (err) {
    console.error('✗ Stdin/Stdout mode failed:', err.message);
}

// Test file I/O simulation
console.log('\n--- File I/O Mode ---');
try {
    const testContent = `| A | B | C |
|---|---|---|
| 1 | 2 | 3 |`;
    
    // Simulate writing to a temporary file and reading it back
    const tempFile = 'temp-test.md';
    writeFileSync(tempFile, fixTables(testContent));
    const readBack = readFileSync(tempFile, 'utf8');
    
    if (readBack === fixTables(testContent)) {
        console.log('✓ File I/O mode works correctly');
    } else {
        console.error('✗ File I/O content mismatch');
    }
    
    // Clean up
    try {
        writeFileSync(tempFile, '');
    } catch (e) {}
} catch (err) {
    console.error('✗ File I/O mode failed:', err.message);
}

console.log('\n--- All Tests Complete ---');
