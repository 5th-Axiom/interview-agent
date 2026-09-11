import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
let env;
try {
  env = await fs.readFile(".env.local", "utf8");
} catch {
  env = await fs.readFile(".env.example", "utf8");
}
env = env
  .replace(
    /^AUTH_SECRET=replace-.*$/m,
    `AUTH_SECRET=${randomBytes(32).toString("hex")}`,
  )
  .replace(
    /^PHONE_HASH_SECRET=replace-.*$/m,
    `PHONE_HASH_SECRET=${randomBytes(32).toString("hex")}`,
  );
await fs.writeFile(".env.local", env, { mode: 0o600 });
await fs.chmod(".env.local", 0o600);
for (const [cmd, args] of [
  ["docker", ["compose", "up", "-d", "--wait"]],
  ["npm", ["run", "db:migrate"]],
  ["npm", ["run", "db:seed"]],
]) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status) process.exit(r.status);
}
console.log(
  "Independent local database and private storage are ready. Run npm run dev:all.",
);
