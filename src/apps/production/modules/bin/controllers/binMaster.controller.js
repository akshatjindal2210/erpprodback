import { getCrudModuleConfig } from "../../../../core/lib/config/crud/crudModules.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { extractListParams, sanitizeFilters } from "../../../../core/lib/utils/query/queryHelper.js";
import { resolveViewsFields } from "../../../lib/config/views/helperViews.js";
import { sanitizeSearch } from "../../../../core/lib/utils/helper/helper.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";
import {
  createTrayBatch,
  previewTrayBatchCodes,
  deleteTrayBatch as deleteBinBatchRows,
  deleteTrayById as deleteBinById,
  deleteTraysByIds as deleteBinsByIds,
  findTray as findBin,
  findDistinctBinMaterials,
  findDistinctBinCategories,
  findTrayBatches as findBinBatches,
  findTrays as findBins,
  updateTrayApprovalById as updateBinApprovalById,
  updateTrayBatch as updateBinBatch,
  updateTrayBatchStatus as updateBinBatchStatus,
  updateTrayStatusById as updateBinStatusById,
  updateTrayStatusByIds as updateBinStatusByIds,
  updateTrayWeight as updateBinWeight,
  updateTrayWeightsBulk as updateBinWeightsBulk,
} from "../../../../ims/modules/tray/models/trayMaster.model.js";
import { isValidTrayCategory, normalizeTrayCategory } from "../../../../ims/modules/tray/config/trayCode.js";
import { normalizeBinType } from "../../../../ims/modules/tray/config/trayTypes.js";
import {
  BIN_MATERIALS,
  BIN_PRODUCT,
  normalizeBinMaterial,
  toBinAppTag,
} from "../config/binMaterials.js";
import { isValidTrayStatus as isValidBinStatus, normalizeTrayStatus as normalizeBinStatus } from "../../../../ims/modules/tray/config/trayStatuses.js";
import { resolveTrayQrPayload as resolveBinQrPayload } from "../../../../core/lib/utils/qr/publicQrUrl.js";

const CFG = getCrudModuleConfig("production_bin_master");

const log = (req, action, entity_id, details, record = null, existing = null) =>
  logActivity(req, {
    action,
    entity: "production_bin_master",
    entity_id,
    details,
    record,
    existing: existing ?? (action === "update" ? record : null),
  }).catch(() => {});

function parseBinIds(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((value) => parsePositiveIntId(value)).filter(Boolean))];
}

function parseBinRemark(body) {
  return String(body?.remark ?? "").trim();
}

function isBinSuperAdmin(req) {
  return String(req?.user?.type || req?.user?.role || "").toLowerCase().trim() === "super_admin";
}

function productionBinTrayType() {
  return normalizeBinType(BIN_PRODUCT.code);
}

async function resolveBinCategory(req, body, existing = null) {
  /** Code letter in PRD_A_1 — `ims_tray_master.letter`; API `class` / `letter`. */
  const raw = body?.class ?? body?.letter ?? body?.category ?? existing?.letter ?? existing?.class ?? null;
  if (raw == null || String(raw).trim() === "") {
    throw Object.assign(new Error("Letter is required (e.g. A, B in PRD_A_1)."), { statusCode: 400 });
  }
  const tag = normalizeTrayCategory(raw);
  if (!tag || !isValidTrayCategory(tag)) {
    throw Object.assign(new Error("Enter a valid letter (e.g. A, B)."), { statusCode: 400 });
  }
  if (!isBinSuperAdmin(req)) {
    const known = await findDistinctBinCategories();
    const prior = existing?.category ? normalizeTrayCategory(existing.category) : "";
    if (!known.includes(tag) && tag !== prior) {
      throw Object.assign(
        new Error("Select an existing letter or ask Super Admin to add a new one."),
        { statusCode: 403 },
      );
    }
  }
  return tag;
}

async function resolveBinMaterial(req, body, existing = null) {
  const raw =
    body?.b_type ??
    body?.kind ??
    body?.variant ??
    body?.subtype ??
    body?.material_type ??
    body?.material ??
    (existing?.b_type != null
      ? existing.b_type
      : existing?.kind != null
        ? existing.kind
        : existing?.variant != null
          ? existing.variant
          : existing?.subtype != null
            ? existing.subtype
            : existing?.material_type != null
              ? existing.material_type
              : existing?.material ?? null);

  if (raw == null || String(raw).trim() === "") {
    throw Object.assign(new Error("Category is required."), { statusCode: 400 });
  }

  const tag = toBinAppTag(raw);
  if (!tag || !/^[A-Z0-9_]{1,20}$/.test(tag)) {
    throw Object.assign(new Error("Enter a valid type (e.g. PLASTIC, IRON)."), { statusCode: 400 });
  }

  if (!isBinSuperAdmin(req)) {
    const known = await findDistinctBinMaterials();
    const priorRaw =
      existing?.b_type ??
      existing?.kind ??
      existing?.variant ??
      existing?.subtype ??
      existing?.material_type ??
      existing?.material;
    const prior = priorRaw ? normalizeBinMaterial(priorRaw) : "";
    if (!known.includes(tag) && tag !== prior) {
      throw Object.assign(
        new Error("Select an existing material type or ask Super Admin to add a new one."),
        { statusCode: 403 },
      );
    }
  }

  return normalizeBinMaterial(tag);
}

export const getBinTypes = async (_req, res) => {
  try {
    const known_materials = await findDistinctBinMaterials();
    const materials = [...BIN_MATERIALS];
    for (const code of known_materials) {
      const key = normalizeBinMaterial(code);
      if (key && !materials.some((row) => row.code === key)) {
        materials.push({ code: key, label: key });
      }
    }
    return res.json({
      success: true,
      data: {
        product: BIN_PRODUCT,
        materials,
        known_materials,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getBinCategoryTags = async (req, res) => {
  try {
    const tags = await findDistinctBinCategories({ search: req.body?.search });
    return res.json({
      success: true,
      data: tags.map((code) => ({ class: code, letter: code })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getBinMaterialTags = async (req, res) => {
  try {
    const tags = await findDistinctBinMaterials({ search: req.body?.search });
    return res.json({
      success: true,
      data: tags.map((code) => ({ b_type: code })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** @deprecated — use getBinMaterialTags */
export const getBinAppTypeTags = getBinMaterialTags;

export const previewBinBatch = async (req, res) => {
  try {
    const binType = productionBinTrayType();
    const quantity = Number(req.body?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || Math.trunc(quantity) !== quantity) {
      return res.status(400).json({ success: false, message: "Enter a whole number greater than 0." });
    }
    if (quantity > 500) {
      return res.status(400).json({ success: false, message: "Maximum 500 bins per batch." });
    }
    const letter = normalizeTrayCategory(req.body?.class ?? req.body?.letter ?? req.body?.category);
    if (!letter) {
      return res.status(400).json({ success: false, message: "Letter is required (e.g. A in PRD_A_1)." });
    }
    const preview = await previewTrayBatchCodes({ type: binType, quantity, letter, class: letter });
    return res.json({
      success: true,
      data: { ...preview, type: binType, product_type: binType },
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message });
  }
};

const BIN_VIEW_FIELDS = ["t.id", "t.code", "t.type", "t.serial_number", "t.batch_id", "t.weight"];

function formatBinViewRow(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    code: row.code ?? null,
    type: row.type ?? null,
    serial_number: row.serial_number ?? null,
    batch_id: row.batch_id ?? null,
    weight: row.weight ?? null,
  };
}

export const getBinsViews = async (req, res) => {
  try {
    const { id, code } = req.body;
    const lookupId = parsePositiveIntId(id);
    const lookupCode = code != null && String(code).trim() !== "" ? String(code).trim().toUpperCase() : null;
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, { sortBy: "serial_number", order: "ASC" });

    const viewFields =
      resolveViewsFields("bins", {
        permission_module: req.body.permission_module,
        permission_action: req.body.permission_action,
      }) || BIN_VIEW_FIELDS;

    if (lookupId || lookupCode) {
      const bin = await findBin(
        {
          ...(lookupId ? { id: lookupId } : {}),
          ...(lookupCode ? { code: lookupCode } : {}),
          status: "active",
          approved: true,
        },
        { fields: viewFields, typeScope: "bin" }
      );
      if (!bin) {
        return res.json({
          success: true,
          data: null,
          message: lookupCode || lookupId ? "Bin not found or not authorized." : undefined,
        });
      }
      return res.json({ success: true, data: formatBinViewRow(bin) });
    }

    const safeFilters = sanitizeFilters(filters, CFG.filterFields);
    const result = await findBins({
      filters: { ...safeFilters, status: "active", approved: true },
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page: page || 1,
      limit: limit || 5000,
      fields: viewFields,
      typeScope: "bin",
    });

    const rows = (result.data || []).map(formatBinViewRow);

    if (rows.length === 0 && !search) {
      const anyBins = await findBins({ filters: { status: "active" }, limit: 1, fields: ["t.id"], typeScope: "bin" });
      if (anyBins.total > 0) {
        return res.json({
          success: true,
          data: [],
          message: "No authorized bins found. Approve bins in Bin Master first.",
        });
      }
    }

    return res.json({ success: true, ...result, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getBins = async (req, res) => {
  try {
    const view = String(req.body?.view || "batch").trim().toLowerCase();
    const defaults = view === "bin" ? { sortBy: "serial_number", order: "ASC" } : { sortBy: "created_at", order: "DESC" };
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, defaults);
    const safeFilters = sanitizeFilters(filters, CFG.filterFields);

    if (view === "bin") {
      const result = await findBins({
        filters: safeFilters,
        search: sanitizeSearch(search),
        sort: { by: sortBy, order },
        page,
        limit,
        fields: CFG.listFields,
        permission: req.permission,
        typeScope: "bin",
      });
      return res.json({ success: true, ...result, data: result.data || [] });
    }

    const result = await findBinBatches({
      filters: safeFilters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      typeScope: "bin",
    });

    const data = (result.data || []).map((row) => ({
      ...row,
      bin_count: row.bin_count ?? row.tray_count ?? 0,
    }));
    return res.json({ success: true, ...result, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createBin = async (req, res) => {
  try {
    const letter = await resolveBinCategory(req, req.body);
    const material = await resolveBinMaterial(req, req.body);
    const binType = productionBinTrayType();
    const quantity = Number(req.body?.quantity);

    if (!Number.isFinite(quantity) || quantity <= 0 || Math.trunc(quantity) !== quantity) {
      return res.status(400).json({ success: false, message: "Enter a whole number greater than 0." });
    }

    const canAuthorize = Boolean(req?.permission?.can_authorize) || req?.user?.type === "super_admin";
    const remark = String(req.body?.remark ?? "").trim() || null;
    const created = await createTrayBatch({
      type: binType,
      letter,
      class: letter,
      b_type: material,
      quantity,
      created_by: auditUserName(req),
      approved: canAuthorize && normalizeApprovedInput(req.body?.approved) === true,
      remark,
    });

    const weightRows = Array.isArray(req.body?.weights) ? req.body.weights : [];
    if (weightRows.length) {
      const byCode = new Map(
        weightRows
          .map((row) => {
            const code = String(row?.code || "").trim().toUpperCase();
            const weight = row?.weight;
            if (!code || weight === "" || weight == null) return null;
            const n = Number(weight);
            return Number.isFinite(n) && n >= 0 ? [code, n] : null;
          })
          .filter(Boolean),
      );
      const updates = (created.trays || [])
        .map((tray) => {
          const w = byCode.get(String(tray.code || "").trim().toUpperCase());
          return w != null ? { id: tray.id, weight: w } : null;
        })
        .filter(Boolean);
      if (updates.length) {
        await updateBinWeightsBulk(updates, auditUserName(req));
      }
    }

    await log(req, "create", created.batch.batch_id, {
      type: binType,
      material,
      quantity: created.batch.quantity,
      batch_id: created.batch.batch_id,
      start_code: created.batch.start_code,
      end_code: created.batch.end_code,
    });

    return res.status(201).json({
      success: true,
      data: created,
      message: `Created ${created.batch.quantity} bin(s) in batch ${created.batch.start_code} to ${created.batch.end_code}`,
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: "Bin code conflict detected. Please retry." });
    }
    const status = err?.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message });
  }
};

export const updateBin = async (req, res) => {
  try {
    const batch_id = String(req.body?.batch_id || "").trim();
    const id = parsePositiveIntId(req.body?.id);

    if (Array.isArray(req.body?.weights) && req.body.weights.length) {
      const result = await updateBinWeightsBulk(req.body.weights, auditUserName(req));
      await log(req, "update", result.ids.join(","), { weights: true, updated_count: result.updated });
      return res.json({
        success: true,
        data: result,
        message: `Updated weight for ${result.updated} bin(s).`,
      });
    }

    if (id && req.body?.weight !== undefined) {
      const updated = await updateBinWeight(id, req.body.weight, auditUserName(req));
      if (!updated) return res.status(404).json({ success: false, message: "Not found" });
      await log(req, "update", id, { weight: updated.weight, code: updated.code });
      return res.json({ success: true, data: updated, message: "Bin weight saved." });
    }
    const hasQuantity = req.body?.quantity !== undefined && req.body?.quantity !== null && String(req.body.quantity).trim() !== "";
    const normalizedApproved = req.body?.approved !== undefined ? normalizeApprovedInput(req.body?.approved) : undefined;
    const hasStatus = req.body?.status !== undefined && req.body?.status !== null && String(req.body.status).trim() !== "";

    if (hasStatus) {
      const nextStatus = normalizeBinStatus(req.body.status);
      if (!isValidBinStatus(nextStatus)) {
        return res.status(400).json({ success: false, message: "Invalid bin status" });
      }
      const remark = parseBinRemark(req.body);
      const binIds = parseBinIds(req.body?.ids);
      if (binIds.length) {
        const result = await updateBinStatusByIds(binIds, nextStatus, auditUserName(req), remark || null);
        if (!result.updated) {
          return res.status(400).json({ success: false, message: "No bins matched this status change." });
        }
        await log(req, "update", binIds.join(","), { ids: binIds, status: nextStatus, remark, updated_count: result.updated });
        return res.json({
          success: true,
          data: result,
          message: `Updated ${result.updated} bin(s) to ${nextStatus}`,
        });
      }

      if (batch_id) {
        const result = await updateBinBatchStatus(batch_id, nextStatus, auditUserName(req), remark || null);
        if (!result.updated) {
          return res.status(400).json({ success: false, message: "No bins matched this status change." });
        }
        await log(req, "update", batch_id, { batch: true, status: nextStatus, remark, updated_count: result.updated });
        return res.json({
          success: true,
          data: result,
          message: `Updated ${result.updated} bin(s) to ${nextStatus}`,
        });
      }

      if (!id) return res.status(400).json({ success: false, message: "Select a bin or batch." });

      const existing = await findBin({ id }, { typeScope: "bin" });
      if (!existing) return res.status(404).json({ success: false, message: "Not found" });
      if (normalizeBinStatus(existing.status) === nextStatus) {
        return res.status(400).json({ success: false, message: "Bin is already in this status." });
      }

      const updated = await updateBinStatusById(id, nextStatus, auditUserName(req), remark || null);
      if (!updated) return res.status(400).json({ success: false, message: "Failed to update bin status" });

      await log(req, "update", id, { status: nextStatus, remark, code: existing.code, batch_id: existing.batch_id }, existing);
      return res.json({
        success: true,
        data: updated,
        message: `Bin marked as ${nextStatus}`,
      });
    }

    if (batch_id) {
      const hasMaterial =
        req.body?.b_type !== undefined ||
        req.body?.type !== undefined ||
        req.body?.class !== undefined ||
        req.body?.kind !== undefined ||
        req.body?.variant !== undefined ||
        req.body?.subtype !== undefined ||
        req.body?.material_type !== undefined ||
        req.body?.material !== undefined;
      const hasRemark = Object.prototype.hasOwnProperty.call(req.body || {}, "remark");
      const remark = hasRemark ? String(req.body.remark ?? "").trim() : undefined;

      let nextMaterial;
      if (hasMaterial) {
        const priorBatch = await findBinBatches({
          filters: { batch_id },
          limit: 1,
          page: 1,
          typeScope: "bin",
        });
        const priorRow = priorBatch?.data?.[0];
        nextMaterial = await resolveBinMaterial(req, req.body, priorRow ? { b_type: priorRow.b_type, type: priorRow.b_type, class: priorRow.class, kind: priorRow.kind, variant: priorRow.variant, subtype: priorRow.subtype, material_type: priorRow.material_type, material: priorRow.material } : null);
      }

      if (!hasQuantity && normalizedApproved === undefined && !hasMaterial && !hasRemark) {
        return res.status(400).json({ success: false, message: "type, quantity, remark or approved is required for batch update" });
      }

      let quantity;
      if (hasQuantity) {
        quantity = Number(req.body.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0 || Math.trunc(quantity) !== quantity) {
          return res.status(400).json({ success: false, message: "Enter a whole number greater than 0." });
        }
      }

      const result = await updateBinBatch({
        batch_id,
        b_type: hasMaterial ? nextMaterial : undefined,
        quantity: hasQuantity ? quantity : undefined,
        approved: normalizedApproved,
        actor: auditUserName(req),
        remark,
      });

      if (!result.changed) {
        return res.status(400).json({ success: false, message: "No changes to update." });
      }

      await log(req, "update", result.batch_id, {
        batch: true,
        quantity: result.quantity,
        approved: normalizedApproved,
        previous_batch_id: batch_id !== result.batch_id ? batch_id : undefined,
      });

      return res.json({
        success: true,
        data: result,
        message: "Batch updated successfully",
      });
    }

    if (normalizedApproved === undefined) {
      return res.status(400).json({ success: false, message: "Approval is required." });
    }

    if (!id) return res.status(400).json({ success: false, message: "Select a bin or batch." });

    const existing = await findBin({ id }, { typeScope: "bin" });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (existing.approved === normalizedApproved) {
      return res.status(400).json({ success: false, message: "Approval status is already set." });
    }

    const updated = await updateBinApprovalById(id, normalizedApproved, auditUserName(req));
    if (!updated) return res.status(400).json({ success: false, message: "Failed to update bin" });

    await log(req, "update", id, { approved: normalizedApproved }, existing);

    return res.json({
      success: true,
      data: updated,
      message: normalizedApproved ? "Bin approved successfully" : "Bin moved to pending",
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.startsWith("Cannot ")) {
      return res.status(400).json({ success: false, message: msg });
    }
    if (err?.code === "23505") {
      return res.status(409).json({ success: false, message: "Bin code conflict detected. Please retry." });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteBin = async (req, res) => {
  try {
    const binIds = parseBinIds(req.body?.ids);
    const batch_id = String(req.body?.batch_id || "").trim();

    if (binIds.length) {
      const result = await deleteBinsByIds(binIds, auditUserName(req));
      if (!result.updated) {
        return res.status(400).json({ success: false, message: "No bins to delete." });
      }
      await log(req, "delete", binIds.join(","), { ids: binIds, deleted_count: result.updated });
      return res.json({
        success: true,
        data: result,
        message: result.updated === 1 ? "Bin deleted successfully" : `Deleted ${result.updated} bin(s)`,
      });
    }

    if (batch_id) {
      const result = await deleteBinBatchRows(batch_id, auditUserName(req));
      if (!result.updated) {
        return res.status(400).json({ success: false, message: "No active bins to delete in this batch." });
      }
      await log(req, "delete", batch_id, { batch: true, deleted_count: result.updated });
      return res.json({
        success: true,
        data: result,
        message: `Deleted ${result.updated} bin(s) in batch ${batch_id}`,
      });
    }

    const id = parsePositiveIntId(req.body?.id);
    if (!id) return res.status(400).json({ success: false, message: "Select a bin or batch." });

    const existing = await findBin({ id }, { typeScope: "bin" });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });

    const deleted = await deleteBinById(id, auditUserName(req));
    if (!deleted) return res.status(400).json({ success: false, message: "Bin already deleted" });

    await log(req, "delete", id, { code: existing.code, type: existing.type, batch_id: existing.batch_id }, existing);

    return res.json({ success: true, message: "Bin deleted successfully" });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.startsWith("Cannot delete")) {
      return res.status(400).json({ success: false, message: msg });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** Batch print payloads — `bin_code` + primary `id` in public URL (same pattern as box stickers). */
export async function resolveBinQrPayloads(req, res) {
  try {
    const binsIn = Array.isArray(req.body?.bins) ? req.body.bins : [];
    const codesIn = Array.isArray(req.body?.codes) ? req.body.codes : [];
    const rows = [];

    for (const t of binsIn) {
      const code = String(t?.code ?? t?.bin_code ?? "").trim().toUpperCase();
      const idNum = Number(t?.id ?? t?.bin_id);
      const id = Number.isFinite(idNum) && idNum > 0 ? idNum : null;
      if (code || id) rows.push({ code: code || null, id });
    }

    if (!rows.length && codesIn.length) {
      const codes = [...new Set(codesIn.map((v) => String(v ?? "").trim().toUpperCase()).filter(Boolean))];
      for (const code of codes) {
        const bin = await findBin({ code }, { fields: ["t.id", "t.code"], typeScope: "bin" });
        rows.push({ code: bin?.code ? String(bin.code).trim().toUpperCase() : code, id: bin?.id ?? null });
      }
    }

    if (!rows.length) {
      return res.status(400).json({ success: false, message: "At least one bin (id + code) is required." });
    }

    const entries = await Promise.all(
      rows.map(async (row) => {
        const key = row.code || String(row.id);
        const payload = await resolveBinQrPayload({ code: row.code || "", id: row.id });
        return [key, payload];
      })
    );
    return res.json({ success: true, data: { payloads: Object.fromEntries(entries) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
