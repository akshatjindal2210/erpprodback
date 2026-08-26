# v3.4.34 — Location master

**File:** `locationMaster.js`  
No DB track — runs whenever `runVersionMigrations()` is called from `initDB`.  
After all envs OK: comment that call (or delete this folder). Need again → git / uncomment.

Shared table: `ims_location_master` · split by `type` = `ims` | `rmstore`

---

## Shared columns (structure + migration)

| Column | Change | Notes |
|--------|--------|-------|
| `type` | patch / normalize | `ims` \| `rmstore` (`Y`/`IMS` → ims, `R`/`RM` → rmstore) |
| `acc_codes` | new `INTEGER[]` | multi customers; backfill from `acc_code` then drop single |
| `item_dcodes` | new `INTEGER[]` | multi items; backfill from `item_dcode` then drop single |
| `rule` | new / rename | `include` \| `exclude`; draft `restriction_mode` → `rule` |
| `acc_code` | **dropped** | after copy → `acc_codes` |
| `item_dcode` | **dropped** | after copy → `item_dcodes` |

**Indexes:** unique `(rack, shelf, type)`, unique `(location_no, type)`, GIN on arrays.

Structure file: `apps/ims/lib/config/tables/location/location_master.table.js`

---

## IMS (`type = ims`)

### Columns used

| Column | Use |
|--------|-----|
| `acc_codes[]` | multi customer |
| `item_dcodes[]` | multi item |
| `rule` | `include` / `exclude` (UI only when ≥1 item) |
| `total_capacity` | box capacity (when config ON) |
| `rack_no` / `shelf_no` / `location_no` | identity |

### What changed

- Location Master: multi customer + multi item
- Rule dropdown when item selected; customer-only → always `include`
- Inward validation (`inward_location_validation`):
  - include / exclude on customer + item lists
  - capacity = **boxes in hand** ≤ `total_capacity` (skip if null/0)
- Server always forces `type = ims`

### UI / API

- `/ims/` → Location Master · Inventory Inward
- Form: `LocationModal.js` · validation: `ims/.../inwardLocationValidation.js`

---

## RM Store (`type = rmstore`)

### Columns used

| Column | Use |
|--------|-----|
| `item_dcodes[]` | multi RM items (was single `item_dcode`) |
| `acc_codes[]` | optional / usually empty |
| `rule` | stored default `include` (RM inward does not use include/exclude) |
| `total_capacity` | coil capacity (when config ON) |
| `shelf_no` | DB name; API/UI alias **`row_no`** |
| `rack_no` / `location_no` | identity |

### What changed

- Legacy tables → shared master, then dropped:
  - `coil_location`
  - `rmstore_master_location`
- Coils remapped: `rmstore_coil_table.location_id` → `ims_location_master`
- FK on coil → shared master (`NOT VALID`)
- Store Location: multi `item_dcodes`
- Inward validation (`inward_location_validation`):
  - capacity = **coils** (active/rejected) ≤ `total_capacity` (skip if null/0)
- Server always forces `type = rmstore`

### UI / API

- `/rmstore/` → Store Location · Store In
- Form: `store-location/LocationModal.js`
- Validation: `rmstore/.../inwardLocationValidation.js`

---

## Migration steps (this file)

1. Rename `restriction_mode` → `rule`; normalize `rule` + `type`
2. Singles → arrays → drop `acc_code` / `item_dcode`
3. If legacy RM location tables exist → insert as `rmstore`, remap coils, DROP legacy
4. Else → noop `DROP IF EXISTS`

Idempotent — safe while call is still ON. Fail-soft (legacy kept on error).
