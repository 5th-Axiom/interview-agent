import { Pool, PoolClient } from "pg";
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
});
export type DB = Pick<PoolClient, "query">;
export async function transaction<T>(
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export function requireThat(
  value: unknown,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new ApiError(status, message);
}
