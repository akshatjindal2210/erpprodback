import sql from "mssql";
import config from "./config.js";

const mssqlPool = new sql.ConnectionPool(config.mssql);

const connectMSSQL = async () => {
  if (!mssqlPool.connected) await mssqlPool.connect();
};

const fetchMSSQL = async (query) => {
  await connectMSSQL();
  try {
    const result = await mssqlPool.request().query(query);
    return result.recordset;
  } catch (err) {
    console.error("MSSQL Query Error:", err.message);
    throw err;
  }
};

export default fetchMSSQL;