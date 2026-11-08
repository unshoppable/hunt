/**
 * The claude.ai plan rate limits (5-hour, weekly, weekly per model) of the Claude account a session VM's relay runs with,
 * read with its OAuth token; `hunt-ctl plan-usage` prints them for the desktop's Factory tab, since a poller session runs
 * with the poller's account, whose token stays on the VM. A port of the token path of `apps/client/scripts/planUsage.mjs`,
 * whose output shape `get_plan_usage` in `apps/client/src-tauri/src/agent/plan_usage.rs` reads: the usage endpoint first;
 * when it refuses the read (429 for too many requests, 403 for a token without the `user:profile` scope, as tokens of
 * `claude setup-token` are), a one-token request to PROBE_MODEL reads the limits from the `anthropic-ratelimit-unified-*`
 * response headers; when that fails too, a 429 gives `{retryAfterSeconds}` and any other refusal throws.
 */
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const REQUEST_TIMEOUT_MS = 10_000;
/** Wait assumed when a 429 answer carries no `retry-after`. */
const DEFAULT_RETRY_AFTER_SECONDS = 300;
/** Model of the header probe; the headers carry a weekly per-model window only for the model a request uses. */
const PROBE_MODEL = { id: "claude-fable-5-1", displayName: "Fable" };
/** Subscription tokens are served only for requests that identify as Claude Code; the server answers 429 otherwise. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** A window in the usage endpoint's shape: percentage used (0–100) and the ISO 8601 time it resets. */
export interface UsageWindow {
  utilization: number;
  resets_at: string | null;
}

/** The limits as `planUsage.mjs` prints them: the usage endpoint's answer, or the wait while reads are refused. */
export type PlanUsageReport =
  | { subscriptionType: null; rateLimitsAvailable: true; rateLimits: unknown }
  | { retryAfterSeconds: number };

/** Reads the plan limits of the account of `token`. */
export async function readPlanUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<PlanUsageReport> {
  const response = await fetchImpl(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) return { subscriptionType: null, rateLimitsAvailable: true, rateLimits: await response.json() };
  const refusal = `usage endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`;
  try {
    return await readFromHeaders(token, fetchImpl);
  } catch (error) {
    const probeFailure = `header probe failed: ${messageOf(error)}`;
    if (response.status !== 429) throw new Error(`${refusal}; ${probeFailure}`);
    return { retryAfterSeconds: Number(response.headers.get("retry-after")) || DEFAULT_RETRY_AFTER_SECONDS };
  }
}

/** Reads the limits from the rate-limit headers of a one-token request, in the usage endpoint's shape. */
async function readFromHeaders(token: string, fetchImpl: typeof fetch): Promise<PlanUsageReport> {
  const response = await fetchImpl(MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: PROBE_MODEL.id, max_tokens: 1, system: CLAUDE_CODE_IDENTITY, messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`messages endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const readWindow = (claim: string): UsageWindow | null => {
    const utilization = response.headers.get(`anthropic-ratelimit-unified-${claim}-utilization`);
    const reset = response.headers.get(`anthropic-ratelimit-unified-${claim}-reset`);
    if (utilization === null) return null;
    return { utilization: Number(utilization) * 100, resets_at: reset ? new Date(Number(reset) * 1000).toISOString() : null };
  };
  const modelClaims = [...response.headers.keys()].flatMap((name) => name.match(/^anthropic-ratelimit-unified-(7d_[a-z0-9_]+)-utilization$/)?.[1] ?? []);
  const modelScoped = modelClaims.map((claim) => ({ display_name: PROBE_MODEL.displayName, ...readWindow(claim) }));
  return {
    subscriptionType: null,
    rateLimitsAvailable: true,
    rateLimits: { five_hour: readWindow("5h"), seven_day: readWindow("7d"), model_scoped: modelScoped },
  };
}
