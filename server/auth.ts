import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { pool, transaction, requireThat, ApiError } from "./db";
import { testAuth } from "./config";
export type Actor = { user_id: string | null; org_id: string | null };
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const phoneHash = (s: string) =>
  createHmac("sha256", process.env.PHONE_HASH_SECRET!)
    .update(s.trim())
    .digest("hex");
export async function authenticate(
  cookie: string | null,
  scope = "candidate",
): Promise<Actor> {
  const name = scope === "admin" ? "interview_admin" : "interview_candidate";
  const token = cookie?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
  requireThat(token, "请先登录", 401);
  const row = (
    await pool.query(
      "SELECT user_id,org_id FROM auth_sessions WHERE token_hash=$1 AND expires_at>now()",
      [hash(token)],
    )
  ).rows[0];
  requireThat(row, "登录已过期，请重新登录", 401);
  return row;
}
export async function sendCode(phone: string) {
  requireThat(testAuth || /^1\d{10}$/.test(phone), "请输入有效手机号");
  const key = phoneHash(phone),
    code = testAuth ? "123456" : String(randomInt(100000, 999999));
  if (!testAuth)
    requireThat(
      process.env.SMS_URL && process.env.SMS_TOKEN,
      "短信服务尚未配置",
      503,
    );
  const token = randomUUID();
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const old = (
      await db.query("SELECT * FROM otp_codes WHERE phone_hash=$1", [key])
    ).rows[0];
    requireThat(
      !old ||
        old.delivery_state === "failed" ||
        (old.delivery_state === "pending"
          ? old.delivery_until.getTime() <= Date.now()
          : Date.now() - old.sent_at.getTime() >= 60000),
      "请在 60 秒后重试",
      429,
    );
    await db.query(
      `INSERT INTO otp_codes(phone_hash,code_hash,sent_at,expires_at,delivery_state,delivery_token,delivery_until)
      VALUES($1,$2,now(),now()+interval '5 minutes','pending',$3,now()+interval '15 seconds')
      ON CONFLICT(phone_hash) DO UPDATE SET code_hash=$2,sent_at=now(),expires_at=now()+interval '5 minutes',
      attempts=0,delivery_state='pending',delivery_token=$3,delivery_until=now()+interval '15 seconds'`,
      [key, hash(code), token],
    );
  });
  try {
    if (!testAuth) {
      const r = await fetch(process.env.SMS_URL!, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SMS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ phone, code }),
        signal: AbortSignal.timeout(10000),
      });
      requireThat(r.ok, "短信发送失败，请稍后重试", 502);
    }
    const result = await pool.query(
      "UPDATE otp_codes SET delivery_state='sent',sent_at=now() WHERE phone_hash=$1 AND delivery_token=$2",
      [key, token],
    );
    requireThat(result.rowCount, "验证码已更新，请重试", 409);
  } catch (error) {
    await pool.query(
      "UPDATE otp_codes SET delivery_state='failed' WHERE phone_hash=$1 AND delivery_token=$2 AND delivery_state='pending'",
      [key, token],
    );
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "短信发送失败，请稍后重试");
  }
}

export async function login(phone: string, code: string) {
  const key = phoneHash(phone);
  const user = await transaction(async (db) => {
    const otp = (
      await db.query("SELECT * FROM otp_codes WHERE phone_hash=$1 FOR UPDATE", [
        key,
      ])
    ).rows[0];
    if (
      !otp ||
      otp.delivery_state !== "sent" ||
      otp.expires_at.getTime() < Date.now() ||
      otp.attempts >= 5
    )
      return null;
    await db.query(
      "UPDATE otp_codes SET attempts=attempts+1 WHERE phone_hash=$1",
      [key],
    );
    if (otp.code_hash !== hash(code)) return null;
    await db.query("DELETE FROM otp_codes WHERE phone_hash=$1", [key]);
    return (
      await db.query(
        "INSERT INTO users(id,phone_hash,phone_mask) VALUES($1,$2,$3) ON CONFLICT(phone_hash) DO UPDATE SET phone_hash=excluded.phone_hash RETURNING id",
        [
          randomUUID(),
          key,
          phone.length >= 7
            ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
            : "测试候选人",
        ],
      )
    ).rows[0];
  });
  requireThat(user, "验证码错误、过期或尝试过多");
  return createLogin({ user_id: user.id, org_id: null });
}
export async function adminLogin(password: string) {
  let valid = false;
  if (testAuth && !process.env.ADMIN_PASSWORD_HASH)
    valid = password === process.env.DEV_ADMIN_PASSWORD;
  else {
    const [salt, digest] = (process.env.ADMIN_PASSWORD_HASH ?? "").split(":");
    if (salt && digest) {
      const actual = scryptSync(password, salt, 64),
        expected = Buffer.from(digest, "hex");
      valid =
        actual.length === expected.length && timingSafeEqual(actual, expected);
    }
  }
  requireThat(valid, "账号凭据不正确", 401);
  return createLogin({ user_id: null, org_id: "demo" });
}
async function createLogin(actor: Actor) {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO auth_sessions VALUES($1,$2,$3,now()+interval '7 days')",
    [hash(token), actor.user_id, actor.org_id],
  );
  return token;
}
const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET!);
export async function signTicket(
  payload: Record<string, unknown>,
  seconds = 60,
) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .setJti(randomUUID())
    .sign(secret());
}
export async function verifyTicket(token: string) {
  try {
    return (await jwtVerify(token, secret(), { algorithms: ["HS256"] }))
      .payload;
  } catch {
    throw new ApiError(401, "票据无效或已过期");
  }
}
