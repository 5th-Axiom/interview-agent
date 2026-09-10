export const testMode = process.env.DEV_TEST_MODE === "true";
export const testAuth =
  process.env.NODE_ENV !== "production" &&
  process.env.ALLOW_TEST_OTP === "true";
export function validateEnvironment() {
  for (const key of [
    "DATABASE_URL",
    "AUTH_SECRET",
    "PHONE_HASH_SECRET",
    "S3_BUCKET",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "APP_URL",
  ])
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  if ((process.env.AUTH_SECRET?.length ?? 0) < 32)
    throw new Error("AUTH_SECRET must have 32+ characters");
  if ((process.env.PHONE_HASH_SECRET?.length ?? 0) < 32)
    throw new Error("PHONE_HASH_SECRET must have 32+ characters");
  if (!testMode) {
    const required = [
      "LLM_API_KEY",
      "LLM_BASE_URL",
      "LLM_MODEL",
      "TTS_VOICE",
      process.env.ASR_PROVIDER === "dashscope"
        ? "DASHSCOPE_API_KEY"
        : "DEEPGRAM_API_KEY",
      process.env.TTS_PROVIDER === "tokendance"
        ? "TOKENDANCE_API_KEY"
        : "TTS_API_KEY",
    ];
    for (const key of required)
      if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  if (process.env.NODE_ENV === "production") {
    if (testMode || process.env.ALLOW_TEST_OTP === "true")
      throw new Error("Unsafe test configuration in production");
    for (const key of [
      "LLM_API_KEY",
      "LLM_MODEL",
      "SMS_URL",
      "SMS_TOKEN",
      "ADMIN_PASSWORD_HASH",
    ])
      if (!process.env[key]) throw new Error(`Missing production ${key}`);
    if (
      [process.env.AUTH_SECRET, process.env.PHONE_HASH_SECRET].some((s) =>
        s?.startsWith("replace-"),
      )
    )
      throw new Error("Replace production secret");
    if (!process.env.APP_URL?.startsWith("https://"))
      throw new Error("Production APP_URL must use HTTPS");
    if (
      !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(
        process.env.ADMIN_PASSWORD_HASH ?? "",
      )
    )
      throw new Error("Invalid production ADMIN_PASSWORD_HASH");
  }
}
