import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runCanonSpec } from './shared/canon-spec.js';

runCanonSpec('memory', async () => ({ host: createMemoryHost() }));
