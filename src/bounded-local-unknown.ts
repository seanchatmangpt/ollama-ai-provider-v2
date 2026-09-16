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
    model: options.model,
    configRevision: options.configRevision,
    endpointOrigin: origin,
    maxOutputTokens: options.budget.maxOutputTokens,
    maxContextTokens: options.budget.maxContextTokens,
    timeoutMs: options.budget.timeoutMs,
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
    taskId: task.taskId,
    semanticSubject: task.semanticSubject,
    reason,
    evidence: evidence(task, options, origin, usage),
  };
}

function admittedOrigin(baseURL: string, allowedOrigins: string[] = []): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    return null;
  }

  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]';

  if (loopback || allowedOrigins.includes(parsed.origin)) {
    return parsed.origin;
  }

  return null;
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
  const baseURL = (options.baseURL ?? 'http://127.0.0.1:11434/api').replace(/\/$/, '');
  const origin = admittedOrigin(baseURL, options.allowedOrigins);
  const fallbackOrigin = (() => {
    try {
      return new URL(baseURL).origin;
    } catch {
      return 'invalid';
    }
  })();

  if (task.standing !== 'admitted' || task.workClass !== 'UNKNOWN_LOCAL') {
    return refusal(task, options, origin ?? fallbackOrigin, 'REFUSED', 'task_not_admitted_unknown_local');
  }

  if (!origin) {
    return refusal(task, options, fallbackOrigin, 'REFUSED', 'endpoint_not_locally_admitted');
  }

  const { budget } = options;
  if (
    budget.maxOutputTokens <= 0 ||
    budget.maxContextTokens <= 0 ||
    budget.maxContextChars <= 0 ||
    budget.timeoutMs <= 0
  ) {
    return refusal(task, options, origin, 'REFUSED', 'invalid_finite_budget');
  }

  if (task.prompt.length > budget.maxContextChars) {
    return refusal(task, options, origin, 'RESOURCE_EXHAUSTED', 'context_char_budget_exhausted');
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    return refusal(task, options, origin, 'UNSUPPORTED', 'fetch_unavailable');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget.timeoutMs);

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
    });

    if (response.status === 404) {
      return refusal(task, options, origin, 'UNSUPPORTED', 'local_model_or_endpoint_unsupported');
    }

    if (!response.ok) {
      return refusal(task, options, origin, 'REFUSED', `local_provider_http_${response.status}`);
    }

    let body: {
      response?: unknown;
      prompt_eval_count?: unknown;
      eval_count?: unknown;
      total_duration?: unknown;
    };

    try {
      body = (await response.json()) as typeof body;
    } catch {
      return refusal(task, options, origin, 'REFUSED', 'malformed_local_provider_response');
    }

    const promptTokens = typeof body.prompt_eval_count === 'number' ? body.prompt_eval_count : undefined;
    const outputTokens = typeof body.eval_count === 'number' ? body.eval_count : undefined;
    const totalDurationNs = typeof body.total_duration === 'number' ? body.total_duration : undefined;
    const usage = { promptTokens, outputTokens, totalDurationNs };

    if (outputTokens != null && outputTokens > budget.maxOutputTokens) {
      return refusal(task, options, origin, 'RESOURCE_EXHAUSTED', 'provider_exceeded_output_budget', usage);
    }

    if (typeof body.response !== 'string') {
      return refusal(task, options, origin, 'REFUSED', 'malformed_local_candidate');
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
      return refusal(task, options, origin, 'RESOURCE_EXHAUSTED', 'local_timeout_budget_exhausted');
    }

    return refusal(task, options, origin, 'REFUSED', 'local_provider_failure');
  } finally {
    clearTimeout(timer);
  }
}
