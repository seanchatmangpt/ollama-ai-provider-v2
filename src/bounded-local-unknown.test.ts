import {
  SHLLM_CAPABILITY_ID,
  runBoundedLocalUnknown,
  type AdmittedLocalUnknownTask,
  type BoundedLocalOllamaOptions,
} from './bounded-local-unknown';

const task: AdmittedLocalUnknownTask = {
  taskId: 'task-1',
  semanticSubject: 'urn:test:subject:1',
  workClass: 'UNKNOWN_LOCAL',
  standing: 'admitted',
  prompt: 'resolve this bounded semantic edge',
};

const options: BoundedLocalOllamaOptions = {
  model: 'qwen3:4b',
  configRevision: 'local-profile-v26.9.16',
  budget: {
    maxOutputTokens: 64,
    maxContextTokens: 512,
    maxContextChars: 2048,
    timeoutMs: 100,
    temperature: 0,
    seed: 7,
  },
};

function okFetch(calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({
        response: '{"candidate":true}',
        prompt_eval_count: 11,
        eval_count: 7,
        total_duration: 123,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

describe('runBoundedLocalUnknown', () => {
  it('returns candidate-only material with explicit evidence and no authority', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const result = await runBoundedLocalUnknown(task, { ...options, fetch: okFetch(calls) });

    expect(result.status).toBe('CANDIDATE_SEMANTIC_ARTIFACT');
    expect(result.capabilityId).toBe(SHLLM_CAPABILITY_ID);
    expect(result.authority).toBe('none');
    expect(result.standing).toBe('candidate');
    expect(result.evidence).toMatchObject({
      provider: 'ollama',
      model: 'qwen3:4b',
      configRevision: 'local-profile-v26.9.16',
      maxOutputTokens: 64,
      maxContextTokens: 512,
      promptTokens: 11,
      outputTokens: 7,
    });
    expect(calls).toHaveLength(1);

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.options.num_predict).toBe(64);
    expect(body.options.num_ctx).toBe(512);
    expect(body.options.seed).toBe(7);
  });

  it('refuses work that is not admitted UNKNOWN_LOCAL without touching the provider', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response('{}');
    }) as typeof globalThis.fetch;

    const known = {
      ...task,
      workClass: 'KNOWN',
    } as unknown as AdmittedLocalUnknownTask;

    const result = await runBoundedLocalUnknown(known, { ...options, fetch });
    expect(result).toMatchObject({ status: 'REFUSED', reason: 'task_not_admitted_unknown_local', authority: 'none' });
    expect(calls).toBe(0);
  });

  it('refuses a nonlocal endpoint unless its origin is explicitly admitted', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response('{}');
    }) as typeof globalThis.fetch;

    const result = await runBoundedLocalUnknown(task, {
      ...options,
      baseURL: 'https://frontier.example/api',
      fetch,
    });

    expect(result).toMatchObject({ status: 'REFUSED', reason: 'endpoint_not_locally_admitted' });
    expect(calls).toBe(0);
  });

  it('allows an explicitly admitted self-hosted origin without changing capability identity', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const result = await runBoundedLocalUnknown(task, {
      ...options,
      model: 'llama3.2:3b',
      baseURL: 'http://edge-node.internal:11434/api',
      allowedOrigins: ['http://edge-node.internal:11434'],
      fetch: okFetch(calls),
    });

    expect(result.status).toBe('CANDIDATE_SEMANTIC_ARTIFACT');
    expect(result.capabilityId).toBe(SHLLM_CAPABILITY_ID);
    expect(result.evidence.model).toBe('llama3.2:3b');
    expect(calls).toHaveLength(1);
  });

  it('returns RESOURCE_EXHAUSTED before inference when context budget is exceeded', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response('{}');
    }) as typeof globalThis.fetch;

    const result = await runBoundedLocalUnknown(
      { ...task, prompt: 'x'.repeat(100) },
      { ...options, budget: { ...options.budget, maxContextChars: 16 }, fetch },
    );

    expect(result).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'context_char_budget_exhausted' });
    expect(calls).toBe(0);
  });

  it('returns RESOURCE_EXHAUSTED on timeout and never performs a second attempt', async () => {
    let calls = 0;
    const fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }) as typeof globalThis.fetch;

    const result = await runBoundedLocalUnknown(task, {
      ...options,
      budget: { ...options.budget, timeoutMs: 5 },
      fetch,
    });

    expect(result).toMatchObject({ status: 'RESOURCE_EXHAUSTED', reason: 'local_timeout_budget_exhausted' });
    expect(calls).toBe(1);
  });

  it('returns UNSUPPORTED for a missing local model/endpoint without fallback', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await runBoundedLocalUnknown(task, { ...options, fetch });
    expect(result).toMatchObject({ status: 'UNSUPPORTED', reason: 'local_model_or_endpoint_unsupported' });
    expect(calls).toBe(1);
  });

  it('refuses malformed output instead of promoting it to admitted state', async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ response: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;

    const result = await runBoundedLocalUnknown(task, { ...options, fetch });
    expect(result).toMatchObject({ status: 'REFUSED', reason: 'malformed_local_candidate', standing: 'observed', authority: 'none' });
  });
});
