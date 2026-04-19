import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runPrincipalsSpec } from './shared/principals-spec.js';

runPrincipalsSpec('memory', async () => ({ host: createMemoryHost() }));
