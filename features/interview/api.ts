import { RequestError, responseData } from "@/shared/http";
import { pendingCommand } from "@/shared/pending-command";
export { RequestError } from "@/shared/http";
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
  return responseData(response);
}
export async function mutate<T = any>(
  path: string,
  body: Record<string, unknown> = {},
  request_id?: string,
  signal?: AbortSignal,
): Promise<T> {
  const pending = request_id ? null : await pendingCommand(path, body);
  const fixed = { ...body, request_id: request_id ?? pending!.id };
  try {
    let result: T;
    try {
      result = await api<T>(path, fixed, signal);
    } catch (e) {
      if (signal?.aborted || (e instanceof RequestError && e.status < 500))
        throw e;
      result = await api<T>(path, fixed, signal);
    }
    pending?.finish();
    return result;
  } catch (e) {
    if (
      e instanceof RequestError &&
      e.status >= 400 &&
      e.status < 500 &&
      e.status !== 408
    )
      pending?.finish();
    throw e;
  }
}
