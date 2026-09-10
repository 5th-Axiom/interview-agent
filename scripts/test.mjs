import "dotenv/config";
import dotenv from "dotenv";
import pg from "pg";
import { spawnSync } from "node:child_process";
dotenv.config({ path: ".env.local", quiet: true });
const url = new URL(process.env.DATABASE_URL);
url.pathname = "/interview_agent_test";
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
if (
  !(
    await admin.query(
      "SELECT 1 FROM pg_database WHERE datname='interview_agent_test'",
    )
  ).rowCount
)
  await admin.query("CREATE DATABASE interview_agent_test");
await admin.end();
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  DEV_TEST_MODE: "true",
  ALLOW_TEST_OTP: "true",
  NODE_ENV: "test",
  ASR_PROVIDER: "deepgram",
};
for (const args of [
  ["tsx", "scripts/migrate.ts"],
  ["tsx", "--test", "tests/*.test.ts"],
]) {
  const r = spawnSync("npx", args, { env, stdio: "inherit" });
  if (r.status) process.exit(r.status);
}
