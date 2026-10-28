// Prints the claude.ai plan rate limits (5-hour, weekly, weekly per model) as JSON on stdout. With an account token in
// CLAUDE_CODE_OAUTH_TOKEN it reads the usage endpoint directly, since the Agent SDK turns its 429 answer into "no plan
// limits" and drops `retry-after`. When that endpoint refuses a read (429 for too many requests, 403 for a token
// without the `user:profile` scope), a one-token request to PROBE_MODEL reads the limits from the
// `anthropic-ratelimit-unified-*` response headers instead; when that fails too, a 429 prints `{"retryAfterSeconds":n}`
// and any other refusal fails. The local login goes through the SDK, which refreshes its token: it opens a Claude Code
// session without sending a prompt, so the query costs no tokens. Spawned by `get_plan_usage` in agent/plan_usage.rs.
import { query } from "@anthropic-ai/claude-agent-sdk";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** Wait assumed when a 429 answer carries no `retry-after`. */
const DEFAULT_RETRY_AFTER_SECONDS = 300;
/** Model of the header probe; the headers carry a weekly per-model window only for the model a request uses. */
const PROBE_MODEL = { id: "claude-fable-5-1", displayName: "Fable" };
/** Subscription tokens are served only for requests that identify as Claude Code; the server answers 429 otherwise. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

try {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.stdout.write(JSON.stringify(token ? await readWithToken(token) : await readThroughSdk()));
} catch (error) {
  process.stderr.write(String(error?.message ?? error));
  process.exitCode = 1;
}

async function readWithToken(token) {
  const response = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) return { subscriptionType: null, rateLimitsAvailable: true, rateLimits: await response.json() };
  const refusal = `usage endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`;
  try {
    return await readFromHeaders(token);
  } catch (error) {
    const probeFailure = `header probe failed: ${error?.message ?? error}`;
    if (response.status !== 429) throw new Error(`${refusal}; ${probeFailure}`);
    process.stderr.write(probeFailure);
    return { retryAfterSeconds: Number(response.headers.get("retry-after")) || DEFAULT_RETRY_AFTER_SECONDS };
  }
}

/** Reads the limits from the rate-limit headers of a one-token request, in the usage endpoint's shape. */
async function readFromHeaders(token) {
  const response = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: PROBE_MODEL.id, max_tokens: 1, system: CLAUDE_CODE_IDENTITY, messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`messages endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const readWindow = (claim) => {
    const utilization = response.headers.get(`anthropic-ratelimit-unified-${claim}-utilization`);
    const reset = response.headers.get(`anthropic-ratelimit-unified-${claim}-reset`);
    if (utilization === null) return null;
    return { utilization: Number(utilization) * 100, resets_at: reset ? new Date(Number(reset) * 1000).toISOString() : null };
  };
  const modelClaims = [...response.headers.keys()]
    .map((name) => name.match(/^anthropic-ratelimit-unified-(7d_[a-z0-9_]+)-utilization$/)?.[1])
    .filter(Boolean);
  const modelScoped = modelClaims.map((claim) => ({ display_name: PROBE_MODEL.displayName, ...readWindow(claim) }));
  return {
    subscriptionType: null,
    rateLimitsAvailable: true,
    rateLimits: { five_hour: readWindow("5h"), seven_day: readWindow("7d"), model_scoped: modelScoped },
  };
}

async function readThroughSdk() {
  const idlePrompt = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
  const session = query({ prompt: idlePrompt, options: { settingSources: [] } });
  try {
    const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    return { subscriptionType: usage.subscription_type, rateLimitsAvailable: usage.rate_limits_available, rateLimits: usage.rate_limits };
  } finally {
    session.close();
  }
}
