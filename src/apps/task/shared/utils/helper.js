import dbQuery from "../../shared/db.js";
import fs from "fs";
import path from "path";

/** PostgreSQL boolean columns may come back as true/false, 1/0, or 't'/'f'. */
export const isDbTrue = (val) =>
  val === true || val === 1 || val === "1" || val === "t" || val === "true";

export const toDbBool = (val) => !!val;

/** Never null — safe for `.length` / `.map` / `for..of`. */
export const asArray = (val) => (Array.isArray(val) ? val : []);

/** FormData / JSON sub_users → always an array. */
export const parseSubUsers = (val) => {
  if (val == null || val === "") return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      return asArray(JSON.parse(val));
    } catch {
      return [];
    }
  }
  return [];
};

/** DB / JSON attachment column → always an array. */
export const parseAttachmentsJson = (val) => {
  if (val == null || val === "") return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      return asArray(JSON.parse(val));
    } catch {
      return [];
    }
  }
  return [];
};

// ── parseArr — FormData string → array (recurrence fields)
export const parseArr = (val) => parseSubUsers(val);

// ── calcNextOccurrence
export const calcNextOccurrence = (type, weekdays = [], monthDates = [], yearDates = []) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const toStr = (d) => {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const dd   = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (type === "daily") return toStr(tomorrow);

  if (type === "weekly") {
    if (!weekdays || weekdays.length === 0) return toStr(tomorrow);
    const dayMap   = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const todayDay = today.getDay();
    const days     = weekdays.map((d) => dayMap[d?.toLowerCase()] ?? -1).filter(d => d >= 0).sort((a, b) => a - b);
    if (days.length === 0) return toStr(tomorrow);
    let diff = days.find((d) => d > todayDay);
    diff = diff !== undefined ? diff - todayDay : days[0] + 7 - todayDay;
    const next = new Date(today);
    next.setDate(next.getDate() + diff);
    return toStr(next);
  }

  if (type === "monthly") {
    if (!monthDates || monthDates.length === 0) return toStr(tomorrow);
    const todayDate = today.getDate();
    const sorted    = monthDates.map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (sorted.length === 0) return toStr(tomorrow);
    const nextDate  = sorted.find((d) => d > todayDate);
    const next      = new Date(today);
    if (nextDate) {
      next.setDate(nextDate);
    } else {
      next.setMonth(next.getMonth() + 1);
      next.setDate(sorted[0]);
    }
    return toStr(next);
  }

  if (type === "yearly") {
    if (!yearDates || yearDates.length === 0) return toStr(tomorrow);
    const sorted   = [...yearDates].sort();
    const todayStr = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const found    = sorted.find((d) => d > todayStr) ?? sorted[0];
    const [mm, dd] = found.split("-");
    const year     = found > todayStr ? today.getFullYear() : today.getFullYear() + 1;
    return `${year}-${mm}-${dd}`;
  }

  return toStr(tomorrow);
};

export const upsertRecurring = async (task_id, body, isUpdate = false) => {

  const recurrence_type        = body.recurrence_type || "weekly";
  const recurrence_weekdays    = parseArr(body.recurrence_weekdays);
  const recurrence_month_dates = parseArr(body.recurrence_month_dates);
  const recurrence_year_dates  = parseArr(body.recurrence_year_dates);
  const end_date               = body.end_date || null;
  const is_active              = body.is_active === true || body.is_active === "true" || body.is_active === 1;

  const next_occurrence = calcNextOccurrence(
    recurrence_type,
    recurrence_weekdays,
    recurrence_month_dates,
    recurrence_year_dates
  );

  const wdJSON = recurrence_weekdays.length    > 0 ? JSON.stringify(recurrence_weekdays)    : null;
  const mdJSON = recurrence_month_dates.length > 0 ? JSON.stringify(recurrence_month_dates) : null;
  const ydJSON = recurrence_year_dates.length  > 0 ? JSON.stringify(recurrence_year_dates)  : null;

  // ── UPDATE existing
  if (isUpdate && task_id) {
    const [existing] = await dbQuery(
      "SELECT recurring_id FROM task_recurring_tasks WHERE task_id = ?",
      [task_id]
    );

    if (existing) {
      return await dbQuery(
        `UPDATE task_recurring_tasks SET
           recurrence_type        = ?,
           recurrence_weekdays    = ?,
           recurrence_month_dates = ?,
           recurrence_year_dates  = ?,
           next_occurrence        = ?,
           end_date               = ?,
           is_active              = ?,
           updated_at             = NOW()
         WHERE task_id = ?`,
        [recurrence_type, wdJSON, mdJSON, ydJSON, next_occurrence, end_date, is_active, task_id]
      );
    }
  }

  // ── CREATE NEW
  if (task_id) {
    // Only if task_id exists, link recurring row to task
    return await dbQuery(
      `INSERT INTO task_recurring_tasks
        (task_id, recurrence_type, recurrence_weekdays, recurrence_month_dates,
         recurrence_year_dates, next_occurrence, end_date, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [task_id, recurrence_type, wdJSON, mdJSON, ydJSON, next_occurrence, end_date, isUpdate ? is_active : true]
    );
  } else {
    // Insert schedule only — no task_id
    return await dbQuery(
      `INSERT INTO task_recurring_tasks
        (recurrence_type, recurrence_weekdays, recurrence_month_dates,
         recurrence_year_dates, next_occurrence, end_date, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [recurrence_type, wdJSON, mdJSON, ydJSON, next_occurrence, end_date, isUpdate ? is_active : true]
    );
  }
};

export const checkAccountStatus = (user) => {
  if (!user) {
    return { status: 401, message: "Invalid username or password" };
  }

  switch (user.status) {
    case "active":
      return null;

    case "suspended":
      return { status: 403, message: "Your account has been suspended" };

    case "inactive":
    case "deactivated":
      return { status: 403, message: "Your account is deactivated" };

    default:
      return { status: 403, message: "Account status not valid" };
  }
};

export function calculateNextOccurrence(recurrence_type, data = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekdays    = Array.isArray(data.recurrence_weekdays)    ? data.recurrence_weekdays    : [];
  const monthDates  = Array.isArray(data.recurrence_month_dates) ? data.recurrence_month_dates : [];
  const yearDates   = Array.isArray(data.recurrence_year_dates)  ? data.recurrence_year_dates  : [];

  const toStr = (d) => {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const dd   = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (recurrence_type === "daily") return toStr(tomorrow);

  if (recurrence_type === "weekly") {
    if (!weekdays.length) return toStr(tomorrow);
    const dayMap   = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const todayDay = today.getDay();
    const days     = weekdays
      .map((d) => typeof d === "string" ? (dayMap[d.toLowerCase()] ?? -1) : Number(d))
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);
    if (!days.length) return toStr(tomorrow);
    let diff = days.find((d) => d > todayDay);
    diff = diff !== undefined ? diff - todayDay : days[0] + 7 - todayDay;
    const next = new Date(today);
    next.setDate(next.getDate() + diff);
    return toStr(next);
  }

  if (recurrence_type === "monthly") {
    if (!monthDates.length) return toStr(tomorrow);
    const todayDate = today.getDate();
    const sorted    = monthDates.map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    if (!sorted.length) return toStr(tomorrow);
    const nextDate  = sorted.find((d) => d > todayDate);
    const next      = new Date(today);
    if (nextDate) {
      next.setDate(nextDate);
    } else {
      next.setMonth(next.getMonth() + 1);
      next.setDate(sorted[0]);
    }
    return toStr(next);
  }

  if (recurrence_type === "yearly") {
    if (!yearDates.length) return toStr(tomorrow);
    const sorted   = [...yearDates].sort();
    const todayStr = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const found    = sorted.find((d) => d > todayStr) ?? sorted[0];
    const [mm, dd] = found.split("-");
    const year     = found > todayStr ? today.getFullYear() : today.getFullYear() + 1;
    return `${year}-${mm}-${dd}`;
  }

  return toStr(tomorrow);
}

export const isValidDate = (val) => /^\d{4}-\d{2}-\d{2}$/.test(val) && !isNaN(Date.parse(val));

export const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

export const chatMessage = (title, description) =>{
   const cleanDesc = description
    ? description
        .replace(/<[^>]+>/g, "")   // Strip HTML tags
        .replace(/&nbsp;/g, " ")   // &nbsp; space se replace
        .replace(/&amp;/g, "&")    // &amp; fix
        .replace(/&lt;/g, "<")     // &lt; fix
        .replace(/&gt;/g, ">")     // &gt; fix
        .replace(/&quot;/g, '"')   // &quot; fix
        .replace(/\s+/g, " ")      // multiple spaces ek space
        .trim()
    : null;

  const chatMsg = `📋 Task: ${title.trim()}${cleanDesc ? `\n\n📝 ${cleanDesc}` : ""}`;
  
  return chatMsg;
}

export const saveAttachments = async (files, folder) => {
  if (!files?.length) return [];

  ensureDir(folder);

  const attachments = [];
  for (const f of files) {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(f.originalname)}`;
    const filePath = path.join(folder, uniqueName);

    // Copy file from multer temp location
    fs.copyFileSync(f.path, filePath);

    attachments.push({
      file_name: f.originalname,
      file_path: filePath,
      file_size: f.size,
      mime_type: f.mimetype,
    });
  }
  return attachments;
};