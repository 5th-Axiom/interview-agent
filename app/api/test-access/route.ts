import { NextRequest, NextResponse } from "next/server";
import {
  accessCookie,
  accessEnabled,
  accessTTL,
  credentialsMatch,
  hasTestAccess,
  issueAccessToken,
  safeReturnTo,
} from "@/server/test-access";

export const runtime = "nodejs";
const attempts = new Map<string, { count: number; until: number }>();
const headers = { "Cache-Control": "no-store, private" };
export async function GET(req: NextRequest) {
  return NextResponse.json(
    {
      enabled: accessEnabled(),
      authenticated: await hasTestAccess(req.headers.get("cookie")),
    },
    { headers },
  );
}
export async function POST(req: NextRequest) {
  if (req.headers.get("origin") !== new URL(process.env.APP_URL!).origin)
    return NextResponse.json(
      { error: "请求来源不允许" },
      { status: 403, headers },
    );
  if (!accessEnabled())
    return NextResponse.json({ next: "/interview" }, { headers });
  try {
    const reader = req.body?.getReader();
    if (!reader) throw new Error("body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 4096) {
        await reader.cancel();
        throw new Error("body");
      }
      chunks.push(part.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const options = {
      httpOnly: true,
      secure: process.env.APP_URL!.startsWith("https://"),
      sameSite: "strict" as const,
      path: "/",
    };
    if (body.action === "logout") {
      const response = NextResponse.json({ ok: true }, { headers });
      for (const name of [
        accessCookie,
        "interview_candidate",
        "interview_admin",
      ])
        response.cookies.set(name, "", { ...options, maxAge: 0 });
      return response;
    }
    const ip = req.headers.get("x-real-ip") ?? "direct";
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
    const attempt = attempts.get(ip) ?? { count: 0, until: now + 60000 };
    if (attempt.count >= 6 || attempts.size >= 10000)
      return NextResponse.json(
        { error: "尝试次数过多，请一分钟后重试" },
        { status: 429, headers: { ...headers, "Retry-After": "60" } },
      );
    attempt.count++;
    attempts.set(ip, attempt);
    if (
      typeof body.username !== "string" ||
      body.username.length > 128 ||
      typeof body.password !== "string" ||
      body.password.length > 256 ||
      !credentialsMatch(body.username.trim(), body.password)
    )
      return NextResponse.json(
        { error: "用户名或密码不正确，请重试" },
        { status: 401, headers },
      );
    attempts.delete(ip);
    const response = NextResponse.json(
      { next: safeReturnTo(body.next) },
      { headers },
    );
    response.cookies.set(accessCookie, await issueAccessToken(), {
      ...options,
      maxAge: accessTTL,
    });
    return response;
  } catch {
    return NextResponse.json(
      { error: "登录请求无效，请重试" },
      { status: 400, headers },
    );
  }
}
