export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}
export async function responseData(response: Response) {
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new RequestError(
      response.status,
      response.ok
        ? "服务返回格式异常，请重试"
        : response.status === 429
          ? "请求频繁，请稍后再试"
          : `服务暂时不可用（${response.status}），请重试`,
    );
  }
  if (!response.ok)
    throw new RequestError(
      response.status,
      typeof data?.error === "string" ? data.error : "请求失败，请重试",
    );
  return data;
}
