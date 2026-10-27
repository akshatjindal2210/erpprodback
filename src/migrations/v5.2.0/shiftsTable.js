import { createShiftsTable } from "../../apps/core/lib/config/tables/configuration/shifts.table.js";

export default async function shiftsTable() {
  await createShiftsTable();
}
