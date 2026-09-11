import "dotenv/config";
import dotenv from "dotenv";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("..", import.meta.url));
dotenv.config({
  path: fileURLToPath(new URL("../.env.local", import.meta.url)),
  quiet: true,
});
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const schema = `interview_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set("options", `-c search_path=${schema},public`);
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
let code = 1;
await admin.connect();
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const env = {
    ...process.env,
    DATABASE_URL: url.toString(),
    APP_ENV: "development",
    NODE_ENV: "test",
    DEV_TEST_MODE: "true",
    ALLOW_TEST_OTP: "true",
    ASR_PROVIDER: "deepgram",
  };
  code = 0;
  for (const args of [
    ["tsx", "scripts/migrate.ts"],
    ["tsx", "--test", "tests/*.test.ts"],
  ]) {
    const r = spawnSync("npx", args, { cwd, env, stdio: "inherit" });
    if (r.status !== 0) {
      code = r.status ?? 1;
      break;
    }
  }
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
process.exitCode = code;
