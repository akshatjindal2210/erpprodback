function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Store as DATE (calendar day). Accepts YYYY-MM-DD, YYYY-MM, or ISO datetime.
 * YYYY-MM → that month's 1st; missing → today's date.
 */
export function normalizeShortageMonth(value, fallbackDate) {
  const pick = (rawIn) => {
    if (rawIn == null) return null;
    if (rawIn instanceof Date && !Number.isNaN(rawIn.getTime())) {
      const y = rawIn.getUTCFullYear();
      const m = String(rawIn.getUTCMonth() + 1).padStart(2, "0");
      const d = String(rawIn.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    const raw = String(rawIn).trim();
    if (!raw) return null;
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
    return null;
  };

  return pick(value) || pick(fallbackDate) || todayYmd();
}
