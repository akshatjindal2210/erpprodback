export async function ensureColumns(query, tableName, columns = []) {
  for (const col of columns) {
    const name = col?.name;
    const addSql = col?.addSql;
    if (!name || !addSql) continue;

    const found = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       LIMIT 1`,
      [tableName, name]
    );

    if (Array.isArray(found) && found.length > 0) continue;

    await query(`ALTER TABLE ${tableName} ADD COLUMN ${addSql}`);
  }
}
