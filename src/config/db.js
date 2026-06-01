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

function toPgPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function getInsertId(row) {
  if (!row) return 0;
  if (row.id != null) return Number(row.id);
  const key = Object.keys(row).find((k) => k.endsWith("_id"));
  return key ? Number(row[key]) : 0;
}

function queryKind(sql) {
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) return "select";
  if (trimmed.startsWith("INSERT")) return "insert";
  return "mutation";
}

/**
 * Central PostgreSQL query helper (IMS + Task).
 * - `$1` placeholders (IMS) or `?` (Task, auto-converted)
 * - `INSERT … RETURNING` → row array (IMS)
 * - `INSERT` without RETURNING → `{ insertId, affectedRows }` (Task)
 * - `UPDATE`/`DELETE` without RETURNING → `{ insertId: 0, affectedRows }` (Task)
 * - `UPDATE`/`DELETE … RETURNING` → row array (IMS)
 */
const dbQuery = async (query, params = []) => {
  const client = await pool.connect();
  try {
    const hadReturning = /\bRETURNING\b/i.test(query);
    let sql = query.includes("?") ? toPgPlaceholders(query) : query;
    const kind = queryKind(sql);
    let taskStyleInsert = false;

    if (kind === "insert" && !/\bRETURNING\b/i.test(sql)) {
      sql = `${sql.replace(/;\s*$/, "")} RETURNING *`;
      taskStyleInsert = true;
    }

    const result = await client.query(sql, params);

    if (kind === "select") {
      return result.rows;
    }

    if (kind === "insert") {
      if (hadReturning || !taskStyleInsert) {
        return result.rows;
      }
      return {
        insertId: getInsertId(result.rows[0]),
        affectedRows: result.rowCount ?? 0,
      };
    }

    if (hadReturning) {
      return result.rows;
    }

    return {
      insertId: 0,
      affectedRows: result.rowCount ?? 0,
    };
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
