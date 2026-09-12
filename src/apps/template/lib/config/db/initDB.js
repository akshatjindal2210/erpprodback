import { createRecordTable } from "../tables/record/record.table.js";

export async function initTemplateDB() {
  await createRecordTable();
}
