import dbQuery from "../shared/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

/** Parse JSON / CSV / array of ids from multipart or JSON body. */
export function parseIdList(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0))];
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parseIdList(parsed);
    } catch {
      /* comma-separated */
    }
    return [
      ...new Set(
        trimmed
          .split(/[,|\s]+/)
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? [n] : [];
}

function parseJsonArray(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Resolve concrete people for a CL master assignment scope.
 * Master stays one row; instances are per person.
 *
 * Priority:
 * 1. assignee_person_ids (multi-person)
 * 2. person_id (single — legacy / person mode)
 * 3. department_id (+ optional designation_id) → all active users in scope
 */
export async function resolveClMasterAssignees(master) {
  if (!master) return [];

  const fromJson = parseIdList(
    Array.isArray(master.assignee_person_ids)
      ? master.assignee_person_ids
      : typeof master.assignee_person_ids === "string"
        ? master.assignee_person_ids
        : parseJsonArray(master.assignee_person_ids),
  );

  if (fromJson.length) {
    return loadActiveUsersByIds(fromJson);
  }

  if (master.person_id) {
    return loadActiveUsersByIds([Number(master.person_id)]);
  }

  if (master.department_id) {
    const params = [Number(master.department_id)];
    let sql = `
      SELECT id, department_id, designation_id, name, status
      FROM ${M.USERS}
      WHERE department_id = ?
        AND LOWER(COALESCE(status, 'active')) = 'active'
    `;
    if (master.designation_id) {
      sql += ` AND designation_id = ?`;
      params.push(Number(master.designation_id));
    }
    sql += ` ORDER BY id ASC`;
    const rows = await dbQuery(sql, params);
    return rows || [];
  }

  return [];
}

async function loadActiveUsersByIds(ids) {
  const unique = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(", ");
  const rows = await dbQuery(
    `SELECT id, department_id, designation_id, name, status
     FROM ${M.USERS}
     WHERE id IN (${placeholders})
       AND LOWER(COALESCE(status, 'active')) = 'active'
     ORDER BY id ASC`,
    unique,
  );
  return rows || [];
}

/** True if userId is in the master's assignment scope (for Due / fill checks). */
export async function userMatchesClMasterScope(master, userId) {
  const uid = Number(userId);
  if (!uid || !master) return false;
  const people = await resolveClMasterAssignees(master);
  return people.some((p) => Number(p.id) === uid);
}

/**
 * Load one user row (dept/desig) for open-master matching helpers.
 */
export async function getUserOrgIds(userId) {
  const rows = await dbQuery(
    `SELECT id, department_id, designation_id, status FROM ${M.USERS} WHERE id = ? LIMIT 1`,
    [Number(userId)],
  );
  return rows?.[0] || null;
}
