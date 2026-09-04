/** HRMS display formatting — no timezone shift. */
export function formatHrmsDate(value) {
  if (value == null || String(value).trim() === "") return null;
  const s = String(value).trim();
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[3]}/${ymd[2]}/${ymd[1]}`;
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) return `${dmy[1]}/${dmy[2]}/${dmy[3]}`;
  const slash = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (slash) return s;
  return s;
}

export function formatHrmsTime(value) {
  if (value == null || String(value).trim() === "") return null;
  const s = String(value).trim();
  const iso = s.match(/(?:T|\s)(\d{2}):(\d{2})(?::(\d{2}))?/i);
  if (iso) {
    const h24 = parseInt(iso[1], 10);
    const min = parseInt(iso[2], 10);
    const sec = iso[3] != null ? parseInt(iso[3], 10) : null;
    if (!Number.isFinite(h24) || !Number.isFinite(min)) return s;
    const ampm = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 || 12;
    const hm = `${String(h12).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    if (sec != null && Number.isFinite(sec) && sec > 0) return `${hm}:${String(sec).padStart(2, "0")} ${ampm}`;
    return `${hm} ${ampm}`;
  }
  const plain = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (plain) {
    const h24 = parseInt(plain[1], 10);
    const min = parseInt(plain[2], 10);
    const ampm = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 || 12;
    return `${String(h12).padStart(2, "0")}:${String(min).padStart(2, "0")} ${ampm}`;
  }
  return s;
}

export function formatHrmsDateTime(value) {
  if (value == null || String(value).trim() === "") return null;
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]} ${formatHrmsTime(s)}`;
  const dateOnly = formatHrmsDate(s);
  if (dateOnly && dateOnly !== s) return dateOnly;
  return s;
}

export const formatAttendanceTime = formatHrmsDateTime;
