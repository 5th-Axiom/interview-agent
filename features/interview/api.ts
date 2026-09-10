export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Interview-Client":
        typeof window !== "undefined" && location.pathname.startsWith("/admin")
          ? "admin"
          : "candidate",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(75000)])
      : AbortSignal.timeout(75000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new RequestError(response.status, data.error ?? "请求失败，请重试");
  return data;
}
export async function mutate<T = any>(
  path: string,
  body: Record<string, unknown> = {},
  request_id = crypto.randomUUID(),
  signal?: AbortSignal,
): Promise<T> {
  const fixed = { ...body, request_id };
  try {
    return await api<T>(path, fixed, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof RequestError && e.status < 500) throw e;
    return api<T>(path, fixed, signal);
  }
}
