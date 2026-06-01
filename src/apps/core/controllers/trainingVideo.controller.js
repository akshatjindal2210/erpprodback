import { findTrainingVideos, findTrainingVideo, insertTrainingVideo, updateTrainingVideo, deleteTrainingVideo, approveTrainingVideoById } from "../models/trainingVideo.model.js";
import { findModule } from "../models/module.model.js";
import User from "../models/user.model.js";
import { getCrudModuleConfig } from "../config/crudModules.js";
import { extractListParams, sanitizeFilters } from "../utils/queryHelper.js";
import { sanitizeSearch } from "../utils/helper.js";

const TRAINING_CFG = getCrudModuleConfig("training_videos");

export const getTrainingVideos = async (req, res) => {
  try {
    const { page, limit, filters, search, sortBy, order } = extractListParams(req.body, {
      sortBy: "id",
      order: "ASC"
    });
    const { module_slug } = req.body;

    const finalFilters = sanitizeFilters(filters, TRAINING_CFG.filterFields);

    if (module_slug) {
      const moduleData = await findModule({ name: module_slug });

      if (!moduleData) {
        return res.status(404).json({ success: false, message: `Invalid module slug: '${module_slug}'. No such module found.` });
      }

      finalFilters.module_id = moduleData.id;
    }

    const result = await findTrainingVideos({
      filters: finalFilters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page: parseInt(page, 10),
      limit: parseInt(limit, 10)
    });

    res.json({ success: true, ...result });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getTrainingVideoById = async (req, res) => {
  try {
    const { id } = req.body;
    const video = await findTrainingVideo({ id });
    if (!video) return res.status(404).json({ success: false, message: "Video not found" });

    res.json({ success: true, data: video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createTrainingVideo = async (req, res) => {
  try {
    const { module_id, title, description, video_url, permission_type } = req.body;
    const created_by = req.user.id;

    const module = await findModule({ id: module_id });
    if (!module) return res.status(404).json({ success: false, message: "Module not found" });

    const user = await User.getById(created_by);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const autoApprove = req.user?.type === "super_admin" || req.permission?.can_authorize === true;
    const now = new Date();
    const video = await insertTrainingVideo({
      module_id,
      title,
      description,
      video_url,
      permission_type,
      created_by,
      approved: autoApprove,
      approved_by: autoApprove ? created_by : null,
      approved_at: autoApprove ? now : null,
    });

    res.json({ success: true, data: video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateTrainingVideoController = async (req, res) => {
  try {
    const { id, ...fields } = req.body;
    const video = await updateTrainingVideo(
      { ...fields, updated_by: req.user.id, updated_at: new Date() },
      { id }
    );
    if (!video) return res.status(404).json({ success: false, message: "Video not found" });
    
    res.json({ success: true, data: video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const approveTrainingVideoController = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID required" });

    const updated = await approveTrainingVideoById(id, req.user.id);
    if (!updated) {
      const existing = await findTrainingVideo({ id });
      if (!existing) return res.status(404).json({ success: false, message: "Video not found" });
      return res.status(400).json({ success: false, message: "Video is already approved" });
    }

    const data = await findTrainingVideo({ id: updated.id });
    res.json({ success: true, data, message: "Video approved" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteTrainingVideoController = async (req, res) => {
  try {
    const { id } = req.body;
    await deleteTrainingVideo({ id }, { deleted_by: req.user.id });
    
    res.json({ success: true, message: "Video deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getTrainingVideosViews = async (req, res) => {
  try {
    const { id, search, module_slug } = req.body || {};

    if (id) {
      const video = await findTrainingVideo({ id });
      if (!video || !video.approved) return res.json({ success: true, data: null });
      return res.json({ success: true, data: video });
    }

    const result = await findTrainingVideos({
      module_slug,
      user_id: req.user.id,
      user_type: req.user.type,
      search: sanitizeSearch(search),
      page: 1,
      limit: 5000,
      sort: { by: "id", order: "DESC" },
      is_views: true // Flag to indicate helper view logic
    });

    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};