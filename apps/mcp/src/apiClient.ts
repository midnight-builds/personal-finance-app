// Thin HTTP client over the finance API. The MCP server never touches the
// database directly, so all business rules (transfer exclusion, grouping,
// categorization) stay in one place.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`API responded ${status}: ${JSON.stringify(body)}`);
  }
}

export type ApiClient = {
  get(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
};

export function createApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): ApiClient {
  const base = baseUrl.replace(/\/+$/, '');

  async function send(path: string, init: RequestInit) {
    const res = await fetchImpl(base + path, init);
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // Not our API (wrong FINANCE_API_URL?) or a proxy error page.
        throw new ApiError(res.status, { error: 'non_json_response', snippet: text.slice(0, 200) });
      }
    }
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  }

  return {
    get(path, query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query ?? {})) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const suffix = qs.size ? `?${qs}` : '';
      return send(path + suffix, { method: 'GET' });
    },
    post(path, body) {
      return send(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
  };
}
