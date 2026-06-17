import ClTask from "../models/clTask.model.js";
import { canSubmitPreviousTask, getISTDateString, getTaskDateCategory } from "../helpers/clTaskTime.helper.js";
import {
  parseFormSchema,
  parseFormResponses,
  validateFormEntries,
  mergeEntryUploadedFiles,
} from "../helpers/clTaskForm.helper.js";
import {
  buildRecurrencePayload,
  validateClRecurrence,
  computeClNextOccurrence,
} from "../helpers/clTaskRecurrence.helper.js";

const parseNumber = (value) => {
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
};

export async function getClTasks(req, res) {
  try {
    const {
      search = "",
      page = 1,
      limit = 10,
      sortBy = "instance_id",
      order = "DESC",
      department_id,
      designation_id,
      person_id,
    } = req.query;

    const filterParams = {
      search,
      page: parseNumber(page) || 1,
      limit: parseNumber(limit) || 10,
      sortBy,
      order: order.toUpperCase() === "ASC" ? "ASC" : "DESC",
      department_id: parseNumber(department_id),
      designation_id: parseNumber(designation_id),
      person_id: parseNumber(person_id),
    };

    const [items, total, stats] = await Promise.all([
      ClTask.getInstances(filterParams),
      ClTask.countInstances(filterParams),
      ClTask.getStats(filterParams),
    ]);

    res.json({
      success: true,
      message: "CL tasks fetched successfully",
      data: {
        page: filterParams.page,
        limit: filterParams.limit,
        total,
        totalPages: Math.ceil(total / filterParams.limit),
        data: items ?? [],
        stats: stats ?? { total: 0, pending: 0, completed: 0, today: 0 },
      },
    });
  } catch (err) {
    console.error("getClTasks:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch CL tasks" });
  }
}

export async function getMyClTasks(req, res) {
  try {
    const {
      tab = "today",
      panel,
      page = 1,
      limit = 20,
      sortBy = "scheduled_date",
      order = "ASC",
      search = "",
    } = req.query;

    const validTabs = ["today", "previous", "future"];
    const validPanels = ["due", "open"];
    const finalPanel = validPanels.includes(panel) ? panel : undefined;
    const finalTab = finalPanel ? undefined : (validTabs.includes(tab) ? tab : "today");

    const filterParams = {
      userId: req.user.id,
      tab: finalTab,
      panel: finalPanel,
      search,
      page: parseNumber(page) || 1,
      limit: parseNumber(limit) || 20,
      sortBy,
      order: order.toUpperCase() === "DESC" ? "DESC" : "ASC",
    };

    const [items, total, stats] = await Promise.all([
      ClTask.getInstances(filterParams),
      ClTask.countInstances(filterParams),
      ClTask.getMyTabStats(req.user.id),
    ]);

    res.json({
      success: true,
      message: "My CL tasks fetched successfully",
      data: {
        page: filterParams.page,
        limit: filterParams.limit,
        total,
        totalPages: Math.ceil(total / filterParams.limit),
        data: items ?? [],
        stats,
        can_submit_previous: canSubmitPreviousTask(),
        ist_hour: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "numeric", hour12: true }),
      },
    });
  } catch (err) {
    console.error("getMyClTasks:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch my CL tasks" });
  }
}

export async function getVerificationClTasks(req, res) {
  try {
    const {
      page = 1,
      limit = 50,
      search = "",
      sortBy = "submitted_at",
      order = "DESC",
    } = req.query;

    const filterParams = {
      verification_user_id: req.user.id,
      status: "awaiting_verification",
      search,
      page: parseNumber(page) || 1,
      limit: parseNumber(limit) || 50,
      sortBy,
      order: order.toUpperCase() === "DESC" ? "DESC" : "ASC",
    };

    const [items, total] = await Promise.all([
      ClTask.getInstances(filterParams),
      ClTask.countInstances(filterParams),
    ]);

    res.json({
      success: true,
      message: "Verification CL tasks fetched successfully",
      data: {
        page: filterParams.page,
        limit: filterParams.limit,
        total,
        totalPages: Math.ceil(total / filterParams.limit),
        data: items ?? [],
      },
    });
  } catch (err) {
    console.error("getVerificationClTasks:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch verification tasks" });
  }
}

export async function getClTaskById(req, res) {
  try {
    const task = await ClTask.getInstanceById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }
    res.json({ success: true, message: "CL task fetched successfully", data: task });
  } catch (err) {
    console.error("getClTaskById:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to fetch CL task" });
  }
}

export async function createClTask(req, res) {
  try {
    const {
      title,
      description,
      sop_description,
      task_type,
      recurrence_type,
      wastage,
      verification_user_id,
      department_id,
      designation_id,
      person_id,
      end_date_time,
      form_schema,
      verification_required,
    } = req.body;

    const parsedSchema = parseFormSchema(form_schema);

    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: "Title is required" });
    }
    if (!task_type || !["open", "frequently"].includes(task_type)) {
      return res.status(400).json({ success: false, message: "Task type must be open or frequently" });
    }
    if (task_type === "frequently") {
      if (!recurrence_type) {
        return res.status(400).json({ success: false, message: "Recurrence type is required for frequently tasks" });
      }
      if (!["daily", "weekly", "monthly", "yearly"].includes(recurrence_type)) {
        return res.status(400).json({ success: false, message: "Recurrence type must be daily, weekly, monthly or yearly" });
      }
    }

    const recurrencePayload = task_type === "frequently" ? buildRecurrencePayload(req.body) : {
      recurrence_weekdays: [],
      recurrence_month_dates: [],
      recurrence_year_dates: [],
    };

    if (task_type === "frequently") {
      const recurErr = validateClRecurrence({ recurrence_type, ...recurrencePayload });
      if (recurErr) {
        return res.status(400).json({ success: false, message: recurErr });
      }
    }

    if (!end_date_time) {
      return res.status(400).json({ success: false, message: "End date & time is required" });
    }

    const wastageNum = Number(wastage);
    if (!wastageNum || wastageNum < 1 || wastageNum > 10) {
      return res.status(400).json({ success: false, message: "Wattage must be between 1 and 10" });
    }

    const needsVerification = verification_required !== false && verification_required !== "false";
    if (needsVerification && !verification_user_id) {
      return res.status(400).json({ success: false, message: "Verification person is required" });
    }

    for (const field of parsedSchema) {
      if (!field.label?.trim()) {
        return res.status(400).json({ success: false, message: "All custom form fields must have a label" });
      }
    }

    const today = getISTDateString();
    const nextOccurrence = task_type === "frequently" ? today : null;

    const masterData = {
      title: title.trim(),
      description: description || null,
      sop_description: sop_description || null,
      task_type,
      recurrence_type: task_type === "frequently" ? recurrence_type : null,
      ...recurrencePayload,
      wastage: wastageNum,
      verification_user_id: verification_user_id || null,
      department_id: department_id || null,
      designation_id: designation_id || null,
      person_id: person_id || null,
      end_date_time,
      next_occurrence: nextOccurrence,
      created_by: req.user.id,
      form_schema: parsedSchema,
      verification_required: needsVerification,
      scoring_enabled: needsVerification,
    };

    const clTaskId = await ClTask.createMaster(masterData);

    const instanceData = {
      cl_task_id: clTaskId,
      ...masterData,
      scheduled_date: today,
      status: "pending",
    };
    delete instanceData.created_by;
    delete instanceData.next_occurrence;

    const instanceId = await ClTask.createInstance(instanceData);

    if (task_type === "frequently") {
      const nextDate = computeClNextOccurrence(recurrence_type, recurrencePayload);
      await ClTask.updateNextOccurrence(clTaskId, nextDate);
    }

    res.status(201).json({
      success: true,
      message: "CL task created successfully",
      data: { cl_task_id: clTaskId, instance_id: instanceId },
    });
  } catch (err) {
    console.error("createClTask:", err.stack || err);
    res.status(500).json({ success: false, message: err.message || "Failed to create CL task" });
  }
}

export async function submitClTask(req, res) {
  try {
    const { id } = req.params;
    const person_remark = req.body.person_remark;
    const userId = req.user.id;

    const task = await ClTask.getInstanceById(id);
    if (!task) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }
    if (Number(task.person_id) !== Number(userId)) {
      return res.status(403).json({ success: false, message: "You are not assigned to this task" });
    }
    if (task.status !== "pending") {
      return res.status(400).json({ success: false, message: "Task is not pending submission" });
    }

    const category = getTaskDateCategory(task.scheduled_date);

    if (category === "future") {
      return res.status(400).json({ success: false, message: "Future tasks cannot be submitted yet" });
    }
    if (category === "previous" && !canSubmitPreviousTask()) {
      return res.status(400).json({
        success: false,
        message: "Previous tasks can only be completed before 11:00 AM",
      });
    }

    const schema = parseFormSchema(task.form_schema);
    const parsed = parseFormResponses(req.body.form_responses);
    let entries = Array.isArray(parsed.entries) ? parsed.entries : [];

    if (!entries.length && schema.length) {
      return res.status(400).json({ success: false, message: "At least one form entry is required" });
    }

    entries = mergeEntryUploadedFiles(entries, req.files || []);

    const validationErrors = validateFormEntries(schema, entries);
    if (validationErrors.length) {
      return res.status(400).json({ success: false, message: validationErrors[0] });
    }

    const needsVerification = task.verification_required !== false;

    await ClTask.submitInstance(id, {
      personRemark: person_remark,
      formResponses: schema.length ? { entries } : {},
      directComplete: !needsVerification,
    });

    res.json({
      success: true,
      message: needsVerification ? "Task submitted for verification" : "Task completed successfully",
    });
  } catch (err) {
    console.error("submitClTask:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to submit task" });
  }
}

export async function verifyClTask(req, res) {
  try {
    const { id } = req.params;
    const { action, score, verifier_remark } = req.body;
    const userId = req.user.id;

    const task = await ClTask.getInstanceById(id);
    if (!task) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }
    if (Number(task.verification_user_id) !== Number(userId)) {
      return res.status(403).json({ success: false, message: "You are not the verification person for this task" });
    }
    if (task.status !== "awaiting_verification") {
      return res.status(400).json({ success: false, message: "Task is not awaiting verification" });
    }

    if (action === "approve") {
      const scoringOn = task.verification_required !== false;
      const scoreNum = Number(score);
      if (scoringOn && (!scoreNum || scoreNum < 1 || scoreNum > 10)) {
        return res.status(400).json({ success: false, message: "Score must be between 1 and 10" });
      }
      await ClTask.approveInstance(id, scoringOn ? scoreNum : null, verifier_remark);
      return res.json({ success: true, message: "Task approved and completed" });
    }

    if (action === "reject") {
      await ClTask.rejectInstance(id, verifier_remark);
      return res.json({
        success: true,
        message: "Task rejected and sent back",
        data: { reject_count: (task.reject_count || 0) + 1 },
      });
    }

    return res.status(400).json({ success: false, message: "Action must be approve or reject" });
  } catch (err) {
    console.error("verifyClTask:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to verify task" });
  }
}

export async function deleteClTask(req, res) {
  try {
    const result = await ClTask.deleteInstance(req.params.id);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "CL task not found" });
    }
    res.json({ success: true, message: "CL task deleted successfully" });
  } catch (err) {
    console.error("deleteClTask:", err.stack || err);
    res.status(500).json({ success: false, message: "Failed to delete CL task" });
  }
}
