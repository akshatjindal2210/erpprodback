# Migrations (one-shot)

Temporary data fixes / one-time DB work. **No migration table** — you control when jobs run.

## Folder layout

```
src/migrations/
  index.js              ← runVersionMigrations(): auto-runs v<current version>/*.js on boot
  README.md
  v3.4.34/
    locationMaster.js   ← auto job of v3.4.34 (no longer runs — app is past that version)
  v4.1.5/
    shortageGrpname.mjs ← manual only (via initDB)
  v5.0.0/
    docFileBackfill.js  ← auto job of v5.0.0 (documents: old paths → uuid files, drops old path columns)
    README.md           ← removed columns list + deploy checklist
```

## Two ways to run

| Type | File | Runs when |
|------|------|-----------|
| **Auto** | `vX.Y.Z/job.js` with `export default` | `await runVersionMigrations()` in `initDB.js` **and** `X.Y.Z` = the `version` in `package.json` |
| **Manual** | `vX.Y.Z/job.mjs` (`.mjs` = never auto-run) | You uncomment its call in `initDB.js` (section 5) |

---

## Auto migration

Only the **current version** folder runs: `package.json` `"version": "5.0.0"` → `migrations/v5.0.0/*.js`.
Bumping the version (`npm version patch --no-git-tag-version`) automatically stops the older folders.

**Steps**

1. Add `v<current version>/myJob.js` → `export default async function () { ... }` (must be safe to re-run)
2. Keep `await runVersionMigrations();` **ON** in `initDB.js`
3. Deploy / restart — job runs on every boot of this version; log `✅ [migration] vX.Y.Z/myJob.js`
4. Done on all envs → delete the job (or bump the version)

**Turn off all auto jobs**

```js
// await runVersionMigrations();
```

---

## Manual backfill (e.g. v4.1.5 shortage grpname)

1. Code lives in `migrations/vX.Y.Z/job.mjs`
2. Export wired in `backfills/index.js` (e.g. `backfillShortageGrpname`)
3. In `initDB.js` section 5, uncomment its line
4. Restart backend once — check logs
5. Done → comment the line again

---

## Boot order (`initDB.js`)

```
1. app tables (init*DB)
2. global tables (createDocumentsTable)
3. runVersionMigrations()     auto *.js of the current version
4. syncSerialSequences()
5. manual backfills           only the lines you uncomment
```

---

## vs table schema (`*.table.js`)

|                         | `*.table.js`        | `migrations/v*/`                        |
|-------------------------|---------------------|-----------------------------------------|
| Purpose                 | Permanent schema    | One-time / temporary                    |
| On every boot           | Yes                 | Auto jobs: only for the current version |
| Safe to delete folder?  | No                  | Yes, after the job is done              |
