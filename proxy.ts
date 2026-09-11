import { NextRequest, NextResponse } from "next/server";
import { accessEnabled, hasTestAccess } from "./server/test-access";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    !accessEnabled() ||
    ["/access", "/api/test-access", "/healthz"].includes(path)
  )
    return NextResponse.next();
  if (await hasTestAccess(request.headers.get("cookie")))
    return NextResponse.next();
  if (path.startsWith("/api/") || path === "/ws")
    return NextResponse.json(
      { error: "请先登录测试环境", accessRequired: true },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  const url = request.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  url.searchParams.set(
    "next",
    request.nextUrl.pathname + request.nextUrl.search,
  );
  return NextResponse.redirect(url);
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
