# v4.1.5 — Shortage grpname backfill

## What happened

The **`grpname`** column was added to the Shortage module later. Older rows have a **blank** group name. New create/update flows already set it from IMS.

## Why

Master-wise and item-wise shortage reports (and group filtering) need `grpname` on legacy rows too — updating each row manually is not practical.

## What it does

- Finds active `ims_shortage` rows where `grpname` is empty
- Looks up the group from the IMS item master by `itemdcode`
- Updates only blank rows — existing values are not overwritten
- **Idempotent** — safe to re-run; no-op once everything is filled

## How to run

Uncomment in `initDB.js`:

```js
await backfillShortageGrpname();
```

Restart the backend. Expected log: `✅ [v4.1.5] Shortage grpname backfill: N row(s)`

## When done

1. Comment that line again
2. Delete this folder (`v4.1.5/`)
3. Optionally remove the `backfillShortageGrpname` export from `backfills/index.js`

**File:** `shortageGrpname.mjs` — not auto-run by migrations; only runs via the call above.
