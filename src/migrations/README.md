# Migrations (one-shot)

**No DB tracking.** Files stay in repo; you turn the runner on/off yourself.

```
src/migrations/
  index.js
  README.md
  v3.4.34/
    README.md
    locationMaster.js
```

## How we use it

1. **Deploy with call ON** → migrate runs on start (idempotent / safe to re-run).
2. All envs OK → **comment out** `runVersionMigrations()` in `initDB.js` → redeploy.
3. Keep folders in git for later; or delete — no other code breaks. Need again? pull from git / uncomment call.

## Boot

```
initDB
  → init*DB()                 structure only
  → runVersionMigrations()    only if you leave this call active
  → syncSerialSequences()
```

## Turn OFF (after everyone migrated)

`backend/src/config/db/initDB.js`:

```js
// await runVersionMigrations();
```

## Add later

New folder `vX.Y.Z/myJob.js` + `export default async function () { ... }`  
Uncomment the call in `initDB` for that deploy, then comment again when done.

## Delete

```text
delete  src/migrations/v3.4.34/
```

No registry. App starts fine. Restore from git if needed.

## Structure vs migration

| | `*.table.js` | `migrations/v*/` |
|--|--------------|------------------|
| Role | Schema forever | One-shot / temporary |
| Control | Always on boot | You comment the call |
| Delete folder? | No | Yes, anytime |
