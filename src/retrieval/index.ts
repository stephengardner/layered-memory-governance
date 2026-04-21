/**
 * Retrieval stack: trigram + ONNX MiniLM + caching decorator.
 * Compose the embedders you need; the interface contract lives in
 * substrate/interface.ts (Embedder).
 */
export * from './trigram-embedder.js';
export * from './caching-embedder.js';
export * from './onnx-minilm-embedder.js';
export * from './content-hash.js';
export * from './similarity.js';
export * from './embedding.js';
export * from './atom-filter.js';
