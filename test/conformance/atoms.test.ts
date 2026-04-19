import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runAtomsSpec } from './shared/atoms-spec.js';

runAtomsSpec('memory', async () => ({ host: createMemoryHost() }));
