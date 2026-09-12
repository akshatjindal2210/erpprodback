# Migrations (one-shot)

Temporary data fixes / one-time DB work. **No migration table** — you control when jobs run.

## Folder layout

```
src/migrations/
  index.js              ← auto-runs v*/\*.js on boot
  README.md
  v3.4.34/
    README.md
    locationMaster.js   ← auto on boot (via runVersionMigrations)
  v4.1.5/
    README.md
    shortageGrpname.mjs ← manual only (via initDB)
```

## Two ways to run

| Type | File | Runs when |
|------|------|-----------|
| **Auto** | `vX.Y.Z/job.js` with `export default` | `await runVersionMigrations()` in `initDB.js` |
| **Manual** | `vX.Y.Z/job.mjs` (`.mjs` = not auto-scanned) | You uncomment a call in `initDB.js` |

---

## Auto migration (e.g. v3.4.34)

**Steps**

1. Add `vX.Y.Z/myJob.js` → `export default async function () { ... }`
2. Keep `await runVersionMigrations();` **ON** in `initDB.js`
3. Deploy / restart — job runs (idempotent)
4. All envs done → comment out `runVersionMigrations()` → redeploy
5. Optional: delete the version folder

**Turn off**

```js
// await runVersionMigrations();
```

---

## Manual backfill (e.g. v4.1.5 shortage grpname)

**Steps**

1. Code lives in `migrations/v4.1.5/shortageGrpname.mjs`
2. Export wired in `backfills/index.js` as `backfillShortageGrpname`
3. In `initDB.js`, uncomment:

   ```js
   await backfillShortageGrpname();
   ```

4. Restart backend — check logs
5. Done → comment line again → delete `v4.1.5/` folder

See `v4.1.5/README.md` for details.

---

## Boot order (`initDB.js`)

```
tables (init*DB)
  → runVersionMigrations()     auto *.js only
  → syncSerialSequences()
  → backfillShortageGrpname()  only if uncommented
  → runStartupBackfills()      only if uncommented
```

---

## Delete a version folder

```text
delete  src/migrations/v3.4.34/
```

No registry. App starts fine. Restore from git if needed.

---

## vs table schema (`*.table.js`)

|                         | `*.table.js`        | `migrations/v*/`                        |
|-------------------------|---------------------|-----------------------------------------|
| Purpose                 | Permanent schema    | One-time / temporary                    |
| On every boot           | Yes                 | Only while you enable the call          |
| Safe to delete folder?  | No                  | Yes, after job is done                  |
