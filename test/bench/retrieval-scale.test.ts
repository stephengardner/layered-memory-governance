/**
 * Q-ε scale-out retrieval benchmark.
 *
 * Generates 10K atoms across 20 topic clusters and measures how well the
 * current trigram embedder retrieves the correct cluster under 5 query
 * variants:
 *
 *   exact        literal wording lifted from an atom
 *   rearranged   same tokens, different order
 *   paraphrase   meaning preserved, vocabulary swapped
 *   synonym      primary token swapped for a cluster synonym
 *   adversarial  contains a strong distractor token from another cluster
 *
 * Per-variant metrics: top-1 recall, MRR@10, P@10.
 *
 * Gated by LAG_BENCH_SCALE=1. Runtime ~10-20s on a dev laptop.
 *
 * The results are emitted to stdout as a markdown table and committed to
 * `design/phase-15-findings.md` by the phase-15 writeup.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost, type MemoryHost } from '../../src/adapters/memory/index.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const RUN = process.env['LAG_BENCH_SCALE'] === '1';
const describeMaybe = RUN ? describe : describe.skip;

const ATOMS_PER_CLUSTER = 500;
const QUERIES_PER_VARIANT = 20;

// --- Topic clusters ---------------------------------------------------------
// 20 clusters, each with primary token(s), synonyms, and content pools.

interface Cluster {
  readonly id: string;
  readonly primary: string;
  readonly synonym: string; // a one-word synonym for the primary concept
  readonly purposes: ReadonlyArray<string>;
  readonly features: ReadonlyArray<string>;
  /** A paraphrase of "we use X for Y" that avoids the primary stem. */
  readonly paraphraseTemplate: (purpose: string) => string;
  /**
   * A HARD paraphrase: neither the primary token nor any purpose-word
   * from `purposes` appears. Real-world semantic-only overlap stress
   * case. Example (cluster=postgres): "The relational engine holds
   * our canonical records with ACID safety."
   */
  readonly hardParaphrase: string;
  /** A token from a DIFFERENT cluster used to build adversarial queries. */
  readonly adversarialDistractor: string;
}

const clusters: ReadonlyArray<Cluster> = [
  {
    id: 'postgres', primary: 'postgres', synonym: 'postgresql',
    purposes: ['transactional writes', 'OLTP workloads', 'user data storage', 'relational records', 'the primary data store'],
    features: ['ACID guarantees', 'logical replication', 'JSONB columns', 'MVCC concurrency'],
    paraphraseTemplate: p => `Relational SQL engine powering ${p}.`,
    hardParaphrase: 'The row-oriented engine keeping our canonical ledger safe under concurrent edits.',
    adversarialDistractor: 'redis',
  },
  {
    id: 'redis', primary: 'redis', synonym: 'valkey',
    purposes: ['caching', 'session storage', 'rate limiting', 'pub/sub messaging', 'ephemeral counters'],
    features: ['sub-millisecond latency', 'in-memory lookups', 'lua scripting'],
    paraphraseTemplate: p => `Fast in-memory key-value store used for ${p}.`,
    hardParaphrase: 'RAM-resident lookups with microsecond-scale response and TTL eviction.',
    adversarialDistractor: 'postgres',
  },
  {
    id: 'kafka', primary: 'kafka', synonym: 'redpanda',
    purposes: ['event streaming', 'log aggregation', 'async event bus', 'change-data-capture pipelines', 'decoupled services'],
    features: ['partitioned topics', 'consumer groups', 'durable log retention'],
    paraphraseTemplate: p => `Distributed commit-log broker for ${p}.`,
    hardParaphrase: 'Append-only commit ledger with durable partitions and many readers.',
    adversarialDistractor: 'kinesis',
  },
  {
    id: 'elasticsearch', primary: 'elasticsearch', synonym: 'opensearch',
    purposes: ['full-text search', 'log analytics', 'product catalog queries', 'anomaly detection', 'observability search'],
    features: ['inverted index', 'lucene scoring', 'faceted aggregations'],
    paraphraseTemplate: p => `Lucene-backed distributed index engine for ${p}.`,
    hardParaphrase: 'Inverted-index retrieval over sharded text documents with TF/IDF scoring.',
    adversarialDistractor: 'clickhouse',
  },
  {
    id: 'python', primary: 'python', synonym: 'cpython',
    purposes: ['data engineering', 'ML pipelines', 'scripting and glue', 'notebook analytics', 'scientific compute'],
    features: ['readable syntax', 'rich ecosystem', 'duck typing'],
    paraphraseTemplate: p => `High-level dynamic language used for ${p}.`,
    hardParaphrase: 'Interpreter-based glue tongue favored by analysts and ML practitioners.',
    adversarialDistractor: 'ruby',
  },
  {
    id: 'typescript', primary: 'typescript', synonym: 'tsc',
    purposes: ['frontend applications', 'backend services', 'shared libraries', 'build tooling', 'strict API contracts'],
    features: ['structural types', 'compile-time checks', 'discriminated unions'],
    paraphraseTemplate: p => `Statically-typed superset of JavaScript for ${p}.`,
    hardParaphrase: 'Compile-checked overlay on ECMAScript adding nominal-ish shape safety.',
    adversarialDistractor: 'flow',
  },
  {
    id: 'go', primary: 'golang', synonym: 'go-lang',
    purposes: ['high-throughput services', 'CLI tools', 'infrastructure agents', 'networking stacks', 'container orchestration'],
    features: ['goroutines', 'channels', 'fast compilation'],
    paraphraseTemplate: p => `Compiled concurrency-first language for ${p}.`,
    hardParaphrase: 'Statically-linked binary output with green-thread scheduling and channel-based coordination.',
    adversarialDistractor: 'rust',
  },
  {
    id: 'rust', primary: 'rust', synonym: 'rustlang',
    purposes: ['memory-safe systems code', 'performance-critical pipelines', 'WASM modules', 'kernel-adjacent tooling', 'crypto primitives'],
    features: ['borrow checker', 'zero-cost abstractions', 'pattern matching'],
    paraphraseTemplate: p => `Systems language with ownership semantics for ${p}.`,
    hardParaphrase: 'Lifetime-tracked low-level tongue with compile-time aliasing guarantees.',
    adversarialDistractor: 'c++',
  },
  {
    id: 'react', primary: 'react', synonym: 'preact',
    purposes: ['UI rendering', 'component composition', 'SPA dashboards', 'interactive forms', 'client-side routing'],
    features: ['virtual DOM diffing', 'hooks', 'server components'],
    paraphraseTemplate: p => `Declarative UI library handling ${p}.`,
    hardParaphrase: 'Component-model view layer with reconciled tree updates in the browser.',
    adversarialDistractor: 'vue',
  },
  {
    id: 'kubernetes', primary: 'kubernetes', synonym: 'k8s',
    purposes: ['container orchestration', 'scheduling workloads', 'service discovery', 'horizontal autoscaling', 'zero-downtime rollouts'],
    features: ['pod scheduling', 'controller-manager loops', 'CRD extensibility'],
    paraphraseTemplate: p => `Container cluster manager responsible for ${p}.`,
    hardParaphrase: 'Declarative workload placement system with reconciliation loops on a shared control plane.',
    adversarialDistractor: 'nomad',
  },
  {
    id: 'terraform', primary: 'terraform', synonym: 'opentofu',
    purposes: ['infrastructure provisioning', 'cloud resource management', 'multi-provider wiring', 'environment parity', 'IaC rollouts'],
    features: ['hcl syntax', 'state files', 'provider plugins'],
    paraphraseTemplate: p => `Declarative infrastructure-as-code engine for ${p}.`,
    hardParaphrase: 'Desired-state cloud resource authoring with plan/apply diffing.',
    adversarialDistractor: 'pulumi',
  },
  {
    id: 'datadog', primary: 'datadog', synonym: 'dd-agent',
    purposes: ['APM tracing', 'metric collection', 'log ingestion', 'production observability', 'alerting on SLIs'],
    features: ['distributed tracing', 'custom metrics', 'anomaly monitors'],
    paraphraseTemplate: p => `Commercial monitoring and tracing platform for ${p}.`,
    hardParaphrase: 'Hosted telemetry SaaS correlating traces, metrics, and logs for alerting.',
    adversarialDistractor: 'grafana',
  },
  {
    id: 'stripe', primary: 'stripe', synonym: 'stripe.com',
    purposes: ['payment processing', 'subscription billing', 'invoicing and receipts', 'dispute handling', 'connect payouts'],
    features: ['payment intents', 'webhook events', 'idempotency keys'],
    paraphraseTemplate: p => `Card-processing platform used for ${p}.`,
    hardParaphrase: 'Merchant-facing SaaS running the charge rail and handling chargebacks.',
    adversarialDistractor: 'paypal',
  },
  {
    id: 'nestjs', primary: 'nestjs', synonym: 'nest.js',
    purposes: ['HTTP APIs', 'dependency injection', 'modular services', 'GraphQL gateways', 'request pipelines'],
    features: ['decorators', 'guards and interceptors', 'typed DTOs'],
    paraphraseTemplate: p => `Angular-inspired backend framework for ${p}.`,
    hardParaphrase: 'Opinionated Node.js server scaffolding with IoC containers and decorator-driven routes.',
    adversarialDistractor: 'express',
  },
  {
    id: 'clickhouse', primary: 'clickhouse', synonym: 'click-house',
    purposes: ['analytical queries', 'real-time OLAP', 'columnar aggregation', 'event warehousing', 'dashboard backends'],
    features: ['columnar storage', 'vectorized execution', 'materialized views'],
    paraphraseTemplate: p => `Columnar analytics database used for ${p}.`,
    hardParaphrase: 'Column-compressed OLAP engine crunching billion-row summaries in seconds.',
    adversarialDistractor: 'snowflake',
  },
  {
    id: 'snowflake', primary: 'snowflake', synonym: 'snowflake-db',
    purposes: ['data warehousing', 'cross-team analytics', 'SQL reporting', 'BI dashboards', 'reverse ETL'],
    features: ['separation of compute and storage', 'zero-copy clones', 'auto-scaling warehouses'],
    paraphraseTemplate: p => `Cloud data warehouse used for ${p}.`,
    hardParaphrase: 'Elastic cloud lakehouse with detached compute clusters per team.',
    adversarialDistractor: 'clickhouse',
  },
  {
    id: 'sentry', primary: 'sentry', synonym: 'sentry.io',
    purposes: ['error tracking', 'release health monitoring', 'crash reporting', 'frontend diagnostics', 'issue grouping'],
    features: ['sourcemap upload', 'breadcrumbs', 'release regression detection'],
    paraphraseTemplate: p => `Crash and error telemetry SaaS handling ${p}.`,
    hardParaphrase: 'Exception-capture tool grouping stack traces and watching release regressions.',
    adversarialDistractor: 'datadog',
  },
  {
    id: 'github-actions', primary: 'github-actions', synonym: 'gh-actions',
    purposes: ['CI pipelines', 'deploy workflows', 'matrix builds', 'release automation', 'repo webhooks'],
    features: ['yaml workflows', 'runner matrix', 'reusable workflows'],
    paraphraseTemplate: p => `Git-hosted CI/CD runner engine used for ${p}.`,
    hardParaphrase: 'Repo-tied continuous delivery fabric running hosted executors on commit.',
    adversarialDistractor: 'circleci',
  },
  {
    id: 'docker', primary: 'docker', synonym: 'docker-ce',
    purposes: ['containerization', 'local dev environments', 'build artifact packaging', 'reproducible builds', 'image distribution'],
    features: ['layered filesystems', 'buildkit', 'compose orchestration'],
    paraphraseTemplate: p => `Linux container runtime used for ${p}.`,
    hardParaphrase: 'Userland isolation runtime bundling apps with their OS layers for shippable artifacts.',
    adversarialDistractor: 'podman',
  },
  {
    id: 'mongodb', primary: 'mongodb', synonym: 'mongo',
    purposes: ['document storage', 'schemaless payload persistence', 'aggregation pipelines', 'change-stream integrations', 'BSON records'],
    features: ['flexible schemas', 'replica sets', 'geo indexes'],
    paraphraseTemplate: p => `Document-oriented NoSQL database used for ${p}.`,
    hardParaphrase: 'JSON-shaped record store with shardable replica topologies and lenient shapes.',
    adversarialDistractor: 'couchbase',
  },
];

if (clusters.length !== 20) {
  throw new Error(`Expected 20 clusters; got ${clusters.length}`);
}

// --- PRNG -------------------------------------------------------------------
// mulberry32; small, fast, good enough for test reproducibility.
function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: ReadonlyArray<T>): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// --- Corpus generation ------------------------------------------------------

function buildAtom(
  cluster: Cluster,
  idx: number,
  rng: () => number,
): Atom {
  const purpose = pick(rng, cluster.purposes);
  const feature = pick(rng, cluster.features);
  const leadIn = pick(rng, [
    `We use ${cluster.primary} for ${purpose}.`,
    `${cluster.primary} is our choice for ${purpose}.`,
    `The team runs ${cluster.primary} to handle ${purpose}.`,
    `Our production ${cluster.primary} deployment handles ${purpose}.`,
    `${cluster.primary} powers ${purpose} at the platform level.`,
  ]);
  const content = `${leadIn} ${feature[0]!.toUpperCase()}${feature.slice(1)} is the defining property.`;
  return sampleAtom({
    id: (`${cluster.id}_${String(idx).padStart(4, '0')}`) as AtomId,
    content,
    type: 'observation',
    layer: 'L1',
    confidence: 0.5 + rng() * 0.4,
    principal_id: ('agent_' + Math.floor(rng() * 5)) as PrincipalId,
    created_at: new Date(1_700_000_000_000 + idx * 1000).toISOString() as Time,
    last_reinforced_at: new Date(1_700_000_000_000 + idx * 1000).toISOString() as Time,
    metadata: { cluster_id: cluster.id },
  });
}

async function seedCorpus(
  host: MemoryHost,
  rng: () => number,
  atomsPerCluster: number = ATOMS_PER_CLUSTER,
): Promise<void> {
  let idx = 0;
  for (const c of clusters) {
    for (let i = 0; i < atomsPerCluster; i++) {
      await host.atoms.put(buildAtom(c, idx++, rng));
    }
  }
}

// --- Queries ----------------------------------------------------------------

type Variant =
  | 'exact'
  | 'rearranged'
  | 'paraphrase'
  | 'hard_paraphrase'
  | 'synonym'
  | 'adversarial';

interface BenchQuery {
  readonly text: string;
  readonly variant: Variant;
  readonly expectedClusterId: string;
}

function buildQueries(rng: () => number): BenchQuery[] {
  const out: BenchQuery[] = [];
  for (let n = 0; n < QUERIES_PER_VARIANT; n++) {
    const c = pick(rng, clusters);
    const purpose = pick(rng, c.purposes);

    // exact: literal content from the template pool
    out.push({
      text: `We use ${c.primary} for ${purpose}.`,
      variant: 'exact',
      expectedClusterId: c.id,
    });

    // rearranged: same tokens, flipped order
    out.push({
      text: `${purpose} runs on ${c.primary}`,
      variant: 'rearranged',
      expectedClusterId: c.id,
    });

    // paraphrase: avoid the primary token; purpose word remains
    out.push({
      text: c.paraphraseTemplate(purpose),
      variant: 'paraphrase',
      expectedClusterId: c.id,
    });

    // hard_paraphrase: avoid BOTH the primary token and every purpose word.
    // Deliberate semantic-only overlap, zero planned lexical overlap.
    out.push({
      text: c.hardParaphrase,
      variant: 'hard_paraphrase',
      expectedClusterId: c.id,
    });

    // synonym: swap primary for its synonym
    out.push({
      text: `We use ${c.synonym} for ${purpose}.`,
      variant: 'synonym',
      expectedClusterId: c.id,
    });

    // adversarial: primary-token query contaminated with a distractor
    out.push({
      text: `We use ${c.primary} but not ${c.adversarialDistractor} for ${purpose}.`,
      variant: 'adversarial',
      expectedClusterId: c.id,
    });
  }
  return out;
}

// --- Metrics ----------------------------------------------------------------

interface VariantStats {
  count: number;
  top1Hits: number;
  sumRR: number;
  sumP10: number;
}

function emptyStats(): VariantStats {
  return { count: 0, top1Hits: 0, sumRR: 0, sumP10: 0 };
}

function formatRow(variant: Variant, s: VariantStats): string {
  const pad = (n: number) => n.toFixed(3);
  return [
    variant.padEnd(15),
    String(s.count).padStart(5),
    pad(s.top1Hits / s.count).padStart(8),
    pad(s.sumRR / s.count).padStart(8),
    pad(s.sumP10 / s.count).padStart(7),
  ].join(' ');
}

async function run(
  host: MemoryHost,
  queries: BenchQuery[],
): Promise<Map<Variant, VariantStats>> {
  const stats = new Map<Variant, VariantStats>();
  for (const q of queries) {
    const hits = await host.atoms.search(q.text, 10);
    const topId = hits[0]?.atom.metadata['cluster_id'];
    const firstCorrect = hits.findIndex(h => h.atom.metadata['cluster_id'] === q.expectedClusterId);
    const rr = firstCorrect === -1 ? 0 : 1 / (firstCorrect + 1);
    const p10 = hits.filter(h => h.atom.metadata['cluster_id'] === q.expectedClusterId).length / 10;
    const s = stats.get(q.variant) ?? emptyStats();
    s.count += 1;
    if (topId === q.expectedClusterId) s.top1Hits += 1;
    s.sumRR += rr;
    s.sumP10 += p10;
    stats.set(q.variant, s);
  }
  return stats;
}

describeMaybe('Q-ε scale-out retrieval benchmark (10K atoms)', () => {
  it('measures top-1 recall, MRR@10, P@10 across 6 query variants', async () => {
    const rng = makeRng(42);
    const host = createMemoryHost();

    const seedStart = Date.now();
    await seedCorpus(host, rng);
    const seedMs = Date.now() - seedStart;

    const total = clusters.length * ATOMS_PER_CLUSTER;
    const seeded = (await host.atoms.query({ layer: ['L1'] }, total + 1)).atoms;
    expect(seeded.length).toBe(total);

    const queries = buildQueries(rng);
    const runStart = Date.now();
    const stats = await run(host, queries);
    const runMs = Date.now() - runStart;

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`Corpus: ${total} atoms across ${clusters.length} clusters, seeded in ${seedMs}ms.`);
    // eslint-disable-next-line no-console
    console.log(`Queries: ${queries.length} total (${QUERIES_PER_VARIANT} per variant), ${runMs}ms wall.`);
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log('variant          count    top-1      MRR    P@10');
    // eslint-disable-next-line no-console
    console.log('--------------- ----- -------- -------- -------');
    for (const variant of ['exact', 'rearranged', 'paraphrase', 'hard_paraphrase', 'synonym', 'adversarial'] as Variant[]) {
      const s = stats.get(variant);
      if (s) {
        // eslint-disable-next-line no-console
        console.log(formatRow(variant, s));
      }
    }

    // Sanity assertions (loose; meant to catch flat-out broken retrieval).
    const exact = stats.get('exact')!;
    expect(exact.top1Hits / exact.count).toBeGreaterThan(0.8);
  }, 120_000);
});

// --- Onnx-backed bench -----------------------------------------------------
// Same corpus layout, reduced scale (100 per cluster = 2000 atoms) because
// each first-time embed is ~20ms on CPU. Gate by BOTH flags so the default
// + LAG_BENCH_SCALE=1 run doesn't accidentally pull a 90MB model.

const ONNX_RUN = RUN && process.env['LAG_REAL_EMBED'] === '1';
const describeMaybeOnnx = ONNX_RUN ? describe : describe.skip;
const ONNX_ATOMS_PER_CLUSTER = 100;

describeMaybeOnnx('Q-ε onnx-backed retrieval benchmark (2K atoms, all-MiniLM-L6-v2)', () => {
  it('measures top-1 recall, MRR@10, P@10 across 6 query variants under onnx', async () => {
    const { OnnxMiniLmEmbedder } = await import('../../src/adapters/_common/onnx-minilm-embedder.js');
    const embedder = new OnnxMiniLmEmbedder();

    // Warm the model up front so the seeding/search timing reflects steady-state.
    const warmStart = Date.now();
    await embedder.embed('warmup');
    const warmMs = Date.now() - warmStart;

    const rng = makeRng(42);
    const host = createMemoryHost({ embedder });

    const seedStart = Date.now();
    await seedCorpus(host, rng, ONNX_ATOMS_PER_CLUSTER);
    const seedMs = Date.now() - seedStart;

    const total = clusters.length * ONNX_ATOMS_PER_CLUSTER;
    const seeded = (await host.atoms.query({ layer: ['L1'] }, total + 1)).atoms;
    expect(seeded.length).toBe(total);

    const queries = buildQueries(rng);
    const runStart = Date.now();
    const stats = await run(host, queries);
    const runMs = Date.now() - runStart;

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`Onnx bench: model warm=${warmMs}ms, corpus=${total} atoms seeded=${seedMs}ms, queries=${queries.length} run=${runMs}ms.`);
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log('variant          count    top-1      MRR    P@10');
    // eslint-disable-next-line no-console
    console.log('--------------- ----- -------- -------- -------');
    for (const variant of ['exact', 'rearranged', 'paraphrase', 'hard_paraphrase', 'synonym', 'adversarial'] as Variant[]) {
      const s = stats.get(variant);
      if (s) {
        // eslint-disable-next-line no-console
        console.log(formatRow(variant, s));
      }
    }

    // The whole point of onnx vs trigram: hard_paraphrase should lift
    // substantially. Keep the bar loose (0.5) so the assertion survives
    // minor variance in model outputs across platforms.
    const hp = stats.get('hard_paraphrase')!;
    expect(hp.top1Hits / hp.count).toBeGreaterThan(0.5);
  }, 300_000);
});
