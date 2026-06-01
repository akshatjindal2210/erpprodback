import dbQuery from "../../../config/db.js";

/**
 * Synchronizes PostgreSQL sequences with the maximum ID in each table.
 * This prevents "duplicate key value violates unique constraint" errors
 * which occur when the sequence gets out of sync with manually inserted data.
 */
export async function syncTaskSequences() {
  const tables = [
    { table: 'task_tasks', id: 'task_id', seq: 'task_tasks_task_id_seq' },
    { table: 'task_assignments', id: 'assignment_id', seq: 'task_assignments_assignment_id_seq' },
    { table: 'task_chat', id: 'chat_id', seq: 'task_chat_chat_id_seq' },
    { table: 'task_log', id: 'activity_id', seq: 'task_log_activity_id_seq' },
    { table: 'task_categories', id: 'id', seq: 'task_categories_id_seq' },
    { table: 'task_recurring_tasks', id: 'recurring_id', seq: 'task_recurring_tasks_recurring_id_seq' },
    { table: 'task_recurring_task_assignments', id: 'assignment_id', seq: 'task_recurring_task_assignments_assignment_id_seq' },
    { table: 'task_recurring_task_chat', id: 'chat_id', seq: 'task_recurring_task_chat_chat_id_seq' },
    { table: 'task_holiday', id: 'id', seq: 'task_holiday_id_seq' },
    { table: 'task_users_logs', id: 'id', seq: 'task_users_logs_id_seq' },
    { table: 'task_self_notes', id: 'self_note_id', seq: 'task_self_notes_self_note_id_seq' }
  ];

  // console.log("🔄 Syncing task sequences...");
  
  for (const t of tables) {
    try {
      // Check if table exists first to avoid errors during initial setup
      const tableExists = await dbQuery(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = $1
        )`, [t.table]);

      if (!tableExists[0].exists) continue;

      const res = await dbQuery(`
        SELECT setval($1, COALESCE((SELECT MAX(${t.id}) FROM ${t.table}), 1), 
        EXISTS (SELECT 1 FROM ${t.table}))
      `, [t.seq]);
      
      // console.log(`✅ Synced ${t.seq}`);
    } catch (err) {
      // We don't want to break the whole initialization if one sequence fails
      console.warn(`⚠️ Failed to sync sequence ${t.seq}:`, err.message);
    }
  }
}
