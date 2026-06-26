import dbQuery from "../../../config/db.js";

export const findItems = async ({ search, page = 1, limit = 10, sortBy = 'item_code', order = 'ASC', filters = {} } = {}) => {
  const conditions = [];
  const values = [];

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(i.item_code ILIKE $${values.length} OR i.itemdesc ILIKE $${values.length} OR i.grpname ILIKE $${values.length})`);
  }

  if (filters.sticker_generated === true) {
    conditions.push(`EXISTS (SELECT 1 FROM DailyProd dp WHERE dp.ItemDcode = i.itemdcode AND dp.sticker_generated = true)`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const safePage  = Math.max(1, parseInt(page));
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset    = (safePage - 1) * safeLimit;

  const allowedColumns = ['itemdcode', 'item_code', 'itemdesc', 'grpname', 'minqty', 'reorderqty'];
  const finalSortBy = allowedColumns.includes(sortBy.toLowerCase()) ? `i.${sortBy}` : 'i.itemdcode';
  const finalOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM Item i ${whereClause}`, values);
  const totalCount = parseInt(countRes[0]?.count || 0);

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT i.* FROM Item i 
     ${whereClause} 
     ORDER BY ${finalSortBy} ${finalOrder} 
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  return { 
    data: rows, 
    total: totalCount, 
    page: safePage, 
    limit: safeLimit, 
    totalPages: Math.ceil(totalCount / safeLimit) 
  };
};

export const findItemById = async (ItemDcode) => {
  const [item] = await dbQuery(`SELECT * FROM Item WHERE ItemDcode = $1`, [ItemDcode]);
  return item ?? null;
};

export const findLedgers = async ({ search, page = 1, limit = 10, sortBy = 'acc_code', order = 'DESC' } = {}) => {
  const conditions = [];
  const values = [];

  // Search by account name
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(Acc_Name ILIKE $${values.length})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const safePage  = Math.max(1, parseInt(page));
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset    = (safePage - 1) * safeLimit;

  // Whitelist columns to prevent SQL injection
  const allowedColumns = ['acc_code', 'acc_name'];
  const finalSortBy = allowedColumns.includes(sortBy.toLowerCase()) ? sortBy : 'acc_code';
  const finalOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM Ledger ${whereClause}`, values);
  const totalCount = parseInt(countRes[0]?.count || 0);

  values.push(safeLimit, offset);
  const rows = await dbQuery(
    `SELECT * FROM Ledger 
     ${whereClause} 
     ORDER BY ${finalSortBy} ${finalOrder} 
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  return { 
    data: rows, 
    total: totalCount, 
    page: safePage, 
    limit: safeLimit, 
    totalPages: Math.ceil(totalCount / safeLimit) 
  };
};

export const findLedgerById = async (Acc_Code) => {
  const [ledger] = await dbQuery(`SELECT * FROM Ledger WHERE Acc_Code = $1`, [Acc_Code]);
  return ledger ?? null;
};

export const findPartyRates = async ({ search, acc_code, item_dcode, page = 1, limit = 10, sortBy = 'acc_name', order = 'ASC' } = {}) => {
  const conditions = [];
  const values = [];

  if (search) {
    values.push(`%${search}%`);
    const sIdx = values.length;
    conditions.push(`(
      CAST(pr.Acc_code AS TEXT) ILIKE $${sIdx} OR 
      pr.Narr1 ILIKE $${sIdx} OR 
      l.acc_name ILIKE $${sIdx} OR 
      i.itemdesc ILIKE $${sIdx} OR
      i.item_code ILIKE $${sIdx}
    )`);
  }

  // Exact filters
  if (acc_code) { 
    values.push(acc_code); 
    conditions.push(`pr.Acc_code = $${values.length}`); 
  }
  if (item_dcode) { 
    values.push(item_dcode); 
    conditions.push(`pr.ItemDcode = $${values.length}`); 
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const safePage  = Math.max(1, parseInt(page));
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset    = (safePage - 1) * safeLimit;

  // 3. Dynamic Sorting Logic
  const allowedColumns = {
    'acc_name': 'l.acc_name',
    'itemdesc': 'i.itemdesc',
    'item_code': 'i.item_code',
    'itapv': 'pr.itapv',
    'acc_code': 'pr.acc_code'
  };

  const sortColumn = allowedColumns[sortBy.toLowerCase()] || 'l.acc_name';
  let finalOrder = 'ASC';

  // itapv sort: map 0/1 order flag to ASC/DESC
  if (sortBy.toLowerCase() === 'itapv') {
    finalOrder = (order === '0' || order === 0) ? 'ASC' : 'DESC';
  } else {
    finalOrder = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  }

  const countRes = await dbQuery(
    `SELECT COUNT(*) AS count FROM MSTPartyRate pr
     LEFT JOIN Ledger l ON pr.Acc_code = l.acc_code
     LEFT JOIN Item i ON pr.ItemDcode = i.itemdcode
     ${whereClause}`, values
  );
  const count = countRes[0]?.count || 0;

  const finalValues = [...values, safeLimit, offset];
  const rows = await dbQuery(
    `SELECT 
        pr.acc_code, pr.itemdcode, pr.narr1, pr.itapv,
        l.acc_name, i.itemdesc, i.item_code, i.grpname, i.primitemdesc
     FROM MSTPartyRate pr
     LEFT JOIN Ledger l ON pr.Acc_code = l.acc_code
     LEFT JOIN Item i ON pr.ItemDcode = i.itemdcode
     ${whereClause} 
     ORDER BY ${sortColumn} ${finalOrder} 
     LIMIT $${finalValues.length - 1} OFFSET $${finalValues.length}`,
    finalValues
  );

  return { 
    data: rows, 
    total: parseInt(count), 
    page: safePage, 
    limit: safeLimit, 
    totalPages: Math.ceil(parseInt(count) / safeLimit) 
  };
};

export const findDailyProd = async ({ search, acc_code, item_dcode, from_date, to_date, sticker_generated, page = 1, limit = 10, sortBy, order, permission = {} } = {}) => {
  
  const conditions = [];
  const values = [];

  // Permission-based date restriction (can_view_days)
  if (permission?.can_view_days > 0) {
    conditions.push(`dp.Doc_Dt >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  if (search) {
    values.push(`%${search}%`);
    const sIdx = values.length;
    conditions.push(`(
      CAST(dp.Doc_No AS TEXT) ILIKE $${sIdx} OR 
      dp.Job_Card_No ILIKE $${sIdx} OR
      i.Item_Code ILIKE $${sIdx} OR
      i.ItemDesc ILIKE $${sIdx} OR
      l.Acc_Name ILIKE $${sIdx} OR
      CAST(dp.Total_Qty AS TEXT) ILIKE $${sIdx}
    )`);
  }

  // 2. Exact Filters
  if (acc_code) { 
    values.push(acc_code); 
    conditions.push(`dp.Acc_Code = $${values.length}`); 
  }
  
  if (item_dcode) { 
    values.push(item_dcode); 
    conditions.push(`dp.ItemDcode = $${values.length}`); 
  }

  // Sticker Status ---
  if (sticker_generated !== undefined && sticker_generated !== '') {
    values.push(sticker_generated === 'true' || sticker_generated === true); 
    conditions.push(`dp.sticker_generated = $${values.length}`); 
  }
  
  if (from_date) { 
    values.push(from_date); 
    conditions.push(`dp.Doc_Dt >= $${values.length}`); 
  }
  
  if (to_date) { 
    values.push(to_date); 
    conditions.push(`dp.Doc_Dt <= $${values.length}`); 
  }

  const sortMap = {
    doc_no: 'dp.Doc_No',
    doc_dt: 'dp.Doc_Dt',
    acc_name: 'l.Acc_Name',
    item_code: 'i.Item_Code',
    total_qty: 'dp.Total_Qty',
    sticker_status: 'dp.sticker_generated'
  };

  const sortColumn = sortMap[sortBy] || 'dp.Doc_Dt';
  const sortOrder = (order && order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const joinClause = `
    FROM DailyProd dp
    LEFT JOIN Item i ON dp.ItemDcode = i.ItemDcode
    LEFT JOIN Ledger l ON dp.Acc_Code = l.Acc_Code
  `;

  const safePage = Math.max(1, parseInt(page));
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (safePage - 1) * safeLimit;

  // 5. Total Count Query
  const countRes = await dbQuery(`SELECT COUNT(*) AS count ${joinClause} ${whereClause}`, values);
  const count = parseInt(countRes[0]?.count || 0);

  const dataValues = [...values];
  dataValues.push(safeLimit);
  const limitIdx = dataValues.length;
  dataValues.push(offset);
  const offsetIdx = dataValues.length;

  const query = `
    SELECT 
        dp.Doc_No AS "doc_no",
        TO_CHAR(dp.Doc_Dt, 'YYYY-MM-DD') AS "doc_dt",
        dp.Job_Card_No AS "job_card_no",
        dp.Acc_Code AS "acc_code",
        l.Acc_Name AS "acc_name",
        dp.ItemDcode AS "itemdcode",
        i.Item_Code AS "item_code",
        i.ItemDesc AS "item_desc",
        dp.Total_Qty AS "total_qty",
        dp.sticker_generated AS "sticker_generated",
        dp.internal_create_user AS "internal_create_user",
        dp.internal_create_date AS "internal_create_date",
        dp.system_generate_user AS "system_generate_user",
        dp.system_generate_date AS "system_generate_date",
        dp.system_generate_user AS "system_generate_user_name"
    FROM DailyProd dp
    LEFT JOIN Item i ON dp.ItemDcode = i.ItemDcode
    LEFT JOIN Ledger l ON dp.Acc_Code = l.Acc_Code
    ${whereClause}
    ORDER BY ${sortColumn} ${sortOrder}, dp.Doc_No DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const rows = await dbQuery(query, dataValues);

  return { 
    data: rows, 
    total: count, 
    page: safePage, 
    limit: safeLimit, 
    totalPages: Math.ceil(count / safeLimit) 
  };
};