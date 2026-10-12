// Prints the claude.ai plan rate limits (5-hour, weekly, weekly per model) as JSON on stdout. Opens a Claude Code
// session without sending a prompt, so the query costs no tokens. Spawned by `get_plan_usage` in plan_usage.rs.
import { query } from "@anthropic-ai/claude-agent-sdk";

const idlePrompt = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
const session = query({ prompt: idlePrompt, options: { settingSources: [] } });
try {
  const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  process.stdout.write(JSON.stringify({
    subscriptionType: usage.subscription_type,
    rateLimitsAvailable: usage.rate_limits_available,
    rateLimits: usage.rate_limits,
  }));
} finally {
  session.close();
}
