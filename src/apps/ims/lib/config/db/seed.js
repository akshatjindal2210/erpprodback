import dbQuery from "../../../../../config/db/db.js";
import { CORE_APP_CONFIG_SEEDS } from "../../../../core/configuration/app.config.js";
import { IMS_APP_CONFIG_SEEDS } from "../app.config.js";
import { RMSTORE_APP_CONFIG_SEEDS } from "../../../../rmstore/lib/config/app.config.js";

const CATEGORIES = [
  { name: "OEM" },
  { name: "Market" },
];

const STICKER_TYPES = [
  { name: "box" },
];

const APP_CONFIG_SEEDS = {
  ...CORE_APP_CONFIG_SEEDS,
  ...IMS_APP_CONFIG_SEEDS,
  ...RMSTORE_APP_CONFIG_SEEDS,
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

  for (const stickerType of STICKER_TYPES) {
    await dbQuery(
      `INSERT INTO ims_sticker_type (name, approved)
       VALUES ($1, true)
       ON CONFLICT DO NOTHING`,
      [stickerType.name]
    );
  }

  for (const [config_key, config_value] of Object.entries(APP_CONFIG_SEEDS)) {
    await dbQuery(
      `INSERT INTO ims_app_config (config_key, config_value)
       VALUES ($1, $2)
       ON CONFLICT (config_key) DO NOTHING`,
      [config_key, String(config_value ?? "")]
    );
  }
}
