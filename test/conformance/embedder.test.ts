import { TrigramEmbedder } from '../../src/adapters/_common/trigram-embedder.js';
import { runEmbedderSpec } from './shared/embedder-spec.js';

runEmbedderSpec('trigram', () => new TrigramEmbedder());
