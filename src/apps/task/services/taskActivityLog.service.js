/**
 * Task timeline — stored in mst_activity_logs (no task_log table).
 */
import dbQuery from "../shared/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";

const APP_TYPE = "task";
const MODULE = "task_timeline";
const ENTITY = "task";

export async function markTaskViewed(task_id, user_id, performed_by) {
  await addTaskActivityLog(task_id, user_id, performed_by, "task_viewed");
}

export async function addTaskActivityLog(
  task_id,
  user_id,
  performed_by,
  action,
  action_detail = null,
  assignment_id = null
) {
  const log_data = {
    assignment_id: assignment_id ?? null,
    action_detail: action_detail ?? null,
    performed_by_name: performed_by ?? null,
  };

  const description = action_detail
    ? `${action}: ${action_detail}`.slice(0, 500)
    : action;

  try {
    await dbQuery(
      `INSERT INTO ${M.ACTIVITY_LOGS}
        (user_id, app_type, module, action_type, description, log_data, entity, entity_id)
       VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)`,
      [
        user_id ?? null,
        APP_TYPE,
        MODULE,
        action,
        description,
        JSON.stringify(log_data),
        ENTITY,
        task_id,
      ]
    );
  } catch {
    // non-blocking
  }
}

export async function getTaskActivityLog(taskId, { limit = 2000, offset = 0, action_type = null } = {}) {
  let sql = `
    SELECT
      l.id AS activity_id,
      l.action_type AS action,
      l.created_at AS action_time,
      l.user_id,
      l.log_data,
      l.description,
      u.name AS user_name
    FROM ${M.ACTIVITY_LOGS} l
    LEFT JOIN ${M.USERS} u ON u.id = l.user_id
    WHERE l.entity = ? AND l.entity_id = ?
      AND l.app_type = ? AND l.module = ?
  `;
  const params = [ENTITY, taskId, APP_TYPE, MODULE];

  if (action_type) {
    sql += ` AND l.action_type = ?`;
    params.push(action_type);
  } else {
    sql += ` AND l.action_type <> 'task_viewed'`;
  }

  sql += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));

  const rows = await dbQuery(sql, params);

  return rows.map((row) => {
    const meta = typeof row.log_data === "object" ? row.log_data : {};
    const ts = row.action_time instanceof Date
      ? row.action_time.toISOString().slice(0, 19).replace("T", " ")
      : String(row.action_time ?? "");
    return {
      activity_id: row.activity_id,
      action: row.action,
      action_detail: meta.action_detail ?? null,
      action_time: ts,
      assignment_id: meta.assignment_id ?? null,
      performed_by: meta.performed_by_name || row.user_name || "System",
      user_id: row.user_id,
    };
  });
}

export async function getTaskActivityLogCount(taskId, action_type = null) {
  let sql = `
    SELECT COUNT(*)::int AS total
    FROM ${M.ACTIVITY_LOGS}
    WHERE entity = ? AND entity_id = ? AND app_type = ? AND module = ?
  `;
  const params = [ENTITY, taskId, APP_TYPE, MODULE];

  if (action_type) {
    sql += ` AND action_type = ?`;
    params.push(action_type);
  } else {
    sql += ` AND action_type <> 'task_viewed'`;
  }

  const result = await dbQuery(sql, params);
  return result[0]?.total ?? 0;
}

export function taskUnseenUpdatesSql(taskAlias = "t", userIdParam = "?") {
  return `EXISTS (
    SELECT 1 FROM ${M.ACTIVITY_LOGS} l
    WHERE l.entity = '${ENTITY}' AND l.entity_id = ${taskAlias}.task_id
      AND l.app_type = '${APP_TYPE}' AND l.module = '${MODULE}'
      AND l.action_type NOT IN ('task_created', 'task_viewed')
      AND l.created_at > COALESCE(
        (SELECT MAX(l2.created_at) FROM ${M.ACTIVITY_LOGS} l2
         WHERE l2.entity = '${ENTITY}' AND l2.entity_id = ${taskAlias}.task_id
           AND l2.app_type = '${APP_TYPE}' AND l2.module = '${MODULE}'
           AND l2.action_type = 'task_viewed' AND l2.user_id = ${userIdParam}),
        TIMESTAMP '1970-01-01'
      )
  )`;
}

/** SQL fragment: activity count on task list */
export function taskLogCountSubquery(taskAlias = "t") {
  return `(
    SELECT COUNT(*)::int FROM ${M.ACTIVITY_LOGS} l
    WHERE l.entity = '${ENTITY}' AND l.entity_id = ${taskAlias}.task_id
      AND l.app_type = '${APP_TYPE}' AND l.module = '${MODULE}'
  )`;
}
