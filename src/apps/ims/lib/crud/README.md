# IMS Generic CRUD

One factory: `createCrud(config, hooks)`.

## New module checklist

1. Table DDL + `initDB.js` + `dbTables.js`
2. Config file (`fields`, `listSelect`, `sortable`, `filterFields`)
3. `const crud = createCrud(config, hooks)` + Express routes
4. `portalModules.js` + frontend nav

## Config

```javascript
export const myConfig = {
  table: T.MY_TABLE,
  alias: "m",
  idField: "id",
  entity: "my_module",
  fields: {
    name: { type: "text", required: true, search: true },
    qty:  { type: "int", required: true, min: 1, filter: true },
    type: { type: "enum", values: ["A", "B"], required: true },
  },
  listSelect: ["m.id", "m.name", "m.qty", "m.type", "m.created_at"],
  sortable: ["id", "name", "created_at"],
  filterFields: ["name", "type", "from_date", "to_date"],
};
```

Field types: `text`, `int`, `number`, `bool`, `enum`.  
Flags: `required`, `filter`, `search`, `min`, `readonly`, `insert: false`, `update: false`.

## Hooks

| Hook | When |
|------|------|
| `enrichRows(rows)` | After list/get |
| `validate(data, { mode, existing })` | Before save — return error string |
| `beforeSave(data, { mode, req, existing })` | Patch payload before DB write |
| `beforeDelete(row, req)` | Return error string to block delete |

## Routes

```javascript
router.post("/list",   auth, accessControl("my_module", "view"),   crud.list);
router.post("/get",    auth, accessControl("my_module", "view"),   crud.get);
router.post("/create", auth, accessControl("my_module", "add"),    crud.create);
router.post("/update", auth, accessControl("my_module", "edit"),   crud.update);
router.post("/delete", auth, accessControl("my_module", "delete"), crud.remove);
```

## Bulk / internal insert

```javascript
const result = await crud.insertOne({ name: "x", qty: 1 }, req, { skipLog: true });
// { success: true, data } or { success: false, message }
```

## Security

- Table/column names come from config only (never from request)
- Filters and sort columns use explicit whitelists
- All values use `$1, $2, …` parameterized queries
