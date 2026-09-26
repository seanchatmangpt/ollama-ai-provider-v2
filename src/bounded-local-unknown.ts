export const SHLLM_CAPABILITY_ID = 'urn:chatman:capability:shllm-local-unknown';

export type LocalUnknownOutcome =
  | 'CANDIDATE_SEMANTIC_ARTIFACT'
  | 'NO_CANDIDATE'
  | 'RESOURCE_EXHAUSTED'
  | 'UNSUPPORTED'
  | 'REFUSED';

export interface AdmittedLocalUnknownTask {
  taskId: string;
  semanticSubject: string;
  workClass: 'UNKNOWN_LOCAL';
  standing: 'admitted';
  prompt: string;
}

export interface LocalInferenceBudget {
  maxOutputTokens: number;
  maxContextTokens: number;
  maxContextChars: number;
  timeoutMs: number;
  /**
   * Wrapper-side ceiling on the candidate length in UTF-16 code units. It holds
   * even when the provider omits or under-reports `eval_count`. Defaults to
   * `maxOutputTokens * MAX_CHARS_PER_OUTPUT_TOKEN`.
   */
  maxOutputChars?: number;
  temperature?: number;
  seed?: number;
}

export interface BoundedLocalOllamaOptions {
  model: string;
  /** Exact configuration revision used for allocation/receipt evidence. */
  configRevision: string;
  /** Defaults to the loopback Ollama API. */
  baseURL?: string;
  /** Non-loopback origins must be explicitly admitted here. */
  allowedOrigins?: string[];
  budget: LocalInferenceBudget;
  fetch?: typeof fetch;
}

export interface LocalInferenceEvidence {
  provider: 'ollama';
  model: string;
  configRevision: string;
  endpointOrigin: string;
  maxOutputTokens: number;
  maxContextTokens: number;
  timeoutMs: number;
  promptTokens?: number;
  outputTokens?: number;
  totalDurationNs?: number;
}

export type BoundedLocalUnknownResult =
  | {
      status: 'CANDIDATE_SEMANTIC_ARTIFACT';
      capabilityId: typeof SHLLM_CAPABILITY_ID;
      standing: 'candidate';
      authority: 'none';
      taskId: string;
      semanticSubject: string;
      artifact: string;
      evidence: LocalInferenceEvidence;
    }
  | {
      status: Exclude<LocalUnknownOutcome, 'CANDIDATE_SEMANTIC_ARTIFACT'>;
      capabilityId: typeof SHLLM_CAPABILITY_ID;
      standing: 'observed';
      authority: 'none';
      taskId: string;
      semanticSubject: string;
      reason: string;
      evidence: LocalInferenceEvidence;
    };

function evidence(
  task: Pick<AdmittedLocalUnknownTask, 'taskId' | 'semanticSubject'>,
  options: BoundedLocalOllamaOptions,
  origin: string,
  usage: Partial<LocalInferenceEvidence> = {},
): LocalInferenceEvidence {
  void task;
  return {
    provider: 'ollama',
    model: String(options?.model ?? ''),
    configRevision: String(options?.configRevision ?? ''),
    endpointOrigin: origin,
    maxOutputTokens: Number(options?.budget?.maxOutputTokens ?? 0),
    maxContextTokens: Number(options?.budget?.maxContextTokens ?? 0),
    timeoutMs: Number(options?.budget?.timeoutMs ?? 0),
    ...usage,
  };
}

function refusal(
  task: Pick<AdmittedLocalUnknownTask, 'taskId' | 'semanticSubject'>,
  options: BoundedLocalOllamaOptions,
  origin: string,
  status: Exclude<LocalUnknownOutcome, 'CANDIDATE_SEMANTIC_ARTIFACT'>,
  reason: string,
  usage: Partial<LocalInferenceEvidence> = {},
): BoundedLocalUnknownResult {
  return {
    status,
    capabilityId: SHLLM_CAPABILITY_ID,
    standing: 'observed',
    authority: 'none',
    taskId: String(task?.taskId ?? ''),
    semanticSubject: String(task?.semanticSubject ?? ''),
    reason,
    evidence: evidence(task, options, origin, usage),
  };
}

/** Largest delay setTimeout honours; larger values fire immediately. */
export const MAX_LOCAL_TIMEOUT_MS = 2_147_483_647;

/**
 * Default candidate length ceiling per budgeted output token. No tokenizer in
 * common use emits more than 32 UTF-16 code units per token, so an honest
 * provider never trips it, while a provider that omits or under-reports
 * `eval_count` cannot smuggle an unbounded artifact past the budget.
 */
export const MAX_CHARS_PER_OUTPUT_TOKEN = 32;

/** Fixed allowance for the JSON envelope (usage counters, context, metadata). */
export const RESPONSE_ENVELOPE_BYTES = 1_048_576;

/**
 * The only allow-list entries that can admit anything are exact serialised
 * HTTP(S) origins (scheme://host[:port], no path, no trailing slash). An entry
 * is compared to the endpoint origin by string equality, never by prefix.
 */
function canonicalAllowedOrigin(entry: unknown): string | null {
  if (typeof entry !== 'string') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(entry);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  return parsed.origin === entry ? entry : null;
}

function admittedOrigin(baseURL: string, allowedOrigins: string[] = []): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    return null;
  }

  // Only plain HTTP(S) endpoints carry an origin that can be admitted. Opaque
  // schemes (data:, file:, blob:) serialise their origin as "null" and must
  // never match an allow-list entry. Embedded credentials, query strings and
  // fragments would change the request target once `/generate` is appended.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    return null;
  }

  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]';

  if (loopback || allowedOrigins.some(entry => canonicalAllowedOrigin(entry) === parsed.origin)) {
    return parsed.origin;
  }

  return null;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validBudget(budget: LocalInferenceBudget | undefined): boolean {
  if (budget == null || typeof budget !== 'object') {
    return false;
  }
  if (
    !positiveInteger(budget.maxOutputTokens) ||
    !positiveInteger(budget.maxContextTokens) ||
    !positiveInteger(budget.maxContextChars) ||
    !positiveInteger(budget.timeoutMs) ||
    budget.timeoutMs > MAX_LOCAL_TIMEOUT_MS
  ) {
    return false;
  }
  if (budget.maxOutputChars !== undefined && !positiveInteger(budget.maxOutputChars)) {
    return false;
  }
  if (budget.temperature !== undefined && !(typeof budget.temperature === 'number' && Number.isFinite(budget.temperature) && budget.temperature >= 0)) {
    return false;
  }
  if (budget.seed !== undefined && !(typeof budget.seed === 'number' && Number.isSafeInteger(budget.seed))) {
    return false;
  }
  return true;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

type BodyRead = { kind: 'text'; text: string } | { kind: 'over_budget' } | { kind: 'failed'; error: unknown };

/**
 * Read at most `maxBytes` of the response body. The read stops (and the stream
 * is cancelled) as soon as the ceiling is crossed, so an admitted endpoint
 * cannot make the wrapper buffer an unbounded body.
 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<BodyRead> {
  try {
    const stream = response.body;
    if (stream == null) {
      const text = await response.text();
      return new TextEncoder().encode(text).byteLength > maxBytes ? { kind: 'over_budget' } : { kind: 'text', text };
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'over_budget' };
      }
      text += decoder.decode(value, { stream: true });
    }
    return { kind: 'text', text: text + decoder.decode() };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

/**
 * Execute one admitted UNKNOWN_LOCAL task against an explicitly local Ollama
 * endpoint. This function performs exactly one provider attempt, never retries,
 * never calls a frontier provider, never grants authority, and returns model
 * output as candidate material only.
 */
export async function runBoundedLocalUnknown(
  task: AdmittedLocalUnknownTask,
  options: BoundedLocalOllamaOptions,
): Promise<BoundedLocalUnknownResult> {
  const baseURL = String(options?.baseURL ?? 'http://127.0.0.1:11434/api').replace(/\/$/, '');
  const origin = admittedOrigin(baseURL, Array.isArray(options?.allowedOrigins) ? options.allowedOrigins : []);
  const fallbackOrigin = (() => {
    try {
      return new URL(baseURL).origin;
    } catch {
      return 'invalid';
    }
  })();

  if (
    task == null ||
    task.standing !== 'admitted' ||
    task.workClass !== 'UNKNOWN_LOCAL' ||
    !nonEmptyString(task.taskId) ||
    !nonEmptyString(task.semanticSubject) ||
    typeof task.prompt !== 'string'
  ) {
    return refusal(task, options, origin ?? fallbackOrigin, 'REFUSED', 'task_not_admitted_unknown_local');
  }

  if (!origin) {
    return refusal(task, options, fallbackOrigin, 'REFUSED', 'endpoint_not_locally_admitted');
  }

  if (options == null || !nonEmptyString(options.model) || !nonEmptyString(options.configRevision)) {
    return refusal(task, options, origin, 'REFUSED', 'local_profile_identity_missing');
  }

  const { budget } = options;
  if (!validBudget(budget)) {
    return refusal(task, options, origin, 'REFUSED', 'invalid_finite_budget');
  }

  if (task.prompt.length > budget.maxContextChars) {
    return refusal(task, options, origin, 'RESOURCE_EXHAUSTED', 'context_char_budget_exhausted');
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    return refusal(task, options, origin, 'UNSUPPORTED', 'fetch_unavailable');
  }

  const outputCharLimit = budget.maxOutputChars ?? budget.maxOutputTokens * MAX_CHARS_PER_OUTPUT_TOKEN;
  // Worst case JSON escaping is 6 bytes (\uXXXX) per UTF-16 code unit of the candidate.
  const maxBodyBytes = RESPONSE_ENVELOPE_BYTES + outputCharLimit * 6;

  const controller = new AbortController();
  const timedOut = (): BoundedLocalUnknownResult =>
    refusal(task, options, origin, 'RESOURCE_EXHAUSTED', 'local_timeout_budget_exhausted');

  const attempt = async (): Promise<BoundedLocalUnknownResult> => {
    try {
      const response = await fetchImpl(`${baseURL}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          prompt: task.prompt,
          stream: false,
          options: {
            num_predict: budget.maxOutputTokens,
            num_ctx: budget.maxContextTokens,
            temperature: budget.temperature,
            seed: budget.seed,
          },
        }),
        signal: controller.signal,
        // A redirect could move the single attempt to a non-admitted (frontier)
        // origin; it is surfaced as a refusal instead of being followed.
        redirect: 'manual',
      });

      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        return refusal(task, options, origin, 'REFUSED', 'local_provider_redirect_refused');
      }

      if (response.status === 404) {
        return refusal(task, options, origin, 'UNSUPPORTED', 'local_model_or_endpoint_unsupported');
      }

      if (!response.ok) {
        return refusal(task, options, origin, 'REFUSED', `local_provider_http_${response.status}`);
      }

      const read = await readBoundedBody(response, maxBodyBytes);
      if (read.kind === 'over_budget') {
        return refusal(task, options, origin, 'RESOURCE_EXHAUSTED', 'local_response_body_budget_exhausted');
      }
      if (read.kind === 'failed') {
        if (controller.signal.aborted || (read.error instanceof Error && read.error.name === 'AbortError')) {
          return timedOut();
        }
        return refusal(task, options, origin, 'REFUSED', 'malformed_local_provider_response');
      }

      let body: {
        response?: unknown;
        prompt_eval_count?: unknown;
        eval_count?: unknown;
        total_duration?: unknown;
      };
      try {
        body = JSON.parse(read.text) as typeof body;
      } catch {
        return refusal(task, options, origin, 'REFUSED', 'malformed_local_provider_response');
      }

      if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return refusal(task, options, origin, 'REFUSED', 'malformed_local_provider_response');
      }

      const count = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
      const promptTokens = count(body.prompt_eval_count);
      const outputTokens = count(body.eval_count);
      const totalDurationNs = count(body.total_duration);
      const usage = { promptTokens, outputTokens, totalDurationNs };

      if (outputTokens != null && outputTokens > budget.maxOutputTokens) {
        return refusal(task, options, origin, 'RESOURCE_EXHAUSTED', 'provider_exceeded_output_budget', usage);
      }

      if (typeof body.response !== 'string') {
        return refusal(task, options, origin, 'REFUSED', 'malformed_local_candidate', usage);
      }

      // Wrapper-side bound: holds whether or not the provider reported eval_count.
      if (body.response.length > outputCharLimit) {
        return refusal(task, options, origin, 'RESOURCE_EXHAUSTED', 'candidate_exceeded_output_char_budget', usage);
      }

      if (body.response.trim() === '') {
        return refusal(task, options, origin, 'NO_CANDIDATE', 'local_provider_returned_empty_candidate', usage);
      }

      return {
        status: 'CANDIDATE_SEMANTIC_ARTIFACT',
        capabilityId: SHLLM_CAPABILITY_ID,
        standing: 'candidate',
        authority: 'none',
        taskId: task.taskId,
        semanticSubject: task.semanticSubject,
        artifact: body.response,
        evidence: evidence(task, options, origin, usage),
      };
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return timedOut();
      }

      return refusal(task, options, origin, 'REFUSED', 'local_provider_failure');
    }
  };

  // The time budget is enforced by the wrapper itself, not delegated to the
  // transport: a caller-supplied fetch that ignores the AbortSignal still
  // yields RESOURCE_EXHAUSTED at the deadline instead of hanging the caller.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<BoundedLocalUnknownResult>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(timedOut());
    }, budget.timeoutMs);
  });

  try {
    return await Promise.race([attempt(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
