import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runNotifierSpec } from './shared/notifier-spec.js';

runNotifierSpec('memory', async () => ({ host: createMemoryHost() }));
