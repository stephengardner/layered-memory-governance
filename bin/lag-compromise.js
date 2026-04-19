#!/usr/bin/env node
// Shebang wrapper for the compiled CLI. Depends on `npm run build` producing
// dist/cli/compromise.js (configured in tsconfig).
import '../dist/cli/compromise.js';
