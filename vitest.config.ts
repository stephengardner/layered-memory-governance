import { defineConfig } from 'vitest/config';

// Cap parallelism only when gated suites are opted in. Default unit-test
// runs stay at full parallelism (~8s). Under gated flags, the suite
// loads a ~90MB onnx model, spawns Python bridges, spawns Node CLIs -
// all of which contend for CPU + fs and starve setTimeout-sensitive
// scheduler tests if they all run at once. Capping workers to 2 makes
// gated runs reliable at the cost of a couple of minutes total runtime.
const GATED = (
  process.env['LAG_REAL_EMBED'] === '1' ||
  process.env['LAG_REAL_PALACE'] === '1' ||
  process.env['LAG_SPAWN_TEST'] === '1' ||
  process.env['LAG_BENCH_SCALE'] === '1' ||
  process.env['LAG_REAL_CLI'] === '1'
);

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/stub.ts',
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/types.ts',
        'src/interface.ts',
      ],
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
    ...(GATED ? {
      poolOptions: {
        threads: { minThreads: 1, maxThreads: 2 },
        forks: { minForks: 1, maxForks: 2 },
      },
    } : {}),
  },
});
