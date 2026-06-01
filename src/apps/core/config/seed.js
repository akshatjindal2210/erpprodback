import dbQuery from "../../../config/db.js";
import { MST_TABLES as M } from "../../../config/dbTables.js";
import bcrypt from "bcryptjs";
import config from "../../../config/config.js";
import { SEED_MODULES } from "../../../config/portalModules.js";
import { upsertModuleRows } from "../../../config/seedModules.js";

const MODULES = SEED_MODULES;

export async function seedCoreRootUser() {
  const [{ count }] = await dbQuery(`SELECT COUNT(*) as count FROM ${M.USERS}`);

  if (parseInt(count) === 0) {
    if (!config.root.password) {
      throw new Error("ROOT_PASSWORD not defined in .env");
    }

    const hashedPassword = await bcrypt.hash(config.root.password, 10);

    await dbQuery(
      `INSERT INTO ${M.USERS} (name, username, email, phone, password, type, status, auth_source, approved)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        config.root.name,
        config.root.username,
        config.root.email,
        config.root.phone,
        hashedPassword,
        "super_admin",
        "active",
        "local",
        true
      ],
    );
    console.log("Root user created");
  } else {
    console.log("Root user already exists — skipping");
  }

  // Ensure super_admin has local auth
  await dbQuery(`
    UPDATE ${M.USERS} SET auth_source = 'local', usercode = NULL WHERE type = 'super_admin';
  `);

  await upsertModuleRows(MODULES);
  console.log("Modules Seeded");

  const [superAdmin] = await dbQuery(`SELECT id FROM ${M.USERS} WHERE type = 'super_admin' LIMIT 1`);

  if (superAdmin) {
    const modules = await dbQuery(`SELECT id FROM ${M.MODULES}`);

    for (const mod of modules) {
      await dbQuery(
        `INSERT INTO ${M.USER_PERMISSIONS} 
          (user_id, module_id, can_view, can_add, can_edit, can_delete, can_authorize, approved)
        VALUES ($1, $2, true, true, true, true, true, true)
        ON CONFLICT (user_id, module_id) DO UPDATE SET
          can_view      = true,
          can_add       = true,
          can_edit      = true,
          can_delete    = true,
          can_authorize = true,
          approved      = true`,
        [superAdmin.id, mod.id]
      );
    }
    console.log("Super Admin Permissions Seeded");
  }
}
