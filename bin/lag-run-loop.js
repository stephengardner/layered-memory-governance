#!/usr/bin/env node
// Shebang wrapper for the compiled CLI. Depends on `npm run build` producing
// dist/cli/run-loop.js (configured in tsconfig).
import '../dist/cli/run-loop.js';
