import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  accessCookie,
  credentialsMatch,
  hasTestAccess,
  issueAccessToken,
  safeReturnTo,
} from "../server/test-access";
import { proxy } from "../proxy";
import { POST } from "../app/api/test-access/route";

test("test access protects pages and APIs; cookies expire and password rotation revokes them", async () => {
  const keys = [
    "APP_ENV",
    "APP_URL",
    "AUTH_SECRET",
    "TEST_ACCESS_USERNAME",
    "TEST_ACCESS_PASSWORD_HASH",
  ];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const password = "test-only-access-password";
  const salt = "a".repeat(32);
  Object.assign(process.env, {
    APP_ENV: "staging",
    APP_URL: "https://interview.example.com",
    AUTH_SECRET: "a".repeat(64),
    TEST_ACCESS_USERNAME: "tester",
    TEST_ACCESS_PASSWORD_HASH: `${salt}:${scryptSync(password, salt, 64).toString("hex")}`,
  });
  const request = (path: string, cookie = "") =>
    new NextRequest(`https://interview.example.com${path}`, {
      headers: { cookie },
    });
  const post = (
    body: unknown,
    origin = "https://interview.example.com",
    ip = "login",
  ) =>
    POST(
      new NextRequest("https://interview.example.com/api/test-access", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-real-ip": ip,
        },
        body: JSON.stringify(body),
      }),
    );
  const oldProxy = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "true";
  try {
    assert(credentialsMatch("tester", password));
    assert(!credentialsMatch("outsider", password));
    assert(!credentialsMatch("tester", "wrong"));
    assert.equal(await hasTestAccess(null), false);
    const redirected = await proxy(request("/admin/roles"));
    assert.equal(
      new URL(redirected.headers.get("location")!).pathname,
      "/access",
    );
    for (const path of ["/api/config", "/api/auth/admin", "/ws"])
      assert.equal((await proxy(request(path))).status, 401);
    assert.equal((await proxy(request("/healthz"))).status, 200);
    assert.equal(
      (await post({ username: "tester", password }, "https://outsider.example"))
        .status,
      403,
    );
    assert.equal(
      (await post({ username: "tester", password: "wrong" })).status,
      401,
    );
    const login = await post({
      username: "tester",
      password,
      next: "/admin/roles",
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { next: "/admin/roles" });
    const setCookie = login.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=strict/i);
    const cookie = setCookie.split(";")[0];
    assert(await hasTestAccess(cookie));
    assert.equal((await proxy(request("/api/config", cookie))).status, 200);
    assert.equal(
      await hasTestAccess(`${accessCookie}=${await issueAccessToken(-1)}`),
      false,
    );
    assert.equal(await hasTestAccess(cookie + "tampered"), false);
    process.env.TEST_ACCESS_PASSWORD_HASH = `${salt}:${"b".repeat(128)}`;
    assert.equal(await hasTestAccess(cookie), false);
    const logout = await post({ action: "logout" });
    assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
    for (let i = 0; i < 6; i++)
      assert.equal(
        (
          await post(
            { username: "tester", password: "wrong" },
            undefined,
            "limit",
          )
        ).status,
        401,
      );
    assert.equal(
      (await post({ username: "tester", password }, undefined, "limit")).status,
      429,
    );
    assert.equal((await post({ password: "x".repeat(5000) })).status, 400);
    for (const value of [
      "//outsider.example",
      "/\\outsider.example",
      "https://outsider.example",
      "/access",
      "/\n/outsider.example",
    ])
      assert.equal(safeReturnTo(value), "/interview");
    assert.equal(
      safeReturnTo("/interview?entry=demo"),
      "/interview?entry=demo",
    );
  } finally {
    if (oldProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = oldProxy;
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});
