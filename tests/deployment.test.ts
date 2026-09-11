import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function check(overrides: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const c = await import('./server/config.ts'); c.validateEnvironment(); console.log(c.testAuth)",
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        APP_ENV: "staging",
        DEV_TEST_MODE: "false",
        ALLOW_TEST_OTP: "true",
        DATABASE_URL: "postgres://unused/unused",
        AUTH_SECRET: "a".repeat(64),
        PHONE_HASH_SECRET: "b".repeat(64),
        S3_BUCKET: "isolated-test",
        S3_ACCESS_KEY: "unused",
        S3_SECRET_KEY: "unused",
        APP_URL: "https://interview.example.com",
        ADMIN_PASSWORD_HASH: `${"a".repeat(32)}:${"b".repeat(128)}`,
        TEST_ACCESS_USERNAME: "tester",
        TEST_ACCESS_PASSWORD_HASH: `${"c".repeat(32)}:${"d".repeat(128)}`,
        LLM_API_KEY: "unused",
        LLM_BASE_URL: "https://example.com/v1",
        LLM_MODEL: "unused",
        TTS_VOICE: "unused",
        DEEPGRAM_API_KEY: "unused",
        TTS_API_KEY: "unused",
        ...overrides,
      },
    },
  );
}

test("only explicit staging permits fixed OTP with a production build", () => {
  const staging = check({});
  assert.equal(staging.status, 0, staging.stderr);
  assert.equal(staging.stdout.trim(), "true");
  for (const APP_ENV of ["", "production"])
    assert.match(check({ APP_ENV }).stderr, /Unsafe test configuration/);
  assert.match(check({ APP_ENV: "development" }).stderr, /explicitly isolated/);
  assert.match(check({ APP_ENV: "stagign" }).stderr, /Invalid APP_ENV/);
  assert.match(
    check({ APP_ENV: "production", NODE_ENV: "development" }).stderr,
    /Unsafe test configuration/,
  );
});

test("staging requires HTTPS and a hashed admin password, and real OTP needs SMS", () => {
  assert.match(
    check({ TEST_ACCESS_USERNAME: "" }).stderr,
    /TEST_ACCESS_USERNAME/,
  );
  assert.match(
    check({ TEST_ACCESS_PASSWORD_HASH: "plaintext" }).stderr,
    /TEST_ACCESS_PASSWORD_HASH/,
  );
  assert.match(
    check({ APP_URL: "http://interview.example.com" }).stderr,
    /HTTPS/,
  );
  assert.match(
    check({ ADMIN_PASSWORD_HASH: "", DEV_ADMIN_PASSWORD: "local-recruiter" })
      .stderr,
    /ADMIN_PASSWORD_HASH/,
  );
  assert.match(
    check({ ALLOW_TEST_OTP: "false" }).stderr,
    /Missing staging SMS_URL/,
  );
  const production = check({
    APP_ENV: "production",
    ALLOW_TEST_OTP: "false",
    SMS_URL: "https://example.com/sms",
    SMS_TOKEN: "unused",
  });
  assert.equal(production.status, 0, production.stderr);
  assert.equal(production.stdout.trim(), "false");
});
