#!/usr/bin/env node

/**
 * Regenerate the injected blocks in README.md.
 *
 * This wrapper imports directly from @hrg/inject-examples package, so
 * `npm run inject:examples` behaves the same from any working directory.
 *
 *     npm run inject:examples     rewrite README.md in place
 *     npm run check:examples      exit 1 if README.md is stale
 */

import { main } from '@hrg/inject-examples/cli.mjs';

process.exitCode = main(process.argv.slice(2));
