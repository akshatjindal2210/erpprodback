import RedTicket from "../models/redTicket.model.js";
import MisScore from "../models/misScore.model.js";
import { assertWithinEditDays, isSuperAdminReq } from "../../core/utils/permissionDays.js";
import { paramsFromReq, idFromReq, listLimit } from "../shared/postRequest.js";

function permissionViewDays(req) {
  if (isSuperAdminReq(req)) return 0;
  return Number(req.permission?.can_view_days) || 0;
}

async function syncMisForTicket(ticketId, ticket, userId) {
  await MisScore.deleteBySource("red_ticket", ticketId);
  const penalty = Number(ticket.score_penalty) || 0;
  if (penalty > 0 && ticket.person_id) {
    await MisScore.addEntry({
      user_id: ticket.person_id,
      score_delta: -penalty,
      source_type: "red_ticket",
      source_id: ticketId,
      remark: ticket.title,
      ledger_date: ticket.ticket_date_fmt || ticket.ticket_date || new Date().toISOString().slice(0, 10),
      created_by: userId,
    });
  }
}

export async function getRedTickets(req, res) {
  try {
    const {
      search = "",
      page = 1,
      limit = 1000,
      department_id,
      designation_id,
      person_id,
      date_from,
      date_to,
    } = paramsFromReq(req);
    const viewDays = permissionViewDays(req);
    const pageNum = Number(page) || 1;
    const lim = listLimit(limit, 1000, 5000);

    const { items, total } = await RedTicket.getAll({
      search,
      page: pageNum,
      limit: lim,
      department_id,
      designation_id,
      person_id,
      date_from,
      date_to,
      viewDays,
    });
    res.json({
      success: true,
      data: {
        items,
        total,
        page: pageNum,
        limit: lim,
        totalPages: Math.ceil(total / lim) || 1,
      },
    });
  } catch (err) {
    console.error("getRedTickets:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function getRedTicketById(req, res) {
  try {
    const id = idFromReq(req, "ticket_id", "id");
    if (!id) return res.status(400).json({ success: false, message: "Invalid ticket id" });
    const row = await RedTicket.getById(id);
    if (!row) return res.status(404).json({ success: false, message: "Red ticket not found" });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error("getRedTicketById:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function createRedTicket(req, res) {
  try {
    const {
      title,
      description,
      priority,
      status,
      department_id,
      designation_id,
      person_id,
      score_penalty,
      cl_instance_id,
      task_id,
      ticket_date,
    } = paramsFromReq(req);
    if (!title?.trim() && !description?.trim()) {
      return res.status(400).json({ success: false, message: "Description is required" });
    }
    if (!person_id) {
      return res.status(400).json({ success: false, message: "Person is required" });
    }
    const penalty = Number(score_penalty);
    if (!Number.isFinite(penalty) || penalty <= 0) {
      return res.status(400).json({ success: false, message: "Score penalty must be greater than 0" });
    }
    const ticketTitle = title?.trim() || String(description).trim().slice(0, 120) || "Red Ticket";
    const ticket_id = await RedTicket.create({
      title: ticketTitle,
      description,
      priority,
      status,
      created_by: req.user.id,
      department_id,
      designation_id,
      person_id,
      score_penalty,
      cl_instance_id,
      task_id,
      ticket_date,
    });
    const row = await RedTicket.getById(ticket_id);
    await syncMisForTicket(ticket_id, row, req.user.id);
    res.status(201).json({ success: true, message: "Red ticket created", data: row });
  } catch (err) {
    console.error("createRedTicket:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function updateRedTicket(req, res) {
  try {
    const id = idFromReq(req, "ticket_id", "id");
    if (!id) return res.status(400).json({ success: false, message: "Invalid ticket id" });

    const existing = await RedTicket.getById(id);
    if (!existing) return res.status(404).json({ success: false, message: "Red ticket not found" });

    const blocked = assertWithinEditDays(req, existing.created_at || existing.ticket_date, "edit");
    if (blocked) {
      return res.status(blocked.status).json({ success: false, message: blocked.message });
    }

    const body = { ...paramsFromReq(req) };
    delete body.ticket_id;
    delete body.id;

    if (body.score_penalty != null) {
      const penalty = Number(body.score_penalty);
      if (!Number.isFinite(penalty) || penalty <= 0) {
        return res.status(400).json({ success: false, message: "Score penalty must be greater than 0" });
      }
    }
    if (body.description != null && !String(body.description).trim()) {
      return res.status(400).json({ success: false, message: "Description is required" });
    }
    if (!body.title?.trim() && body.description?.trim()) {
      body.title = String(body.description).trim().slice(0, 120);
    }

    await RedTicket.update(id, body);
    const row = await RedTicket.getById(id);
    await syncMisForTicket(Number(id), row, req.user.id);
    res.json({ success: true, message: "Red ticket updated", data: row });
  } catch (err) {
    console.error("updateRedTicket:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function deleteRedTicket(req, res) {
  try {
    const id = idFromReq(req, "ticket_id", "id");
    if (!id) return res.status(400).json({ success: false, message: "Invalid ticket id" });
    const existing = await RedTicket.getById(id);
    if (!existing) return res.status(404).json({ success: false, message: "Red ticket not found" });
    await MisScore.deleteBySource("red_ticket", Number(id));
    await RedTicket.delete(id);
    res.json({ success: true, message: "Red ticket deleted" });
  } catch (err) {
    console.error("deleteRedTicket:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}
