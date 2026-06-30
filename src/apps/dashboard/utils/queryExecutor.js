import { withTransaction } from "../../../config/db.js";
import { toSafeLimitedSql } from "./sqlGenerator.js";

const QUERY_TIMEOUT_MS = 8000;

export async function executeReadOnlyWidgetQuery(rawSql) {
  const safeSql = toSafeLimitedSql(rawSql);

  return withTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    await client.query("SET TRANSACTION READ ONLY");
    const result = await client.query(safeSql);
    return result.rows || [];
  });
}

