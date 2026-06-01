import dbQuery from "../../../config/db.js";

const CATEGORIES = [
  { name: "OEM" },
  { name: "Market" },
];

const STICKER_TYPES = [
  { name: "box" },
];

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

export async function seedImsData() {
  for (const cat of CATEGORIES) {
    await dbQuery(
      `INSERT INTO ims_category (name)
      VALUES ($1)
      ON CONFLICT DO NOTHING`,
      [cat.name]
    );
  }
  console.log("✅ IMS Categories Seeded");

  for (const stickerType of STICKER_TYPES) {
    await dbQuery(
      `INSERT INTO ims_sticker_type (name, approved)
       VALUES ($1, true)
       ON CONFLICT DO NOTHING`,
      [stickerType.name]
    );
  }
  console.log("✅ IMS Sticker Type Seeded");

  for (const [config_key, config_value] of Object.entries(APP_CONFIG_SEEDS)) {
    await dbQuery(
      `INSERT INTO ims_app_config (config_key, config_value)
       VALUES ($1, $2)
       ON CONFLICT (config_key) DO NOTHING`,
      [config_key, String(config_value ?? "")]
    );
  }
  console.log("✅ IMS App Config Seeded");
}
