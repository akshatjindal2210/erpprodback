import { deleteLogById, findLogById, findLogs, updateLogById } from "../models/activityLog.model.js";
import { extractListParams, sanitizeFilters } from "../utils/queryHelper.js";
import { getCrudModuleConfig } from "../config/crudModules.js";

const LOG_CFG = getCrudModuleConfig("activity_logs");

export const getLogs = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } =
      extractListParams(req.body, {
        sortBy: "created_at",
        order: "DESC"
      });

    const result = await findLogs(
      {
        filters: sanitizeFilters(filters, LOG_CFG.filterFields),
        search,
        sort: { by: sortBy, order },
        page,
        limit,
        fields: LOG_CFG.listFields,
        permission: req.permission
      },
      req.user
    );

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getLogById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const data = await findLogById(id, req.user);
    if (!data) return res.status(404).json({ success: false, message: "Log not found" });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateLog = async (req, res) => {
  try {
    const { id, approved, details } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const data = await updateLogById(id, {
      ...(approved !== undefined && { approved }),
      ...(details !== undefined && { details }),
      updated_at: new Date(),
      updated_by: req.user?.id
    });
    if (!data) return res.status(404).json({ success: false, message: "Log not found" });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteLog = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const data = await deleteLogById(id, req.user?.id);
    if (!data) return res.status(404).json({ success: false, message: "Log not found" });

    res.json({ success: true, message: "Log deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};