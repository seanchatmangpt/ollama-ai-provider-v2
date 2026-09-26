/// <reference types="node" />
/**
 * Benchmark for the bounded local UNKNOWN tier.
 *
 *   ./node_modules/.bin/vitest bench --run --config vitest.node.config.mjs \
 *     src/bounded-local-unknown.bench.ts --outputJson bench.json
 *
 * Recorded numbers and the derived regression bounds live in
 * docs/jira/v26.9.16/BENCH-RECEIPT.json; the bounds are enforced as tests in
 * bounded-local-unknown.hardening.test.ts ("performance regression bound").
 * The provider is a real loopback node:http server, not a function double.
 */
import { afterAll, beforeAll, bench, describe } from 'vitest';
import { runBoundedLocalUnknown, type AdmittedLocalUnknownTask, type BoundedLocalOllamaOptions } from './bounded-local-unknown';
import { startLocalOllamaServer, type LocalOllamaServer } from './bounded-local-unknown.local-server';

const task: AdmittedLocalUnknownTask = {
  taskId: 'bench-1',
  semanticSubject: 'urn:bench:subject:1',
  workClass: 'UNKNOWN_LOCAL',
  standing: 'admitted',
  prompt: 'resolve this bounded semantic edge',
};

const budget = { maxOutputTokens: 64, maxContextTokens: 512, maxContextChars: 2048, timeoutMs: 2000, temperature: 0, seed: 7 };

let server: LocalOllamaServer;
let local: BoundedLocalOllamaOptions;

beforeAll(async () => {
  server = await startLocalOllamaServer();
  local = { model: 'qwen3:4b', configRevision: 'bench', baseURL: server.baseURL, budget };
});

afterAll(async () => {
  await server.close();
});

describe('bounded-local-unknown', () => {
  bench('preflight refusal: non-admitted endpoint (no I/O)', async () => {
    await runBoundedLocalUnknown(task, { model: 'qwen3:4b', configRevision: 'bench', baseURL: 'https://frontier.example/api', budget });
  });

  bench('preflight refusal: invalid budget (no I/O)', async () => {
    await runBoundedLocalUnknown(task, { model: 'qwen3:4b', configRevision: 'bench', budget: { ...budget, timeoutMs: Number.NaN } });
  });

  bench('candidate round trip over loopback HTTP', async () => {
    await runBoundedLocalUnknown(task, local);
  });
});
