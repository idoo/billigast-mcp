// HTTP access to prisjakt.nu's own frontend endpoints: the public GraphQL endpoint and the
// Next.js API routes the product page calls (offer list). Never the shop redirects.

import { SourceError } from "../../types.js";

export const SITE = "https://www.prisjakt.nu";

const HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  "accept-language": "sv-SE,sv;q=0.9",
  accept: "application/json",
};

function fail(message: string, status?: number): never {
  throw new SourceError(message, "prisjakt", status);
}

async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(SITE + path, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? HEADERS : { ...HEADERS, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`Prisjakt did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const route = path.split("?")[0];
  if (response.status === 404 || response.status === 410) fail("Not found on Prisjakt", response.status);
  if (!response.ok) fail(`Prisjakt answered HTTP ${response.status} for ${route}`, response.status);
  try {
    return await response.json();
  } catch {
    fail(`Prisjakt returned invalid JSON for ${route}`, response.status);
  }
}

interface GraphQLError {
  message: string;
  extensions?: { status?: number };
}

/** POST to /_internal/graphql; GraphQL errors become SourceError (404 when the item doesn't exist). */
export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const body = (await request("/_internal/graphql", { method: "POST", body: { query, variables } })) as {
    data?: T | null;
    errors?: GraphQLError[];
  };
  const error = body.errors?.[0];
  if (error) {
    const status = error.extensions?.status;
    if (status === 404) fail("Not found on Prisjakt", 404);
    fail(`Prisjakt GraphQL error: ${error.message}`, status);
  }
  if (!body.data) fail("Prisjakt GraphQL returned no data");
  return body.data;
}

export function getJson(path: string): Promise<unknown> {
  return request(path);
}
