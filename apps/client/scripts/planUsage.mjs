// Prints the claude.ai plan rate limits (5-hour, weekly, weekly per model) as JSON on stdout. With an account token in
// CLAUDE_CODE_OAUTH_TOKEN it reads the usage endpoint directly, since the Agent SDK turns its 429 answer into "no plan
// limits" and drops `retry-after`; that answer prints `{"retryAfterSeconds":n}`. The local login goes through the SDK,
// which refreshes its token: it opens a Claude Code session without sending a prompt, so the query costs no tokens.
// Spawned by `get_plan_usage` in plan_usage.rs.
import { query } from "@anthropic-ai/claude-agent-sdk";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Wait assumed when a 429 answer carries no `retry-after`. */
const DEFAULT_RETRY_AFTER_SECONDS = 300;

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
  if (response.status === 429) {
    return { retryAfterSeconds: Number(response.headers.get("retry-after")) || DEFAULT_RETRY_AFTER_SECONDS };
  }
  if (!response.ok) throw new Error(`usage endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return { subscriptionType: null, rateLimitsAvailable: true, rateLimits: await response.json() };
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
