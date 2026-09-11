import { modelProfile } from "./runtime-profile";
export const testMode = process.env.DEV_TEST_MODE === "true";
function productionEnvironment() {
  return (
    process.env.APP_ENV === "production" ||
    (process.env.NODE_ENV === "production" && process.env.APP_ENV !== "staging")
  );
}
export const testAuth =
  !productionEnvironment() && process.env.ALLOW_TEST_OTP === "true";
export function validateEnvironment() {
  if (
    process.env.APP_ENV &&
    !["development", "staging", "production"].includes(process.env.APP_ENV)
  )
    throw new Error("Invalid APP_ENV");
  if (
    process.env.NODE_ENV === "production" &&
    process.env.APP_ENV === "development"
  )
    throw new Error(
      "Use APP_ENV=staging for an explicitly isolated test deployment",
    );
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
  for (const purpose of ["interview", "summary", "assessment"] as const) {
    const profile = modelProfile(purpose);
    if (profile.contextWindow <= profile.outputReserve + profile.safetyMargin)
      throw new Error(`Invalid ${purpose} context budget`);
    if (!testMode) {
      if (!profile.model)
        throw new Error(`Missing ${purpose.toUpperCase()}_MODEL or LLM_MODEL`);
      if (!profile.base)
        throw new Error(
          `Missing ${purpose.toUpperCase()}_BASE_URL or LLM_BASE_URL`,
        );
      if (!(
        process.env[`${purpose.toUpperCase()}_API_KEY`] ||
        process.env.LLM_API_KEY
      ))
        throw new Error(
          `Missing ${purpose.toUpperCase()}_API_KEY or LLM_API_KEY`,
        );
    }
  }
  if (!testMode) {
    const required = [
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
  if (productionEnvironment()) {
    if (testMode || process.env.ALLOW_TEST_OTP === "true")
      throw new Error("Unsafe test configuration in production");
    for (const key of ["SMS_URL", "SMS_TOKEN", "ADMIN_PASSWORD_HASH"])
      if (!process.env[key]) throw new Error(`Missing production ${key}`);
  }
  if (productionEnvironment() || process.env.APP_ENV === "staging") {
    if (process.env.APP_ENV === "staging") {
      if (!process.env.TEST_ACCESS_USERNAME?.trim())
        throw new Error("Missing TEST_ACCESS_USERNAME");
      if (
        !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(
          process.env.TEST_ACCESS_PASSWORD_HASH ?? "",
        )
      )
        throw new Error("Invalid TEST_ACCESS_PASSWORD_HASH");
    }
    if (process.env.APP_ENV === "staging" && !testAuth)
      for (const key of ["SMS_URL", "SMS_TOKEN"])
        if (!process.env[key]) throw new Error(`Missing staging ${key}`);
    if (
      [process.env.AUTH_SECRET, process.env.PHONE_HASH_SECRET].some((s) =>
        s?.startsWith("replace-"),
      )
    )
      throw new Error("Replace deployment secret");
    if (!process.env.APP_URL?.startsWith("https://"))
      throw new Error("Deployment APP_URL must use HTTPS");
    if (
      !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(
        process.env.ADMIN_PASSWORD_HASH ?? "",
      )
    )
      throw new Error("Invalid deployment ADMIN_PASSWORD_HASH");
  }
}
