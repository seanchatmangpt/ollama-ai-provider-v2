/// <reference types="node" />
/**
 * Hardening court for the bounded local UNKNOWN tier (v26.9.26).
 *
 * Chicago style: every provider interaction goes through the platform `fetch`
 * to a real loopback `node:http` server (see bounded-local-unknown.local-server.ts);
 * assertions are on returned results and on the requests the server actually
 * received. No function doubles, no module patching.
 *
 * Each `it` names the falsifier it guards. The ones marked [defect] failed on
 * PR head a77330e840a4afa33d5e5265e51db5fcbd81c43b before the fix landed.
 */
import { networkInterfaces } from 'node:os';
import {
  MAX_CHARS_PER_OUTPUT_TOKEN,
  MAX_LOCAL_TIMEOUT_MS,
  RESPONSE_ENVELOPE_BYTES,
  SHLLM_CAPABILITY_ID,
  runBoundedLocalUnknown,
  type AdmittedLocalUnknownTask,
  type BoundedLocalOllamaOptions,
  type LocalInferenceBudget,
} from './bounded-local-unknown';
import {
  defaultGenerate,
  ollamaJson,
  startLocalOllamaServer,
  type LocalOllamaServer,
} from './bounded-local-unknown.local-server';

const isEdgeRuntime = typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== 'undefined';

const task: AdmittedLocalUnknownTask = {
  taskId: 'task-h1',
  semanticSubject: 'urn:test:subject:h1',
  workClass: 'UNKNOWN_LOCAL',
  standing: 'admitted',
  prompt: 'resolve this bounded semantic edge',
};

const budget: LocalInferenceBudget = {
  maxOutputTokens: 64,
  maxContextTokens: 512,
  maxContextChars: 2048,
  timeoutMs: 2000,
  temperature: 0,
  seed: 7,
};

function nonLoopbackIPv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return undefined;
}

describe.skipIf(isEdgeRuntime)('runBoundedLocalUnknown against a real loopback server', () => {
  let server: LocalOllamaServer;
  let options: BoundedLocalOllamaOptions;

  beforeEach(async () => {
    server = await startLocalOllamaServer();
    options = {
      model: 'qwen3:4b',
      configRevision: 'local-profile-v26.9.16',
      baseURL: server.baseURL,
      budget: { ...budget },
    };
  });

  afterEach(async () => {
    await server.close();
  });

  it('sends exactly the bounded request and returns candidate-only material', async () => {
    const result = await runBoundedLocalUnknown(task, options);

    expect(result).toMatchObject({
      status: 'CANDIDATE_SEMANTIC_ARTIFACT',
      capabilityId: SHLLM_CAPABILITY_ID,
      standing: 'candidate',
      authority: 'none',
      taskId: 'task-h1',
      semanticSubject: 'urn:test:subject:h1',
      artifact: `candidate:${task.prompt}`,
    });
    expect(result.evidence).toEqual({
      provider: 'ollama',
      model: 'qwen3:4b',
      configRevision: 'local-profile-v26.9.16',
      endpointOrigin: server.origin,
      maxOutputTokens: 64,
      maxContextTokens: 512,
      timeoutMs: 2000,
      promptTokens: 11,
      outputTokens: 7,
      totalDurationNs: 123,
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].method).toBe('POST');
    expect(server.requests[0].path).toBe('/api/generate');
    expect(JSON.parse(server.requests[0].body)).toEqual({
      model: 'qwen3:4b',
      prompt: task.prompt,
      stream: false,
      options: { num_predict: 64, num_ctx: 512, temperature: 0, seed: 7 },
    });
  });

  describe('non-finite / malformed budgets never reach the provider', () => {
    const bad: Array<[string, Partial<LocalInferenceBudget>]> = [
      ['NaN output tokens [defect]', { maxOutputTokens: Number.NaN }],
      ['Infinity output tokens [defect]', { maxOutputTokens: Number.POSITIVE_INFINITY }],
      ['NaN context chars [defect]', { maxContextChars: Number.NaN }],
      ['fractional context tokens [defect]', { maxContextTokens: 1.5 }],
      ['timeout beyond setTimeout range [defect]', { timeoutMs: MAX_LOCAL_TIMEOUT_MS + 1 }],
      ['Infinity timeout [defect]', { timeoutMs: Number.POSITIVE_INFINITY }],
      ['negative temperature [defect]', { temperature: -1 }],
      ['non-integer seed [defect]', { seed: 0.5 }],
      ['string output tokens [defect]', { maxOutputTokens: '64' as unknown as number }],
      ['zero timeout', { timeoutMs: 0 }],
      ['negative output tokens', { maxOutputTokens: -1 }],
    ];

    it.each(bad)('%s', async (_name, override) => {
      const result = await runBoundedLocalUnknown(task, { ...options, budget: { ...budget, ...override } });
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'invalid_finite_budget', authority: 'none' });
      expect(server.requests).toHaveLength(0);
    });

    it('accepts the largest honoured timeout', async () => {
      const result = await runBoundedLocalUnknown(task, {
        ...options,
        budget: { ...budget, timeoutMs: MAX_LOCAL_TIMEOUT_MS },
      });
      expect(result.status).toBe('CANDIDATE_SEMANTIC_ARTIFACT');
      expect(server.requests).toHaveLength(1);
    });
  });

  describe('endpoint admission', () => {
    const refusedEndpoints: Array<[string, (s: LocalOllamaServer) => Partial<BoundedLocalOllamaOptions>]> = [
      ['file: URL on localhost (WHATWG empties the host)', () => ({ baseURL: 'file://localhost/tmp/api' })],
      ['opaque data: URL with allow-listed "null" origin [defect]', () => ({
        baseURL: 'data:text/plain,api',
        allowedOrigins: ['null'],
      })],
      ['embedded credentials [defect]', s => ({ baseURL: s.baseURL.replace('http://', 'http://user:pw@') })],
      ['query string that would swallow /generate [defect]', s => ({ baseURL: `${s.baseURL}?route=x` })],
      ['fragment [defect]', s => ({ baseURL: `${s.baseURL}#frag` })],
      ['unparseable URL', () => ({ baseURL: 'not a url' })],
      ['non-loopback lookalike host', () => ({ baseURL: 'http://127.0.0.1.example/api' })],
      ['userinfo host confusion', () => ({ baseURL: 'http://127.0.0.1@frontier.example/api' })],
      ['allow-list of a different port does not admit', () => ({
        baseURL: 'http://edge-node.internal:11435/api',
        allowedOrigins: ['http://edge-node.internal:11434'],
      })],
    ];

    it.each(refusedEndpoints)('refuses %s', async (_name, override) => {
      const result = await runBoundedLocalUnknown(task, { ...options, ...override(server) });
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'endpoint_not_locally_admitted', authority: 'none' });
      expect(server.requests).toHaveLength(0);
    });

    it('never follows a redirect to a non-admitted origin [defect]', async () => {
      const frontierHost = nonLoopbackIPv4();
      if (frontierHost == null) {
        // Named, visible degradation: without a non-loopback interface there is
        // no non-admitted origin reachable from this machine.
        console.warn('SKIP(no non-loopback IPv4 interface): redirect escape not exercisable');
        return;
      }
      const frontier = await startLocalOllamaServer(defaultGenerate, '0.0.0.0');
      try {
        const frontierURL = frontier.origin.replace('0.0.0.0', frontierHost);
        server.setHandler((_req, res) => {
          res.writeHead(307, { location: `${frontierURL}/api/generate` });
          res.end();
        });

        const result = await runBoundedLocalUnknown(task, options);

        expect(result).toMatchObject({ status: 'REFUSED', reason: 'local_provider_redirect_refused', authority: 'none' });
        expect(server.requests).toHaveLength(1);
        expect(frontier.requests).toHaveLength(0);
      } finally {
        await frontier.close();
      }
    });
  });

  describe('malformed input is a typed refusal, never a throw', () => {
    const badTasks: Array<[string, unknown]> = [
      ['null task [defect]', null],
      ['non-string prompt [defect]', { ...task, prompt: 42 }],
      ['missing prompt [defect]', { ...task, prompt: undefined }],
      ['empty taskId [defect]', { ...task, taskId: '' }],
      ['blank semantic subject [defect]', { ...task, semanticSubject: '   ' }],
      ['candidate standing smuggled in', { ...task, standing: 'candidate' }],
    ];

    it.each(badTasks)('%s', async (_name, bad) => {
      const result = await runBoundedLocalUnknown(bad as AdmittedLocalUnknownTask, options);
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'task_not_admitted_unknown_local', authority: 'none' });
      expect(server.requests).toHaveLength(0);
    });

    it.each([
      ['empty model [defect]', { model: '' }],
      ['blank config revision [defect]', { configRevision: ' ' }],
    ])('refuses a profile without identity: %s', async (_name, override) => {
      const result = await runBoundedLocalUnknown(task, { ...options, ...override });
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'local_profile_identity_missing' });
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('malformed provider responses', () => {
    it.each([
      ['JSON null body [defect]', null, 'malformed_local_provider_response'],
      ['JSON array body [defect]', [1, 2], 'malformed_local_provider_response'],
      ['numeric response field', { response: 42, eval_count: 1 }, 'malformed_local_candidate'],
    ])('%s', async (_name, body, reason) => {
      server.setHandler((_req, res) => ollamaJson(res, 200, body));
      const result = await runBoundedLocalUnknown(task, options);
      expect(result).toMatchObject({ status: 'REFUSED', reason, standing: 'observed', authority: 'none' });
      expect(server.requests).toHaveLength(1);
    });

    it('refuses a non-JSON body', async () => {
      server.setHandler((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"response": "trunc');
      });
      const result = await runBoundedLocalUnknown(task, options);
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'malformed_local_provider_response' });
    });

    it('does not record nonsensical usage counters as evidence [defect]', async () => {
      server.setHandler((_req, res) =>
        ollamaJson(res, 200, { response: 'ok', eval_count: -5, prompt_eval_count: 1e400, total_duration: 3 }),
      );
      const result = await runBoundedLocalUnknown(task, options);
      expect(result.status).toBe('CANDIDATE_SEMANTIC_ARTIFACT');
      expect(result.evidence.outputTokens).toBeUndefined();
      expect(result.evidence.promptTokens).toBeUndefined();
      expect(result.evidence.totalDurationNs).toBe(3);
    });

    it('returns RESOURCE_EXHAUSTED when the provider reports exceeding the output budget', async () => {
      server.setHandler((_req, res) => ollamaJson(res, 200, { response: 'long', eval_count: 65 }));
      const result = await runBoundedLocalUnknown(task, options);
      expect(result).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'provider_exceeded_output_budget' });
      expect(result.evidence.outputTokens).toBe(65);
    });

    it('returns NO_CANDIDATE for a whitespace-only candidate', async () => {
      server.setHandler((_req, res) => ollamaJson(res, 200, { response: ' \n\t', eval_count: 2 }));
      const result = await runBoundedLocalUnknown(task, options);
      expect(result).toMatchObject({ status: 'NO_CANDIDATE', standing: 'observed' });
    });
  });

  describe('time budget', () => {
    it('a body that stalls past the timeout is RESOURCE_EXHAUSTED, not malformed [defect]', async () => {
      server.setHandler((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"response":"');
        // never finishes the body
      });
      const started = Date.now();
      const result = await runBoundedLocalUnknown(task, { ...options, budget: { ...budget, timeoutMs: 50 } });
      expect(result).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'local_timeout_budget_exhausted' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(server.requests).toHaveLength(1);
    });

    it('headers that never arrive are RESOURCE_EXHAUSTED after exactly one attempt', async () => {
      server.setHandler(() => undefined);
      const result = await runBoundedLocalUnknown(task, { ...options, budget: { ...budget, timeoutMs: 50 } });
      expect(result).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'local_timeout_budget_exhausted' });
      expect(server.requests).toHaveLength(1);
    });
  });

  describe('single attempt, duplicate delivery and reordering', () => {
    it('a provider 500 is refused after exactly one attempt (no retry)', async () => {
      server.setHandler((_req, res) => ollamaJson(res, 500, { error: 'boom' }));
      const result = await runBoundedLocalUnknown(task, options);
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'local_provider_http_500' });
      expect(server.requests).toHaveLength(1);
    });

    it('a connection refused endpoint is a typed failure with no fallback', async () => {
      const dead = await startLocalOllamaServer();
      const deadBase = dead.baseURL;
      await dead.close();
      const result = await runBoundedLocalUnknown(task, { ...options, baseURL: deadBase });
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'local_provider_failure', authority: 'none' });
      expect(server.requests).toHaveLength(0);
    });

    it('duplicate delivery of the same task replays to an identical result, one request each', async () => {
      const first = await runBoundedLocalUnknown(task, options);
      const second = await runBoundedLocalUnknown(task, options);
      expect(second).toEqual(first);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0].body).toBe(server.requests[1].body);
    });

    it('out-of-order responses stay bound to their own task and subject', async () => {
      const release: Array<() => void> = [];
      server.setHandler(
        (req, res) =>
          new Promise<void>(resolve => {
            release.push(() => {
              defaultGenerate(req, res, 0);
              resolve();
            });
          }),
      );
      const tasks = [0, 1, 2, 3].map(i => ({
        ...task,
        taskId: `task-${i}`,
        semanticSubject: `urn:test:subject:${i}`,
        prompt: `prompt-${i}`,
      }));
      const pending = tasks.map(t => runBoundedLocalUnknown(t, options));
      while (release.length < tasks.length) {
        await new Promise(r => setTimeout(r, 5));
      }
      for (const go of [...release].reverse()) {
        go();
      }
      const results = await Promise.all(pending);
      results.forEach((result, i) => {
        expect(result).toMatchObject({
          status: 'CANDIDATE_SEMANTIC_ARTIFACT',
          taskId: `task-${i}`,
          semanticSubject: `urn:test:subject:${i}`,
          artifact: `candidate:prompt-${i}`,
        });
      });
      expect(server.requests).toHaveLength(4);
    });
  });

  describe('allow-list admission is exact-origin equality, never prefix (v26.9.26 round 2)', () => {
    const lookalikes: Array<[string, string, string[]]> = [
      ['look-alike host extending an allow-listed host', 'https://gpu.lan.evil.example/api', ['https://gpu.lan']],
      ['allow-listed origin as a prefix of a longer port', 'http://edge-node.internal:114340/api', ['http://edge-node.internal:11434']],
      ['allow-list entry carrying the endpoint path', 'http://edge-node.internal:11434/api', ['http://edge-node.internal:11434/api']],
      ['allow-list entry with a trailing slash', 'http://edge-node.internal:11434/api', ['http://edge-node.internal:11434/']],
      ['allow-list entry with different case', 'http://edge-node.internal:11434/api', ['HTTP://EDGE-NODE.INTERNAL:11434']],
      ['non-string allow-list entry', 'http://edge-node.internal:11434/api', [42 as unknown as string]],
    ];

    it.each(lookalikes)('refuses %s', async (_name, baseURL, allowedOrigins) => {
      const result = await runBoundedLocalUnknown(task, { ...options, baseURL, allowedOrigins });
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'endpoint_not_locally_admitted', authority: 'none' });
      expect(server.requests).toHaveLength(0);
    });

    it('admits a non-loopback endpoint only through its exact serialised origin', async () => {
      const host = nonLoopbackIPv4();
      if (host == null) {
        console.warn('SKIP(no non-loopback IPv4 interface): allow-listed non-loopback admission not exercisable');
        return;
      }
      const remote = await startLocalOllamaServer(defaultGenerate, '0.0.0.0');
      try {
        const exact = remote.origin.replace('0.0.0.0', host);
        const baseURL = `${exact}/api`;

        const refused = await runBoundedLocalUnknown(task, { ...options, baseURL });
        expect(refused).toMatchObject({ status: 'REFUSED', reason: 'endpoint_not_locally_admitted' });

        const prefixOnly = await runBoundedLocalUnknown(task, { ...options, baseURL, allowedOrigins: [`${exact}/`] });
        expect(prefixOnly).toMatchObject({ status: 'REFUSED', reason: 'endpoint_not_locally_admitted' });
        expect(remote.requests).toHaveLength(0);

        const admitted = await runBoundedLocalUnknown(task, { ...options, baseURL, allowedOrigins: [exact] });
        expect(admitted).toMatchObject({ status: 'CANDIDATE_SEMANTIC_ARTIFACT', authority: 'none' });
        expect(admitted.evidence.endpointOrigin).toBe(exact);
        expect(remote.requests).toHaveLength(1);
      } finally {
        await remote.close();
      }
    });

    it.each([
      ['unspecified address 0.0.0.0', 'http://0.0.0.0:11434/api'],
      ['other 127/8 address', 'http://127.0.0.2:11434/api'],
      ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]:11434/api'],
      ['fully-qualified localhost.', 'http://localhost.:11434/api'],
      ['localhost as a subdomain label', 'http://localhost.evil.example:11434/api'],
    ])('the loopback set is exactly 127.0.0.1, localhost and ::1: refuses %s', async (_name, baseURL) => {
      const result = await runBoundedLocalUnknown(task, { ...options, baseURL });
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'endpoint_not_locally_admitted', authority: 'none' });
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('context budget boundary', () => {
    it('a prompt of exactly maxContextChars is admitted; one more char is RESOURCE_EXHAUSTED', async () => {
      const limit = 16;
      const exact = await runBoundedLocalUnknown(
        { ...task, prompt: 'x'.repeat(limit) },
        { ...options, budget: { ...budget, maxContextChars: limit } },
      );
      expect(exact.status).toBe('CANDIDATE_SEMANTIC_ARTIFACT');
      expect(server.requests).toHaveLength(1);

      const over = await runBoundedLocalUnknown(
        { ...task, prompt: 'x'.repeat(limit + 1) },
        { ...options, budget: { ...budget, maxContextChars: limit } },
      );
      expect(over).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'context_char_budget_exhausted' });
      expect(server.requests).toHaveLength(1);
    });
  });

  describe('wrapper-side output bound (independent of provider eval_count)', () => {
    const defaultLimit = budget.maxOutputTokens * MAX_CHARS_PER_OUTPUT_TOKEN;

    it.each([
      ['a 1,000,000-char candidate with no eval_count', { response: 'y'.repeat(1_000_000) }],
      ['a 100,000-char candidate that under-reports eval_count=1', { response: 'y'.repeat(100_000), eval_count: 1 }],
      ['one char over the derived ceiling', { response: 'y'.repeat(defaultLimit + 1), eval_count: 1 }],
    ])('%s is RESOURCE_EXHAUSTED, never a candidate', async (_name, body) => {
      server.setHandler((_req, res) => ollamaJson(res, 200, body));
      const result = await runBoundedLocalUnknown(task, options);
      expect(result).toMatchObject({
        status: 'RESOURCE_EXHAUSTED',
        reason: 'candidate_exceeded_output_char_budget',
        standing: 'observed',
        authority: 'none',
      });
      expect(result).not.toHaveProperty('artifact');
      expect(server.requests).toHaveLength(1);
    });

    it('a candidate of exactly the derived ceiling is admitted', async () => {
      server.setHandler((_req, res) => ollamaJson(res, 200, { response: 'y'.repeat(defaultLimit), eval_count: 1 }));
      const result = await runBoundedLocalUnknown(task, options);
      expect(result.status).toBe('CANDIDATE_SEMANTIC_ARTIFACT');
      expect(result.status === 'CANDIDATE_SEMANTIC_ARTIFACT' && result.artifact.length).toBe(defaultLimit);
    });

    it('an explicit maxOutputChars tightens the ceiling', async () => {
      server.setHandler((_req, res) => ollamaJson(res, 200, { response: 'abcdef', eval_count: 1 }));
      const tight = await runBoundedLocalUnknown(task, { ...options, budget: { ...budget, maxOutputChars: 5 } });
      expect(tight).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'candidate_exceeded_output_char_budget' });
      const exact = await runBoundedLocalUnknown(task, { ...options, budget: { ...budget, maxOutputChars: 6 } });
      expect(exact).toMatchObject({ status: 'CANDIDATE_SEMANTIC_ARTIFACT', artifact: 'abcdef' });
    });

    it.each([
      ['zero', 0],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['string', '8' as unknown as number],
    ])('a %s maxOutputChars is refused before any request', async (_name, maxOutputChars) => {
      const result = await runBoundedLocalUnknown(task, { ...options, budget: { ...budget, maxOutputChars } });
      expect(result).toMatchObject({ status: 'REFUSED', reason: 'invalid_finite_budget' });
      expect(server.requests).toHaveLength(0);
    });

    it('an endless body is cut off at the byte ceiling, before the time budget', async () => {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      server.setHandler((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"response":"');
        const pump = () => {
          while (!res.destroyed && res.write(chunk)) {
            // keep writing until the socket applies back-pressure or is closed
          }
          if (!res.destroyed) {
            res.once('drain', pump);
          }
        };
        pump();
      });
      const started = Date.now();
      const result = await runBoundedLocalUnknown(task, {
        ...options,
        budget: { ...budget, maxOutputChars: 1, timeoutMs: 20_000 },
      });
      expect(result).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'local_response_body_budget_exhausted' });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(RESPONSE_ENVELOPE_BYTES).toBeGreaterThan(0);
    });
  });

  describe('time budget does not depend on the transport honouring AbortSignal', () => {
    // A real platform fetch to the real loopback server, with the signal stripped:
    // this is the shape of a caller-injected transport that ignores cancellation.
    const signalIgnoringFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, { ...init, signal: undefined })) as typeof fetch;

    it('headers that never arrive still yield RESOURCE_EXHAUSTED at the deadline', async () => {
      server.setHandler(() => undefined);
      const started = Date.now();
      const result = await runBoundedLocalUnknown(task, {
        ...options,
        fetch: signalIgnoringFetch,
        budget: { ...budget, timeoutMs: 200 },
      });
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'local_timeout_budget_exhausted' });
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1500);
      expect(server.requests).toHaveLength(1);
    });

    it('a body that stalls still yields RESOURCE_EXHAUSTED at the deadline', async () => {
      server.setHandler((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"response":"');
      });
      const started = Date.now();
      const result = await runBoundedLocalUnknown(task, {
        ...options,
        fetch: signalIgnoringFetch,
        budget: { ...budget, timeoutMs: 200 },
      });
      expect(result).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'local_timeout_budget_exhausted' });
      expect(Date.now() - started).toBeLessThan(1500);
    });
  });

  describe('performance regression bound (see docs/jira/v26.9.16/BENCH-RECEIPT.json)', () => {
    it('pre-flight refusal path stays far below 1 ms per call', async () => {
      const n = 5000;
      const refusedOptions = { ...options, baseURL: 'https://frontier.example/api' };
      const started = performance.now();
      for (let i = 0; i < n; i++) {
        await runBoundedLocalUnknown(task, refusedOptions);
      }
      const perCallMs = (performance.now() - started) / n;
      expect(server.requests).toHaveLength(0);
      // Bench receipt records 0.0017 ms mean/call; 0.25 ms is a >100x regression guard.
      expect(perCallMs).toBeLessThan(0.25);
    });

    it('wrapper round trip over loopback stays within the recorded bound', async () => {
      const n = 200;
      const samples: number[] = [];
      for (let i = 0; i < n; i++) {
        const started = performance.now();
        const result = await runBoundedLocalUnknown(task, options);
        samples.push(performance.now() - started);
        expect(result.status).toBe('CANDIDATE_SEMANTIC_ARTIFACT');
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(n * 0.95)];
      expect(server.requests).toHaveLength(n);
      // Bench receipt records 2.05 ms mean / 4.25 ms p99 loopback round trip on an idle host;
      // a loaded shared host measured p99 25.25 ms. 100 ms p95 stays a >20x regression guard
      // without failing spuriously under load.
      expect(p95).toBeLessThan(100);
    });
  });
});

const realOllamaModel = process.env.OLLAMA_LOCAL_UNKNOWN_MODEL;

describe.skipIf(isEdgeRuntime || !realOllamaModel)(
  'runBoundedLocalUnknown against a real Ollama daemon (set OLLAMA_LOCAL_UNKNOWN_MODEL; skipped otherwise)',
  () => {
    it('returns candidate material with real usage evidence', async () => {
      const result = await runBoundedLocalUnknown(
        { ...task, prompt: 'Reply with the single word: ok' },
        {
          model: realOllamaModel as string,
          configRevision: 'real-ollama-court',
          budget: { maxOutputTokens: 16, maxContextTokens: 512, maxContextChars: 256, timeoutMs: 120_000, temperature: 0, seed: 1 },
        },
      );
      expect(['CANDIDATE_SEMANTIC_ARTIFACT', 'NO_CANDIDATE', 'RESOURCE_EXHAUSTED']).toContain(result.status);
      expect(result.authority).toBe('none');
      expect(result.evidence.endpointOrigin).toBe('http://127.0.0.1:11434');
    }, 180_000);
  },
);
