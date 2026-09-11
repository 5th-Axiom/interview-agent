import { createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const accessCookie = "interview_test_access";
export const accessTTL = 7 * 24 * 60 * 60;
export const accessEnabled = () =>
  process.env.APP_ENV === "staging" ||
  Boolean(
    process.env.TEST_ACCESS_USERNAME || process.env.TEST_ACCESS_PASSWORD_HASH,
  );

function signingKey() {
  if (!process.env.AUTH_SECRET || !process.env.TEST_ACCESS_PASSWORD_HASH)
    throw new Error("Test access is not configured");
  // Changing the account/password invalidates previously issued access cookies.
  return createHash("sha256")
    .update(
      JSON.stringify([
        "test-access-v1",
        process.env.AUTH_SECRET,
        process.env.TEST_ACCESS_USERNAME,
        process.env.TEST_ACCESS_PASSWORD_HASH,
      ]),
    )
    .digest();
}
export function credentialsMatch(username: string, password: string) {
  const encoded = process.env.TEST_ACCESS_PASSWORD_HASH ?? "";
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(encoded)) return false;
  const [salt, digest] = encoded.split(":");
  const validPassword = timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(digest, "hex"),
  );
  return username === process.env.TEST_ACCESS_USERNAME && validPassword;
}
export async function issueAccessToken(seconds = accessTTL) {
  return new SignJWT({ purpose: "test-access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(process.env.TEST_ACCESS_USERNAME!)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
    .sign(signingKey());
}
export async function hasTestAccess(cookie: string | null | undefined) {
  if (!accessEnabled()) return true;
  const token = cookie?.match(
    new RegExp(`(?:^|;\\s*)${accessCookie}=([^;]+)`),
  )?.[1];
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      algorithms: ["HS256"],
    });
    return (
      payload.purpose === "test-access" &&
      payload.sub === process.env.TEST_ACCESS_USERNAME
    );
  } catch {
    return false;
  }
}
export function safeReturnTo(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\/(?!\/)/.test(value) ||
    /[\\\u0000-\u001f]/.test(value)
  )
    return "/interview";
  const url = new URL(value, "https://interview.invalid");
  if (url.origin !== "https://interview.invalid" || url.pathname === "/access")
    return "/interview";
  return url.pathname + url.search + url.hash;
}
