/** Test doubles the tests of the GCP clients share: a scripted `fetch` and a fixed metadata server. Imported by tests only. */
import type { Metadata } from "./metadata-server.client.ts";

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** The metadata server of a gateway in medconomy-hunt, europe-west3-a, whose access token is `token-1`; it has no attributes. */
export const fixedMetadata: Metadata = {
  project: async () => "medconomy-hunt",
  zone: async () => "europe-west3-a",
  accessToken: async () => "token-1",
  attribute: async () => null,
};

/** A fetch that answers from `answers` by `<METHOD> <url>` and records each request. */
export function fakeFetch(answers: Record<string, () => Response>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("Authorization");
    requests.push({ method, url, authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new Error(`unexpected request ${method} ${url}`);
    return answer();
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}
