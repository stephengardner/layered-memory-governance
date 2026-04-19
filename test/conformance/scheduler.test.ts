import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runSchedulerSpec } from './shared/scheduler-spec.js';

runSchedulerSpec('memory', async () => ({ host: createMemoryHost() }));
