import dbQuery from "./db.js";
import bcrypt from "bcryptjs";
import config from "./config.js";

const MODULES = [
  { name: "users",                    label: "User Management",            sort_order: 1  },
  { name: "modules",                  label: "System Module",              sort_order: 2  },
  { name: "training_videos",          label: "Training Videos",            sort_order: 3  },
  { name: "product_master",           label: "Product Master",             sort_order: 4  },
  { name: "customer_master",          label: "Customer Master",            sort_order: 5  },
  { name: "customer_item_code",       label: "Customer Item Code",         sort_order: 6  },
  { name: "packing_standard",         label: "Packing Standard",           sort_order: 7  },
  { name: "location_master",          label: "Store Location Master",      sort_order: 8  },
  { name: "packing_entry",            label: "Packing Entry",              sort_order: 9  },
  { name: "boxes",                    label: "Boxes",                      sort_order: 10 },
  { name: "inventory_inwards",        label: "Store In",                   sort_order: 11 },
  { name: "forwarding_note_master",   label: "Forwarding Note",            sort_order: 12 },
  { name: "out_entry",                label: "Store Out",                  sort_order: 13 },
  { name: "change_override_customer", label: "Change / Override Customer", sort_order: 14 },
  { name: "stock_adjustment",         label: "Stock Adjustment",           sort_order: 15 },
  { name: "inventory_report",         label: "Inventory Report",           sort_order: 16 },
  { name: "activity_logs",            label: "Activity Logs",              sort_order: 17 },
  { name: "box_transaction_logs",     label: "Box Transaction Logs",       sort_order: 18 },
  { name: "sticker_download_logs",    label: "Sticker Download Logs",      sort_order: 19 },
];

const CATEGORIES = [
  { name: "OEM" },
  { name: "Market" },
];

const STICKER_TYPES = [
  { name: "box" },
];

// app settings — live values in DB; super admin edits via UI.
const APP_CONFIG_SEEDS = {
  inward_location_validation: "false",
  default_list_view_span_days: "7",
  box_qr_public_base_url: "https://jflindia.com/",
  box_no_uid_prefix: "2026",
  company_name: "H.P. FASTENERS PVT. LTD.",
  company_address: "PLOT NO. 314, SECTOR-24, FARIDABAD (HR)-121005",
  company_phone: "8505859996",
  company_email: "info@jflindia.com",
  company_gstin: "",
  company_state: "Haryana",
  company_pincode: "121005",
};

export async function seedRootUser() {
  // ─── 1. Root User ────────────────────────────────────────────────
  const [{ count }] = await dbQuery("SELECT COUNT(*) as count FROM users");

  if (parseInt(count) === 0) {
    if (!config.root.password) {
      throw new Error("ROOT_PASSWORD not defined in .env");
    }

    const hashedPassword = await bcrypt.hash(config.root.password, 10);

    await dbQuery(
      `INSERT INTO users (name, username, email, phone, password, type, status, auth_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        config.root.name,
        config.root.username,
        config.root.email,
        config.root.phone,
        hashedPassword,
        "super_admin",
        "active",
        "local",
      ],
    );
    console.log("Root User Created");
  } else {
    console.log("Root User already exists — skipping");
  }

  await dbQuery(`
    UPDATE users SET auth_source = 'local', usercode = NULL WHERE type = 'super_admin';
  `);

  // ─── 2. Modules ──────────────────────────────────────────────────
  for (const mod of MODULES) {
    const updated = await dbQuery(
      `UPDATE modules
       SET label = $2
       WHERE name = $1
       RETURNING id`,
      [mod.name, mod.label]
    );

    if (!updated?.length) {
      const [nextIdRow] = await dbQuery(`
        SELECT COALESCE(
          (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM modules WHERE id = 1)),
          (
            SELECT MIN(m.id) + 1
            FROM modules m
            WHERE NOT EXISTS (
              SELECT 1 FROM modules m2 WHERE m2.id = m.id + 1
            )
          ),
          1
        ) AS next_id
      `);

      await dbQuery(
        `INSERT INTO modules (id, name, label)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3)`,
        [Number(nextIdRow?.next_id || 1), mod.name, mod.label]
      );
    }
  }
  // Keep identity sequence aligned with real max id.
  // PostgreSQL may consume sequence values even on UPSERT conflicts.
  await dbQuery(`
    SELECT setval(
      pg_get_serial_sequence('modules', 'id'),
      COALESCE((SELECT MAX(id) FROM modules), 1),
      true
    )
  `);
  console.log("Modules Seeded");

  // ─── 3. Grant super admin all module permissions ─────────────────
  const [superAdmin] = await dbQuery(`SELECT id FROM users WHERE type = 'super_admin' LIMIT 1`);

  if (superAdmin) {
    const modules = await dbQuery(`SELECT id FROM modules`);

    for (const mod of modules) {
      await dbQuery(
        `INSERT INTO user_permissions 
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

  // ─── 4. Categories Seed ──────────────────────────────────────────
  for (const cat of CATEGORIES) {
    await dbQuery(
      `INSERT INTO category (name)
      VALUES ($1)
      ON CONFLICT DO NOTHING`,
      [cat.name]
    );
  }
  console.log("Categories Seeded");

  // ─── 5. Sticker Type Seed ────────────────────────────────────────
  for (const stickerType of STICKER_TYPES) {
    await dbQuery(
      `INSERT INTO sticker_type (name, approved)
       VALUES ($1, true)
       ON CONFLICT DO NOTHING`,
      [stickerType.name]
    );
  }
  console.log("Sticker Type Seeded");

  // ─── 6. App config (DB — not server .env) ─────────────────────────
  for (const [config_key, config_value] of Object.entries(APP_CONFIG_SEEDS)) {
    await dbQuery(
      `INSERT INTO app_config (config_key, config_value)
       VALUES ($1, $2)
       ON CONFLICT (config_key) DO NOTHING`,
      [config_key, String(config_value ?? "")]
    );
  }
  console.log("App Config Seeded");
}
