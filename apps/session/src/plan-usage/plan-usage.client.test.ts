import { describe, expect, it } from "vitest";
import { readPlanUsage } from "./plan-usage.client.ts";

/** A fetch that answers the usage endpoint with `usage` and the messages endpoint with `probe`, recording the URLs. */
function fakeFetch(usage: Response, probe: Response = new Response("refused", { status: 500 })) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return url.endsWith("/api/oauth/usage") ? usage : probe;
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("readPlanUsage", () => {
  it("passes the usage endpoint's answer through", async () => {
    const limits = { five_hour: { utilization: 8, resets_at: "2026-11-08T18:00:00Z" }, seven_day: null, model_scoped: [] };
    const { fetchImpl, urls } = fakeFetch(Response.json(limits));
    expect(await readPlanUsage("token", fetchImpl)).toEqual({ subscriptionType: null, rateLimitsAvailable: true, rateLimits: limits });
    expect(urls).toHaveLength(1);
  });

  it("reads the rate-limit headers of a probe when the usage endpoint refuses the token", async () => {
    const probe = new Response("{}", {
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": "1762624800",
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
        "anthropic-ratelimit-unified-7d_fable-utilization": "0.01",
      },
    });
    const { fetchImpl } = fakeFetch(new Response("no scope", { status: 403 }), probe);
    expect(await readPlanUsage("token", fetchImpl)).toEqual({
      subscriptionType: null,
      rateLimitsAvailable: true,
      rateLimits: {
        five_hour: { utilization: 25, resets_at: "2025-11-08T18:00:00.000Z" },
        seven_day: { utilization: 50, resets_at: null },
        model_scoped: [{ display_name: "Fable", utilization: 1, resets_at: null }],
      },
    });
  });

  it("gives the wait of a 429 when the probe fails too", async () => {
    const { fetchImpl } = fakeFetch(new Response("slow down", { status: 429, headers: { "retry-after": "120" } }));
    expect(await readPlanUsage("token", fetchImpl)).toEqual({ retryAfterSeconds: 120 });
  });

  it("fails with both refusals for any other status", async () => {
    const { fetchImpl } = fakeFetch(new Response("bad token", { status: 401 }));
    await expect(readPlanUsage("token", fetchImpl)).rejects.toThrow("usage endpoint answered 401: bad token; header probe failed: messages endpoint answered 500: refused");
  });
});
