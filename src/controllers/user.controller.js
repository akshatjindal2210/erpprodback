import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import config from "../config/config.js";
import { findUsers, findUser, findUserByUsernameInsensitive, insertUser, updateUsers, deleteUsers } from "../models/user.model.js";
import { fetchFromIMS } from "../utils/imsService.js";
import { findModules } from "../models/module.model.js";
import { findUserPermissions, upsertBulkPermissions } from "../models/permission.model.js";
import { logActivity } from "../utils/activityLogger.js";
import { io } from "../../app.js";
import { setCachedPermissions } from "../config/permissionCache.js";
import { getCrudModuleConfig } from "../config/crudModules.js";
import { resolveUserViewsSelectFields } from "../config/view-fields/user.js";
import { extractListParams, sanitizeFilters } from "../utils/queryHelper.js";
import { cleanPermissionMap, formatPermissions, sanitizeSearch } from "../utils/helper.js";
import { getDefaultListViewSpanDays, getBoxNoUidPrefix } from "../models/appConfig.model.js";
import { isInwardLocationValidationEnabled } from "../utils/inwardLocationValidation.js";

/** DB `CHECK (auth_source IN ('local','erp'))` — keep in sync with frontend `AUTH_SOURCES`. */
const ALLOWED_AUTH_SOURCES = Object.freeze(["local", "erp"]);

const normalizeAuthSource = (raw) => {
  const s = typeof raw === "string" ? raw.trim() : "";
  return ALLOWED_AUTH_SOURCES.includes(s) ? s : null;
};

/** ERP / IMS directory merged rows pending state */
const DIRECTORY_AUTH_SOURCE = "erp";

/**
 * Internal DB value only — ERP/IMS users never sign in with this. Login validates against IMS.
 * Format ties the row to directory identity: {username}_{usercode}_imp
 */
function defaultErpPlaceholderPassword(username, usercode) {
  const u = String(username ?? "").trim() || "user";
  const code = usercode != null && Number.isFinite(Number(usercode)) ? String(Number(usercode)) : Math.random().toString(36).slice(-10);
  return `${u}_${code}_imp`;
}

/** Exactly 10 digits (no country code). */
function normalizePhoneTo10Digits(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length === 10 ? d : null;
}

const resolveLoginCredentialKind = (user) => {
  if (user.type === "super_admin") return "local";
  const src = normalizeAuthSource(String(user.auth_source || "").trim()) ?? DIRECTORY_AUTH_SOURCE;
  return src === "local" ? "local" : "ims";
};

const USER_CFG = getCrudModuleConfig("users");
const ALLOWED_UPDATE_FIELDS  = ["name", "username", "email", "phone", "type", "status", "auth_source", "usercode"];

/** Keep only permission rows whose `module_id` exists in `modules` (client map keys must match DB). */
const normalizePermissionsForSave = async (permissions) => {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return [];
  const { data: rows = [] } = await findModules({
    page: 1,
    limit: 5000,
    sort: { by: "sort_order", order: "ASC" },
    fields: ["id"],
    filters: {},
  });
  const allowed = new Set(rows.map((r) => r.id));
  return formatPermissions(permissions).filter(
    (p) => Number.isFinite(p.module_id) && allowed.has(p.module_id)
  );
};

// ─── GET IMS users ────────────────────────────────────────────────
export const getImsUsers = async (req, res) => {
  try {
    const rawSearch = (req.body?.search && String(req.body.search).trim()) || "";

    const imsUsers = await fetchFromIMS("userlist");

    const { data: localUsers } = await findUsers({
      page: 1,
      limit: 5000,
      fields: ["id", "username", "name", "email", "phone", "type", "status", "usercode", "auth_source", "created_at"],
    });

    const byUsername = new Map(localUsers.map((u) => [u.username.toLowerCase(), u]));
    const byUsercode = new Map();
    for (const u of localUsers) {
      if (u.usercode != null && Number.isFinite(Number(u.usercode))) {
        byUsercode.set(Number(u.usercode), u);
      }
    }

    let mergedUsers = imsUsers.map((imsUser, imsIndex) => {
      const code = imsUser?.usercode != null ? Number(imsUser.usercode) : NaN;
      let localUser =
        (Number.isFinite(code) ? byUsercode.get(code) : null) ||
        byUsername.get(String(imsUser.username || "").toLowerCase());

      if (localUser) {
        return {
          ...localUser,
          usercode: localUser.usercode ?? code,
          ims_usercode: imsUser.usercode,
          is_synced: true,
        };
      }

      const pendingId = Number.isFinite(code) ? `pending_${code}` : `pending_row_${imsIndex}`;
      return {
        id: pendingId,
        username: imsUser.username,
        ims_usercode: imsUser.usercode,
        usercode: imsUser.usercode,
        name: "",
        email: "",
        phone: "",
        type: "user",
        status: "inactive",
        auth_source: DIRECTORY_AUTH_SOURCE,
        is_synced: false,
      };
    });

    if (rawSearch) {
      const q = rawSearch.toLowerCase();
      mergedUsers = mergedUsers.filter(
        (u) =>
          (u.username && String(u.username).toLowerCase().includes(q)) ||
          (u.name && String(u.name).toLowerCase().includes(q)) ||
          (u.email && String(u.email).toLowerCase().includes(q)) ||
          String(u.usercode ?? u.ims_usercode ?? "").includes(q)
      );
    }

    res.json({ success: true, data: mergedUsers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET users ────────────────────────────────────────────────────
export const getUsers = async (req, res) => {
  try {
    const { page, limit, filters, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "created_at",
      order: "DESC"
    });

    const rawFilters = sanitizeFilters(filters, USER_CFG.filterFields);
    const appliedFilters = {};
    for (const [key, value] of Object.entries(rawFilters)) {
      appliedFilters[key] = USER_CFG.searchFields.includes(key) ? `%${value}%` : value;
    }

    const result = await findUsers({
      fields: USER_CFG.listFields,
      filters: appliedFilters,
      search: sanitizeSearch(search),
      sort: { by: sortBy, order },
      page,
      limit,
      permission: req.permission
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET single user by id ────────────────────────────────────────
export const getUserById = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "User ID required" });

    const user = await findUser({ id });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const permissions = await findUserPermissions(id);
    const { password, ...safeUser } = user;
    res.json({ success: true, data: { ...safeUser, permissions: permissions.map(cleanPermissionMap) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── CREATE user ─────────────────────────────────────────────────
export const createUser = async (req, res) => {
  try {
    const { name, username, email, phone, password, type, status, permissions, auth_source, usercode } = req.body;

    const trimmedName = String(name ?? "").trim();
    const trimmedUsername = String(username ?? "").trim();
    if (!trimmedName || !trimmedUsername)
      return res.status(400).json({ success: false, message: "name and username required" });

    const normalizedPhone = normalizePhoneTo10Digits(phone);
    if (!normalizedPhone)
      return res.status(400).json({ success: false, message: "Phone number is required (10 digits)" });

    const rawSrc = auth_source !== undefined && auth_source !== null && String(auth_source).trim() !== "" ? String(auth_source).trim() : "local";
    const src = normalizeAuthSource(rawSrc);
    if (!src)
      return res.status(400).json({ success: false, message: `auth_source must be one of: ${ALLOWED_AUTH_SOURCES.join(", ")}` });

    if (src === "local" && (!password || !String(password).trim())) {
      return res.status(400).json({ success: false, message: "Password is required for local accounts" });
    }

    if (await findUserByUsernameInsensitive(trimmedUsername))
      return res.status(409).json({ success: false, message: "Username already exists" });
    if (await findUser({ phone: normalizedPhone }))
      return res.status(409).json({ success: false, message: "Phone already exists" });

    let numericUsercode = null;
    if (usercode !== undefined && usercode !== null && String(usercode).trim() !== "") {
      numericUsercode = Number(usercode);
      if (!Number.isFinite(numericUsercode)) {
        return res.status(400).json({ success: false, message: "Invalid usercode" });
      }
      const existingCode = await findUser({ usercode: numericUsercode });
      if (existingCode) {
        return res.status(409).json({ success: false, message: "This ERP usercode is already linked in the application" });
      }
    } else if (src === DIRECTORY_AUTH_SOURCE) {
      return res.status(400).json({ success: false, message: "Directory-linked users require a usercode from IMS" });
    }

    const finalPassword = password?.trim() ? password : defaultErpPlaceholderPassword(trimmedUsername, numericUsercode);

    const normalizedEmail = email !== undefined && email !== null && String(email).trim() ? String(email).trim().toLowerCase() : null;

    const user = await insertUser({
      name: trimmedName,
      username: trimmedUsername,
      email: normalizedEmail,
      phone: normalizedPhone,
      password: finalPassword,
      type,
      status,
      created_by: req.user.id,
      usercode: numericUsercode,
      auth_source: src,
    });

    if (permissions && typeof permissions === "object" && !Array.isArray(permissions)) {
      const permRows = await normalizePermissionsForSave(permissions);
      const meta = { created_by: req.user.id, updated_by: req.user.id };
      await upsertBulkPermissions(user.id, permRows, meta);
    }

    await logActivity(req, { action: "create", entity: "users", entity_id: user.id, details: { name: user.name, username: user.username } });
    res.status(201).json({ success: true, data: user, message: "User created successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── UPDATE user ──────────────────────────────────────────────────
export const updateUser = async (req, res) => {
  try {
    const { id, name, username, email, phone, type, status, password, permissions, auth_source, usercode } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "User ID required" });

    const existing = await findUser({ id });
    if (!existing) return res.status(404).json({ success: false, message: "User not found" });

    const rawFields = { name, username, email, phone, type, status, auth_source, usercode };
    const fields = {};
    for (const key of ALLOWED_UPDATE_FIELDS) {
      if (rawFields[key] === undefined || rawFields[key] === null) continue;
      if (key === "usercode" && String(rawFields[key]).trim() === "") continue;
      if (key === "email") {
        const t = String(rawFields.email).trim();
        fields.email = t ? t.toLowerCase() : null;
        continue;
      }
      fields[key] = rawFields[key];
    }

    if (fields.usercode !== undefined) {
      const n = Number(fields.usercode);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ success: false, message: "Invalid usercode" });
      }
      fields.usercode = n;
      const clash = await findUser({ usercode: n });
      if (clash && clash.id !== Number(id)) {
        return res.status(409).json({ success: false, message: "This ERP usercode is already linked to another user" });
      }
    }

    if (fields.auth_source !== undefined) {
      const s = normalizeAuthSource(String(fields.auth_source).trim());
      if (!s) {
        return res.status(400).json({
          success: false,
          message: `auth_source must be one of: ${ALLOWED_AUTH_SOURCES.join(", ")}`,
        });
      }
      fields.auth_source = s;
    }

    if (fields.username !== undefined) {
      const u = String(fields.username).trim();
      if (!u)
        return res.status(400).json({ success: false, message: "Username is required" });
      fields.username = u;
      const clash = await findUserByUsernameInsensitive(u);
      if (clash && clash.id !== Number(id))
        return res.status(409).json({ success: false, message: "Username already exists" });
    }

    if (fields.phone !== undefined) {
      const p = normalizePhoneTo10Digits(fields.phone);
      if (!p)
        return res.status(400).json({ success: false, message: "Phone number is required (10 digits)" });
      fields.phone = p;
      const clash = await findUser({ phone: p });
      if (clash && clash.id !== Number(id))
        return res.status(409).json({ success: false, message: "Phone already exists" });
    }

    // Password update — hash if provided
    if (password && password.trim()) {
      fields.password = await bcrypt.hash(password.trim(), 10);
    }

    fields.updated_by = req.user.id;
    fields.updated_at = new Date();

    const [updated] = await updateUsers(fields, { id });
    Object.assign(existing, updated);

    if (permissions && typeof permissions === "object" && !Array.isArray(permissions)) {
      const permRows = await normalizePermissionsForSave(permissions);
      const meta = { created_by: req.user.id, updated_by: req.user.id };
      await upsertBulkPermissions(id, permRows, meta);

      const freshPermissions = await findUserPermissions(id);
      setCachedPermissions(id, freshPermissions);
      io.to(`user_${id}`).emit("permissions_updated", freshPermissions);
    }

    await logActivity(req, { action: "update", entity: "users", entity_id: id, details: { updated_fields: Object.keys(fields) } });
    res.json({ success: true, data: existing, message: "User updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── DELETE user ──────────────────────────────────────────────────
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "User ID required" });

    const existing = await findUser({ id });
    if (!existing) return res.status(404).json({ success: false, message: "User not found" });

    await deleteUsers({ id }, { deleted_by: req.user.id });
    await logActivity(req, { action: "delete", entity: "users", entity_id: id, details: { deleted_user: existing.username } });
    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── LOGIN ────────────────────────────────────────────────────────
export const loginUser = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, message: "Username and password required" });

    const normalizedUsername = String(username).trim();

    const user = await findUserByUsernameInsensitive(normalizedUsername);

    if (!user) {
      await logActivity(req, {
        action: "login",
        entity: "users",
        details: { username: normalizedUsername, reason: "User not found in local database" },
        success: false,
      });
      return res.status(401).json({ success: false, message: "User not authorized in this application" });
    }

    const credentialKind = resolveLoginCredentialKind(user);

    if (credentialKind === "local") {
      const ok = await bcrypt.compare(String(password), user.password);
      if (!ok) {
        await logActivity(req, {
          action: "login",
          entity: "users",
          details: { username: normalizedUsername, reason: "Invalid credentials" },
          success: false,
        });
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }
    } else if (credentialKind === "ims") {
      let imsResult;
      try {
        imsResult = await fetchFromIMS("checkpass", { user: normalizedUsername, password });
      } catch {
        return res.status(500).json({ success: false, message: "Authentication service unavailable" });
      }

      if (!imsResult || !imsResult.status) {
        await logActivity(req, {
          action: "login",
          entity: "users",
          details: { username: normalizedUsername, reason: imsResult?.message || "Invalid credentials" },
          success: false,
        });
        return res.status(401).json({ success: false, message: imsResult?.message || "Invalid credentials" });
      }
    } else {
      await logActivity(req, {
        action: "login",
        entity: "users",
        details: { username: normalizedUsername, reason: `Unsupported auth: ${credentialKind}` },
        success: false,
      });
      return res.status(501).json({
        success: false,
        message: "This sign-in method is not enabled on the server yet",
      });
    }

    if (user.status !== "active") {
      await logActivity(req, {
        action: "login",
        entity: "users",
        details: { username: normalizedUsername, reason: "Account inactive" },
        success: false,
      });
      return res.status(403).json({ success: false, message: "Account is inactive" });
    }

    const token = jwt.sign({ id: user.id, type: user.type }, config.jwt_secret, { expiresIn: "1d" });

    res.cookie(config.cookie_name, token, {
      httpOnly: true,
      secure: config.node_env === "production",
      sameSite: config.node_env === "production" ? "strict" : "lax",
      path: "/",
      maxAge: config.cookie_max_age,
      ...(config.domain !== "localhost" ? { domain: config.domain } : {}),
    });
    
    const permissions = await findUserPermissions(user.id);
    const cleanedPermissions = permissions.map(cleanPermissionMap);
    setCachedPermissions(user.id, cleanedPermissions);

    const { id, name, type: role, email } = user;
    const [default_list_view_span_days, inward_location_validation, box_no_uid_prefix] = await Promise.all([
      getDefaultListViewSpanDays(),
      isInwardLocationValidationEnabled(),
      getBoxNoUidPrefix(),
    ]);
    await logActivity(req, { action: "login", entity: "users", entity_id: user.id, details: { username: user.username } });

    res.json({
      success: true,
      data: {
        id,
        name,
        role,
        email,
        permissions: cleanedPermissions,
        default_list_view_span_days,
        inward_location_validation,
        box_no_uid_prefix,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── LOGOUT ───────────────────────────────────────────────────────
export const logoutUser = async (req, res) => {
  try {
    await logActivity(req, { action: "logout", entity: "users", entity_id: req.user.id });
    
    // ── Cookie ───────────────────────────
    res.clearCookie(config.cookie_name, {
      httpOnly: true,
      secure: config.node_env === "production",
      sameSite: config.node_env === "production" ? "strict" : "lax",
      path: "/",
      ...(config.domain !== "localhost" ? { domain: config.domain } : {}),
    });

    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET ME (auth check) ──────────────────────────────────────────
export const getMe = async (req, res) => {
  try {
    const user = await findUser({ id: req.user.id });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (user.status !== "active")
      return res.status(403).json({ success: false, message: "Account inactive" });

    const permissions = await findUserPermissions(req.user.id);
    const [default_list_view_span_days, inward_location_validation, box_no_uid_prefix] = await Promise.all([
      getDefaultListViewSpanDays(),
      isInwardLocationValidationEnabled(),
      getBoxNoUidPrefix(),
    ]);
    const { password, ...safeUser } = user;
    res.json({
      success: true,
      data: {
        ...safeUser,
        role: user.type,
        permissions: permissions.map(cleanPermissionMap),
        default_list_view_span_days,
        inward_location_validation,
        box_no_uid_prefix,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET Views (Helper API for other modules) ──────────────────
export const getUsersViews = async (req, res) => {
  try {
    const { id, permission_module, permission_action } = req.body || {};
    const { page, limit, sortBy, order, search } = extractListParams(req.body, {
      sortBy: "created_at",
      order: "DESC"
    });

    if (id) {
      const user = await findUser({ id });
      if (!user || user.status !== "active") return res.json({ success: true, data: null });
      return res.json({ success: true, data: { id: user.id, name: user.name, username: user.username } });
    }

    const fields = resolveUserViewsSelectFields({ permission_module, permission_action });
    if (fields == null) {
      return res.status(400).json({
        success: false,
        message: "Invalid permission_module / permission_action for user views"
      });
    }

    const result = await findUsers({
      search: sanitizeSearch(search),
      sort: { by: sortBy || "created_at", order: order || "DESC" },
      page: 1,
      limit: 5000,
      fields: fields || ["id", "name", "username"],
      filters: { status: "active" }
    });
    
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};