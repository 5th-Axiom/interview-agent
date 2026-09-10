import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { validateEnvironment } from "../server/config";
Object.assign(process.env, { NODE_ENV: "production" });
validateEnvironment();
const require = createRequire(import.meta.url);
const child = spawn(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    "start",
    "--hostname",
    "0.0.0.0",
    "--port",
    process.env.PORT ?? "3100",
  ],
  { stdio: "inherit", env: process.env },
);
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 1));
