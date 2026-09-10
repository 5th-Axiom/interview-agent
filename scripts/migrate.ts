import { readFile, readdir } from "node:fs/promises";
import { pool, transaction } from "../server/db";
await transaction(async (db) => {
  await db.query("SELECT pg_advisory_xact_lock(8419201)");
  await db.query(
    "CREATE TABLE IF NOT EXISTS migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
  );
  const files = (await readdir("migrations"))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const name = file.replace(/\.sql$/, "");
    if (
      !(await db.query("SELECT 1 FROM migrations WHERE name=$1", [name]))
        .rowCount
    ) {
      await db.query(await readFile(`migrations/${file}`, "utf8"));
      await db.query("INSERT INTO migrations(name) VALUES($1)", [name]);
    }
  }
});
await pool.end();
console.log("Migrations applied");
