export const CRUD_MODULES = {
  users: {
    idField: "id",
    listFields: ["id", "name", "username", "usercode", "email", "phone", "type", "status", "auth_source", "created_at"],
    filterFields: ["id", "name", "username", "usercode", "email", "phone", "type", "status", "auth_source", "from_date", "to_date"],
    searchFields: ["name", "username", "email", "usercode"]
  },
  user_permissions: {
    idField: "id",
    listFields: ["up.id", "up.user_id", "up.module_id", "up.can_view", "up.can_view_days", "up.can_add", "up.can_edit", "up.can_edit_days", "up.can_delete", "up.can_authorize", "m.name AS module_name", "m.label AS module_label"],
    filterFields: ["id", "user_id", "module_id", "can_view", "can_add", "can_edit", "can_delete", "can_authorize", "from_date", "to_date"]
  },
  modules: {
    idField: "id",
    listFields: ["id", "name", "label", "sort_order", "is_active", "created_at", "updated_at", "updated_by", "updated_by_name"],
    filterFields: ["id", "name", "label", "is_active", "from_date", "to_date"],
    searchFields: ["name", "label"]
  },
  training_videos: {
    idField: "id",
    listFields: ["id", "module_id", "title", "description", "video_url", "permission_type", "is_active", "created_at"],
    filterFields: ["id", "module_id", "permission_type", "is_active", "approved", "from_date", "to_date"]
  },
  location_master: {
    idField: "location_id",
    listFields: [
      "lm.location_id", "lm.rack_no", "lm.shelf_no", "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no", "lm.location_description", "lm.total_capacity",
      "lm.acc_code", "lm.item_dcode", "lm.approved", "lm.approved_by", "lm.approved_at", 
      "lm.created_at", "lm.updated_at",
      "lm.acc_code::text AS acc_name", "lm.item_dcode::text AS item_code", "NULL::text AS item_desc",
      "u_cr.name AS created_by_name", 
      "u_up.name AS updated_by_name", 
      "u_ap.name AS approved_by_name", 
      "u_dl.name AS deleted_by_name"
    ],
    filterFields: ["location_id", "rack_no", "shelf_no", "location_no", "acc_code", "item_dcode", "approved", "from_date", "to_date"],
    searchFields: ["rack_no", "shelf_no", "location_no", "acc_name", "item_code"]
  },
  packing_standard: {
    idField: "standard_id",
    listFields: [ 
      "ps.standard_id", "ps.item_dcode", "ps.qty", "ps.unit", "ps.type", "ps.sticker_type", "ps.acc_code",
      "ps.approved", "ps.approved_by", "ps.approved_at",
      "ps.created_by", "ps.created_at",
      "ps.updated_by", "ps.updated_at",
      "ps.deleted_by", "ps.deleted_at",
      "u_cr.name  AS created_by_name", "u_upd.name AS updated_by_name", "u_dl.name  AS deleted_by_name", "u_ap.name  AS approved_by_name",
      "ps.item_dcode::text AS item_code", "NULL::text AS item_desc", "ps.acc_code::text AS acc_name", "cat.name AS category_name", "st.name AS sticker_type_name"
    ],
    filterFields: ["standard_id", "item_dcode", "type", "sticker_type", "acc_code", "approved", "from_date", "to_date"],
    searchFields: ["item_code", "item_desc", "acc_name", "category_name", "sticker_type_name"]
  },
  inventory_inwards: {
    idField: "in_uid",
    listFields: [
      "i.in_uid", "i.packing_number", "i.remarks", 
      "i.approved", "i.approved_by", "i.approved_at",
      "i.created_by", "i.created_at",
      "i.updated_by", "i.updated_at",
      "i.deleted_by", "i.deleted_at",
      "u_cr.name  AS created_by_name", "u_upd.name AS updated_by_name", "u_dl.name  AS deleted_by_name", "u_ap.name  AS approved_by_name",
    ],
    filterFields: ["in_uid", "packing_number", "approved", "from_date", "to_date"],
    searchFields: ["i.packing_number", "i.remarks"] 
  },
  forwarding_note_master: {
    idField: "fuid",
    listFields: [
      "f.fuid", "f.acc_code", "f.po_number", "f.remarks", "f.transporter_name", "f.vehicle_number", "f.cartage", "f.total_items", "f.bill_no", "f.timestamp",
      "f.approved", "f.approved_by", "f.approved_at",
      "f.out_entry_locked", "f.out_entry_locked_by", "f.out_entry_locked_at",
      "f.bill_updated_by", "f.bill_updated_at",
      "f.created_by", "f.created_at",
      "f.updated_by", "f.updated_at",
      "f.deleted_by", "f.deleted_at",
      "u_cr.name AS created_by_name", "u_upd.name AS updated_by_name", "u_dl.name  AS deleted_by_name", "u_ap.name  AS approved_by_name", "u_lock.name AS out_entry_locked_by_name", "u_bill.name AS bill_updated_by_name",
      "f.acc_code::text AS acc_name",
    ],
    filterFields: ["fuid", "acc_code", "po_number", "approved", "out_entry_locked", "out_entry_available", "from_date", "to_date"],
    searchFields: ["f.po_number", "f.transporter_name", "f.vehicle_number", "f.bill_no", "f.acc_code"]
  },
  forwarding_note_item_wise: {
    idField: "id",
    listFields: [
      "fi.id", "fi.fuid", "fi.item_dcode", "fi.qty", 
      "fi.item_dcode::text AS item_code", "fi.item_dcode AS itemdcode", "NULL::text AS item_desc",
      "fnm.out_entry_locked", "fnm.out_entry_locked_by", "fnm.out_entry_locked_at", "u_lock.name AS out_entry_locked_by_name",
      "fnm.approved", "fnm.approved_by", "fnm.approved_at",
      "fnm.created_by", "fnm.created_at",
      "fnm.updated_by", "fnm.updated_at",
      "fnm.deleted_by", "fnm.deleted_at",
      "fnm.bill_no", "fnm.bill_updated_by", "fnm.bill_updated_at",
      "u_mcr.name AS created_by_name", "u_mupd.name AS updated_by_name", "u_mdl.name  AS deleted_by_name", "u_map.name  AS approved_by_name",
      "u_bill.name AS bill_updated_by_name",
    ],
    filterFields: ["id", "fuid", "item_dcode", "approved", "out_entry_locked", "from_date", "to_date"],
    searchFields: ["fi.item_dcode", "fi.qty"]
  },
  out_entry: {
    idField: "out_uid",
    listFields: [
      "o.out_uid", "o.fuid", "o.remarks", 
      "o.approved", "o.approved_by", "o.approved_at",
      "o.scan_complete", "o.boxes_required", "o.boxes_scanned",
      "o.created_by", "o.created_at",
      "o.updated_by", "o.updated_at",
      "u_cr.name  AS created_by_name", 
      "u_upd.name AS updated_by_name", 
      "u_ap.name  AS approved_by_name"
    ],
    filterFields: ["out_uid", "fuid", "approved", "scan_complete", "from_date", "to_date", "fromDate", "toDate"],
    searchFields: ["o.remarks", "u_cr.name"]
  },
  stock_adjustment: {
    idField: "adjustment_id",
    listFields: [
      "s.adjustment_id", "s.item_dcode", "s.item_dcode::text AS item_code", "s.qty", "s.unit", "s.remarks",
      "s.entry_type", "s.packing_number", "s.financial_year", "s.per_box_qty", "s.box_count_impact", "s.removed_box_ids",
      "s.approved", "s.approved_by", "s.approved_at",
      "s.created_by", "s.created_at",
      "s.updated_by", "s.updated_at",
      "u_cr.name AS created_by_name",
      "u_up.name AS updated_by_name",
      "u_ap.name AS approved_by_name"
    ],
    filterFields: ["adjustment_id", "item_dcode", "approved", "is_deleted", "from_date", "to_date", "fromDate", "toDate", "entry_type", "packing_number"],
    searchFields: ["s.remarks", "s.item_dcode", "s.packing_number", "s.financial_year", "u_cr.name"]
  },
  activity_logs: {
    idField: "id",
    listFields: ["al.id", "al.user_id", "al.user_type", "al.action", "al.entity", "al.entity_id", "al.details", "al.ip_address", "al.approved", "al.created_at", "u.name AS user_name"],
    filterFields: ["id", "user_id", "user_type", "action", "entity", "approved", "is_deleted", "from_date", "to_date", "fromDate", "toDate"]
  },
  box_transaction_logs: {
    idField: "id",
    listFields: ["tb.id", "tb.transaction_type", "tb.source_module", "tb.source_id", "tb.packing_number", "tb.user_id", "tb.details", "tb.created_at", "u.name AS user_name"],
    filterFields: ["id","transaction_type","source_module","source_id","packing_number","from_date","to_date","fromDate","toDate"],
    searchFields: ["tb.transaction_type", "tb.source_module", "tb.packing_number", "tb.details"],
  },
};

export const getCrudModuleConfig = (moduleKey) => CRUD_MODULES[moduleKey] ?? null;
