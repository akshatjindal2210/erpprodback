import pkg from "pg";
import config from "./config.js";

const { Pool } = pkg;

const pool = new Pool({
  ...config.db,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on("error", (err) => {
  console.error("PG Pool Error:", err.message);
  process.exit(1);
});

const dbQuery = async (query, params = []) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(query, params);
    return rows;
  } catch (err) {
    console.error("Query Error:", err.message);
    throw err;
  } finally {
    client.release();
  }
};

/** Run `fn(client)` on one pooled connection: BEGIN → work → COMMIT, or ROLLBACK on error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export default dbQuery;
