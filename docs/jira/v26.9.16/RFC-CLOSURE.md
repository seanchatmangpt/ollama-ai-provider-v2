# ollama-ai-provider-v2 v26.9.16 — RFC Closure Contract

Status: DRAFT IMPLEMENTATION PR.

## Canonical Jira ticket

- A2A-2611 — SHLLM bounded local UNKNOWN tier

## RFC ownership

This repo owns only the local-model provider boundary used by the DME routing architecture. It does not own semantic admission, authority, CMCA policy, or consequence execution.

## Required closure

1. Provide a bounded local-inference contract suitable for `UNKNOWN_LOCAL` work.
2. Require explicit model identity, context/token ceiling, timeout and deterministic/provider options where supported.
3. Return provider/model usage evidence sufficient for an upstream CMCA allocation receipt.
4. Treat model output as candidate material only.
5. Expose typed local insufficiency/failure/timeout so the caller can decide whether frontier escalation is justified; the provider must never escalate itself.
6. Preserve self-hosted/local endpoint support without making a cloud provider an implicit fallback.

## Chicago falsifiers

- missing local configuration silently selects a cloud provider;
- provider increases its own token/time/retry budget;
- local failure automatically calls a frontier API;
- model output is tagged as admitted/canonical/authorized;
- usage identity cannot distinguish model/provider/config revision;
- timeout/resource exhaustion is returned as successful completion.

## Definition of done

Exact-head tests prove bounded local invocation, explicit model/provider identity, usage evidence, candidate-only output, typed insufficiency, and zero automatic frontier fallback. Upstream routing remains owned by ash_a2a/CMCA.

## v26.9.26 hardening addendum

Court file: `src/bounded-local-unknown.hardening.test.ts` (real loopback `node:http` server,
platform `fetch`, state-based assertions on server-recorded requests). 26 cases marked
`[defect]` failed on head `a77330e8` and pass after the fix:

- non-finite / fractional / out-of-range budgets (NaN, Infinity, `timeoutMs > 2^31-1`, which
  `setTimeout` fires immediately) reached the provider instead of `invalid_finite_budget`;
- `redirect` was followed, so a local endpoint could move the single attempt to a
  non-admitted (frontier) origin; now `redirect: 'manual'` → `local_provider_redirect_refused`;
- opaque-scheme URLs (`data:` with an allow-listed `"null"` origin), embedded credentials,
  query strings and fragments were admitted as endpoints;
- malformed tasks (null, non-string prompt, empty ids) threw instead of a typed refusal;
- empty model / config revision passed (`local_profile_identity_missing`);
- JSON `null` / array bodies and a body stalled past the timeout were misclassified
  (the stall is now `RESOURCE_EXHAUSTED`); negative / non-finite usage counters were
  recorded as evidence.

Mutation check: reverting each guard (redirect, scheme, timeout ceiling, prompt shape,
body-timeout classification, finite-integer budget) makes at least one court case fail.

Benchmark: `src/bounded-local-unknown.bench.ts`; numbers and regression bounds in
`docs/jira/v26.9.16/BENCH-RECEIPT.json`, enforced by the hardening court's
performance-regression cases.

## v26.9.26 hardening, round 2

Defects from the adversarial court on `36b4549`, each pinned by a case in
`src/bounded-local-unknown.hardening.test.ts`:

- allow-list admission is exact serialised-origin equality. Entries that carry a path, a trailing
  slash, a different case or a non-string are inert; a look-alike host such as
  `https://gpu.lan.evil.example` is refused for the entry `https://gpu.lan`.
- the loopback set is exactly `127.0.0.1`, `localhost` and `::1`. `0.0.0.0`, `127.0.0.2`,
  `[::ffff:127.0.0.1]`, `localhost.` and `localhost.evil.example` are refused.
- a prompt of exactly `maxContextChars` is admitted and one more character is `RESOURCE_EXHAUSTED`.
- `timeoutMs` is a wall-clock deadline raced against the attempt. A caller-injected `fetch` that
  ignores the `AbortSignal` still returns `RESOURCE_EXHAUSTED local_timeout_budget_exhausted`.
- the candidate is bounded on the wrapper side: `maxOutputChars` defaults to
  `maxOutputTokens * 32`, so a provider that omits or under-reports `eval_count` gets
  `RESOURCE_EXHAUSTED candidate_exceeded_output_char_budget`. The response body is read as a
  stream and cut off at `1 MiB + 6 * maxOutputChars` bytes
  (`local_response_body_budget_exhausted`).
- the loopback round-trip regression bound is p95 < 100 ms. The previous 25 ms bound failed
  under host load.

Mutation check: prefix allow-list matching, adding `0.0.0.0` to the loopback set, `>=` on the
context check, removing the deadline race, removing or loosening the char ceiling, removing the
body byte ceiling and skipping `maxOutputChars` validation are each killed by at least one case.

