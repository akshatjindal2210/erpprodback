/**
 * IMS Generic CRUD — one factory for list / get / create / update / delete.
 *
 * Usage:
 *   const crud = createCrud(config, { enrichRows, validate, beforeSave });
 *   router.post("/list", crud.list);
 *
 * Config (see modules/shortage/shortage.config.js):
 *   table, idField, entity, fields, listSelect, sortable, filterFields
 *
 * Hooks (all optional):
 *   enrichRows(rows)     — add display fields after read
 *   validate(data, ctx)    — return error string to block save; ctx: { mode, existing }
 *   beforeSave(data, ctx)  — patch payload before insert/update; ctx: { mode, req, existing }
 *   beforeDelete(row, req) — return error string to block delete
 */

import dbQuery from "../../../../config/db/db.js";
import { logActivity } from "../../../core/lib/utils/activity/logActivity.js";
import { extractListParams, sanitizeFilters } from "../../../core/lib/utils/query/queryHelper.js";
import { sanitizeSearch } from "../../../core/lib/utils/helper/helper.js";
import { auditUserName } from "../../../core/lib/utils/auth/approval.js";

const FIELD_TYPES = {
  int: (v) => parseInt(v, 10),
  number: (v) => Number(v),
  text: (v) => String(v).trim(),
  bool: (v) => v === true || v === "true" || v === 1 || v === "1",
  date: (v) => {
    const s = String(v).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s;
  },
};

function fieldKeys(config) {
  return Object.keys(config.fields || {});
}

function canInsert(key, def) {
  return def.readonly !== true && def.insert !== false;
}

function canUpdate(key, def) {
  return def.readonly !== true && def.update !== false;
}

/** Parse + validate body → { ok, errors[], data{} } */
function parseBody(config, body, mode) {
  const errors = [];
  const data = {};

  for (const [key, def] of Object.entries(config.fields || {})) {
    if (mode === "create" && !canInsert(key, def)) continue;
    if (mode === "update" && (!canUpdate(key, def) || body[key] === undefined)) continue;

    const raw = body[key];

    if (raw === undefined || raw === null || raw === "") {
      if (def.required) errors.push(`${key} is required`);
      continue;
    }

    if (def.type === "enum") {
      const val = String(raw).trim();
      if (!def.values?.includes(val)) {
        errors.push(`${key} must be one of: ${(def.values || []).join(", ")}`);
      } else {
        data[key] = val;
      }
      continue;
    }

    const parse = FIELD_TYPES[def.type] || FIELD_TYPES.text;
    const val = parse(raw);

    if ((def.type === "int" || def.type === "number") && !Number.isFinite(val)) {
      errors.push(`${key} must be a valid number`);
      continue;
    }
    if (def.type === "date" && !val) {
      errors.push(`${key} must be a valid date (YYYY-MM-DD)`);
      continue;
    }
    if (def.min != null && Number(val) < def.min) {
      errors.push(`${key} must be at least ${def.min}`);
      continue;
    }

    data[key] = val;
  }

  return { ok: errors.length === 0, errors, data };
}

function searchColumns(config, alias) {
  return fieldKeys(config)
    .filter((k) => config.fields[k].search)
    .map((k) => {
      const def = config.fields[k];
      if (def.type === "int" || def.type === "number") return `${alias}.${k}::text`;
      return `${alias}.${k}`;
    });
}

export function createCrud(config, hooks = {}) {
  const table = config.table;
  const alias = config.alias || "t";
  const idField = config.idField;
  const entity = config.entity || table;
  const softDelete = config.softDelete !== false;
  const listSelect = config.listSelect || [`${alias}.*`];
  const sortable = config.sortable || [idField];
  const filterFields = config.filterFields || [];
  const defaultSort = config.defaultSort || { by: idField, order: "DESC" };

  const enrich = async (rows) =>
    typeof hooks.enrichRows === "function" ? hooks.enrichRows(rows) : rows;

  const getId = (body) => body?.[idField] ?? body?.id;

  // --- DB layer (small, explicit SQL) ---

  async function dbList({ page, limit, filters, search, sortBy, order }) {
    const values = [];
    let n = 1;
    const where = [];

    if (softDelete) where.push(`${alias}.is_deleted = false`);

    for (const [key, val] of Object.entries(filters || {})) {
      if (val == null || val === "") continue;
      if (key === "from_date") {
        values.push(val);
        const dateCol = config.dateFilterColumn || "created_at";
        where.push(`${alias}.${dateCol} >= $${n++}`);
        continue;
      }
      if (key === "to_date") {
        values.push(val);
        const dateCol = config.dateFilterColumn || "created_at";
        where.push(`${alias}.${dateCol} <= $${n++}`);
        continue;
      }
      if (!filterFields.includes(key)) continue;
      values.push(val);
      where.push(`${alias}.${key} = $${n++}`);
    }

    if (search) {
      const cols = searchColumns(config, alias);
      if (cols.length) {
        values.push(`%${search}%`);
        where.push(`(${cols.map((c) => `${c} ILIKE $${n}`).join(" OR ")})`);
        n++;
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [{ count }] = await dbQuery(
      `SELECT COUNT(*) AS count FROM ${table} ${alias} ${whereSql}`,
      values
    );

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 10));
    const offset = (safePage - 1) * safeLimit;
    const sortCol = sortable.includes(sortBy) ? sortBy : defaultSort.by;
    const sortDir = order === "ASC" ? "ASC" : "DESC";

    const rows = await dbQuery(
      `SELECT ${listSelect.join(", ")}
       FROM ${table} ${alias}
       ${whereSql}
       ORDER BY ${alias}.${sortCol} ${sortDir}
       LIMIT $${n++} OFFSET $${n++}`,
      [...values, safeLimit, offset]
    );

    const total = Number(count);
    return { data: rows, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  async function dbGet(id) {
    const cond = softDelete ? `AND ${alias}.is_deleted = false` : "";
    const [row] = await dbQuery(
      `SELECT ${listSelect.join(", ")}
       FROM ${table} ${alias}
       WHERE ${alias}.${idField} = $1 ${cond}
       LIMIT 1`,
      [id]
    );
    return row ?? null;
  }

  async function dbInsert(data) {
    const keys = Object.keys(data);
    const [row] = await dbQuery(
      `INSERT INTO ${table} (${keys.join(", ")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})
       RETURNING *`,
      keys.map((k) => data[k])
    );
    return row;
  }

  async function dbUpdate(id, data) {
    const keys = Object.keys(data);
    const params = [...keys.map((k) => data[k]), id];
    const [row] = await dbQuery(
      `UPDATE ${table}
       SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = NOW()
       WHERE ${idField} = $${params.length}
         ${softDelete ? "AND is_deleted = false" : ""}
       RETURNING *`,
      params
    );
    return row ?? null;
  }

  async function dbDelete(id, deletedBy) {
    if (!softDelete) {
      await dbQuery(`DELETE FROM ${table} WHERE ${idField} = $1`, [id]);
      return;
    }
    await dbQuery(
      `UPDATE ${table}
       SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
       WHERE ${idField} = $1 AND is_deleted = false`,
      [id, deletedBy ?? null]
    );
  }

  // --- Shared save path (create, update, insertOne) ---

  async function prepareSave(body, req, mode, existing = null, options = {}) {
    const parsed = parseBody(config, body, mode);
    if (!parsed.ok) return { ok: false, message: parsed.errors.join("; ") };

    if (typeof hooks.validate === "function") {
      const msg = await hooks.validate(body, { mode, existing, ...options });
      if (msg) return { ok: false, message: msg };
    }

    let data = { ...parsed.data };
    if (mode === "create") data.created_by = auditUserName(req);
    if (mode === "update") data.updated_by = auditUserName(req);

    if (typeof hooks.beforeSave === "function") {
      data = (await hooks.beforeSave(data, { mode, req, existing, ...options })) ?? data;
    }

    return { ok: true, data };
  }

  async function insertOne(body, req, { skipLog = false, autoApprove = false } = {}) {
    const prep = await prepareSave(body, req, "create", null, { autoApprove });
    if (!prep.ok) return { success: false, message: prep.message };

    const row = await dbInsert(prep.data);
    if (!skipLog) await logActivity(req, { action: "create", entity, entity_id: row[idField], record: row });

    const [enriched] = await enrich([row]);
    return { success: true, data: enriched };
  }

  // --- HTTP handlers ---

  return {
    insertOne,

    async deleteOne(id, req, { skipLog = false } = {}) {
      await dbDelete(id, auditUserName(req));
      if (!skipLog) {
        await logActivity(req, { action: "delete", entity, entity_id: id });
      }
      return { success: true };
    },

    list: async (req, res) => {
      try {
        const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
          sortBy: defaultSort.by,
          order: defaultSort.order,
        });
        const result = await dbList({
          page,
          limit,
          filters: sanitizeFilters(filters, filterFields),
          search: sanitizeSearch(search),
          sortBy,
          order,
        });
        result.data = await enrich(result.data || []);
        res.json({ success: true, ...result });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    get: async (req, res) => {
      try {
        const id = getId(req.body);
        if (id == null) return res.status(400).json({ success: false, message: "ID required" });

        const row = await dbGet(id);
        if (!row) return res.status(404).json({ success: false, message: "Not found" });

        const [enriched] = await enrich([row]);
        res.json({ success: true, data: enriched });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    create: async (req, res) => {
      try {
        const out = await insertOne(req.body, req);
        if (!out.success) return res.status(400).json(out);
        res.status(201).json(out);
      } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, message: err.message });
      }
    },

    update: async (req, res) => {
      try {
        const id = getId(req.body);
        if (id == null) return res.status(400).json({ success: false, message: "ID required" });

        const existing = await dbGet(id);
        if (!existing) return res.status(404).json({ success: false, message: "Not found" });

        const prep = await prepareSave(req.body, req, "update", existing);
        if (!prep.ok) return res.status(400).json({ success: false, message: prep.message });

        const row = await dbUpdate(id, prep.data);
        if (!row) return res.status(404).json({ success: false, message: "Not found" });

        await logActivity(req, { action: "update", entity, entity_id: id, details: { fields: Object.keys(prep.data) } });

        const [enriched] = await enrich([row]);
        res.json({ success: true, data: enriched });
      } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, message: err.message });
      }
    },

    remove: async (req, res) => {
      try {
        const id = getId(req.body);
        if (id == null) return res.status(400).json({ success: false, message: "ID required" });

        const existing = await dbGet(id);
        if (!existing) return res.status(404).json({ success: false, message: "Not found" });

        if (typeof hooks.beforeDelete === "function") {
          const block = await hooks.beforeDelete(existing, req);
          if (block) return res.status(400).json({ success: false, message: block });
        }

        await dbDelete(id, auditUserName(req));
        await logActivity(req, { action: "delete", entity, entity_id: id, record: existing });

        res.json({ success: true, message: "Deleted successfully" });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },
  };
}
