const ALLOWED_SPEC_TYPES = new Set(["min", "max", "range", "dropdown"]);

/** Line "type" values — extend this set when new dropdown options are added in UI. */
const ALLOWED_LINE_TYPES = new Set(["RM"]);

function toBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function splitCsv(text) {
  return String(text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinCsv(parts) {
  return (parts || []).map((s) => String(s).trim()).filter(Boolean).join(", ");
}

function numOrNull(v) {
  if (v === "" || v == null) return null;
  const text = String(v).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function assertNonNegative(n, label) {
  if (!Number.isFinite(n)) return `Enter a valid ${label}.`;
  if (n < 0) return `The ${label} cannot be below 0.`;
  return null;
}

/** Convert legacy spec_details into typed fields when new columns are empty. */
export function hydrateCriteriaFromLegacy(spec_type, row = {}) {
  const type = String(spec_type || "").toLowerCase();
  let min_value = numOrNull(row.min_value);
  let max_value = numOrNull(row.max_value);
  let correct_option = row.correct_option != null ? String(row.correct_option).trim() : "";
  let incorrect_option = row.incorrect_option != null ? String(row.incorrect_option).trim() : "";
  const details = row.spec_details;

  if (type === "dropdown") {
    if (!correct_option && !incorrect_option && details != null) {
      let opts = details;
      if (typeof opts === "string" && opts.trim()) {
        try {
          opts = JSON.parse(opts);
        } catch {
          opts = null;
        }
      }
      if (Array.isArray(opts) && opts.length) {
        const correct = [];
        const incorrect = [];
        for (const o of opts) {
          const label = typeof o === "string" ? o.trim() : String(o?.label ?? "").trim();
          if (!label) continue;
          if (typeof o === "string" ? true : Boolean(o?.is_correct)) correct.push(label);
          else incorrect.push(label);
        }
        correct_option = joinCsv(correct);
        incorrect_option = joinCsv(incorrect);
      }
    }
    return {
      min_value: 0,
      max_value: 0,
      correct_option: correct_option || null,
      incorrect_option: incorrect_option || null,
    };
  }

  if (type === "range") {
    if (details != null && String(details).trim()) {
      const text = String(details).trim();
      const match = text.match(/^(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)$/);
      if (match) {
        const dMin = Number(match[1]);
        const dMax = Number(match[2]);
        if (min_value == null || (min_value === 0 && dMin !== 0)) min_value = dMin;
        if (max_value == null || (max_value === 0 && dMax !== 0)) max_value = dMax;
      }
    }
    return {
      min_value: min_value ?? 0,
      max_value: max_value ?? 0,
      correct_option: null,
      incorrect_option: null,
    };
  }

  if (type === "min") {
    const fromDetails = numOrNull(details);
    if (min_value == null) min_value = fromDetails ?? 0;
    else if (min_value === 0 && fromDetails != null && fromDetails !== 0) min_value = fromDetails;
    return {
      min_value: min_value ?? 0,
      max_value: 0,
      correct_option: null,
      incorrect_option: null,
    };
  }

  if (type === "max") {
    const fromDetails = numOrNull(details);
    if (max_value == null) max_value = fromDetails ?? 0;
    else if (max_value === 0 && fromDetails != null && fromDetails !== 0) max_value = fromDetails;
    return {
      min_value: 0,
      max_value: max_value ?? 0,
      correct_option: null,
      incorrect_option: null,
    };
  }

  return {
    min_value: min_value ?? 0,
    max_value: max_value ?? 0,
    correct_option: correct_option || null,
    incorrect_option: incorrect_option || null,
  };
}

/** Validate + normalize a single spec line into typed columns. */
export function normalizeSpecLine(body = {}, { requireItem = true } = {}) {
  let item_dcode = null;
  if (requireItem || body.item_dcode != null) {
    const item = Number(body.item_dcode);
    if (!Number.isFinite(item) || item <= 0) {
      return { error: "RM item is required." };
    }
    item_dcode = item;
  }

  const sno = Number(body.sno);
  if (!Number.isFinite(sno) || sno < 1) {
    return { error: "Serial number must be a positive number." };
  }

  const spec_type = String(body.spec_type || "").trim().toLowerCase();
  const spec_name = body.spec_name != null ? String(body.spec_name).trim() : "";
  if (!spec_name) return { error: "Specification name is required." };
  if (!ALLOWED_SPEC_TYPES.has(spec_type)) return { error: "The selected specification type is invalid." };

  const lineTypeRaw = body.type != null ? String(body.type).trim() : "";
  const lineType = lineTypeRaw || "RM";
  if (!ALLOWED_LINE_TYPES.has(lineType)) return { error: "The selected type is invalid." };

  // Prefer typed fields; fall back to legacy spec_details when needed.
  const fromLegacy = hydrateCriteriaFromLegacy(spec_type, body);
  let min_value = 0;
  let max_value = 0;
  let correct_option = null;
  let incorrect_option = null;

  if (spec_type === "dropdown") {
    const correctRaw =
      body.correct_option != null && String(body.correct_option).trim()
        ? String(body.correct_option).trim()
        : fromLegacy.correct_option || "";
    const incorrectRaw =
      body.incorrect_option != null && String(body.incorrect_option).trim()
        ? String(body.incorrect_option).trim()
        : fromLegacy.incorrect_option || "";

    const correctParts = splitCsv(correctRaw);
    const incorrectParts = splitCsv(incorrectRaw);
    if (!correctParts.length) return { error: "Enter at least one correct option." };
    if (!incorrectParts.length) return { error: "Enter at least one incorrect option." };

    const correctLower = correctParts.map((s) => s.toLowerCase());
    const incorrectLower = incorrectParts.map((s) => s.toLowerCase());
    if (new Set(correctLower).size !== correctParts.length) {
      return { error: "Correct options must be unique." };
    }
    if (new Set(incorrectLower).size !== incorrectParts.length) {
      return { error: "Incorrect options must be unique." };
    }
    const incorrectSet = new Set(incorrectLower);
    const overlap = correctParts.find((c) => incorrectSet.has(c.toLowerCase()));
    if (overlap) {
      return { error: `"${overlap}" cannot be both a correct and an incorrect option.` };
    }

    correct_option = joinCsv(correctParts);
    incorrect_option = joinCsv(incorrectParts);
  } else if (spec_type === "range") {
    const minFinal = numOrNull(body.min_value) ?? numOrNull(body.detail_min) ?? fromLegacy.min_value;
    const maxFinal = numOrNull(body.max_value) ?? numOrNull(body.detail_max) ?? fromLegacy.max_value;

    const minErr = assertNonNegative(minFinal, "range minimum");
    if (minErr) return { error: minErr };
    const maxErr = assertNonNegative(maxFinal, "range maximum");
    if (maxErr) return { error: maxErr };
    if (minFinal > maxFinal) return { error: "The range minimum cannot exceed the range maximum." };
    min_value = minFinal;
    max_value = maxFinal;
  } else if (spec_type === "min") {
    const n =
      numOrNull(body.min_value) ??
      numOrNull(body.detail_value) ??
      numOrNull(body.spec_details) ??
      fromLegacy.min_value;
    const err = assertNonNegative(n, "min value");
    if (err) return { error: err };
    min_value = n;
  } else if (spec_type === "max") {
    const n =
      numOrNull(body.max_value) ??
      numOrNull(body.detail_value) ??
      numOrNull(body.spec_details) ??
      fromLegacy.max_value;
    const err = assertNonNegative(n, "max value");
    if (err) return { error: err };
    max_value = n;
  }

  const spec_id =
    body.spec_id != null && Number.isFinite(Number(body.spec_id))
      ? Number(body.spec_id)
      : null;

  const condition =
    body.condition != null && String(body.condition).trim()
      ? String(body.condition).trim()
      : null;
  const grade =
    body.grade != null && String(body.grade).trim() ? String(body.grade).trim() : null;
  const size =
    body.size != null && String(body.size).trim() ? String(body.size).trim() : null;

  return {
    ...(item_dcode != null ? { item_dcode } : {}),
    ...(spec_id != null ? { spec_id } : {}),
    sno,
    type: lineType,
    condition,
    grade,
    size,
    spec_name,
    remarks: body.remarks != null && String(body.remarks).trim() ? String(body.remarks).trim() : null,
    print_val: body.print_val != null && String(body.print_val).trim() ? String(body.print_val).trim() : null,
    spec_type,
    min_value,
    max_value,
    correct_option,
    incorrect_option,
    document_required: toBool(body.document_required),
  };
}

/**
 * Normalize item + specs[] payload for create/update-by-item.
 * @returns {{ error: string } | { item_dcode: number, specs: object[] }}
 */
export function normalizeItemSpecsPayload(body = {}) {
  const item = Number(body.item_dcode);
  if (!Number.isFinite(item) || item <= 0) {
    return { error: "RM item is required." };
  }

  const condition =
    body.condition != null && String(body.condition).trim()
      ? String(body.condition).trim()
      : null;
  const grade =
    body.grade != null && String(body.grade).trim() ? String(body.grade).trim() : null;
  const size =
    body.size != null && String(body.size).trim() ? String(body.size).trim() : null;

  if (!condition) return { error: "Condition is required." };
  if (!grade) return { error: "Grade is required." };
  if (!size) return { error: "Size is required." };

  const rawSpecs = Array.isArray(body.specs) ? body.specs : null;
  if (!rawSpecs || !rawSpecs.length) {
    return { error: "Add at least one specification line." };
  }

  const specs = [];
  const seenSno = new Set();

  for (let i = 0; i < rawSpecs.length; i++) {
    const line = normalizeSpecLine(
      {
        ...rawSpecs[i],
        item_dcode: item,
        condition,
        grade,
        size,
      },
      { requireItem: true }
    );
    if (line.error) {
      return { error: `Line ${i + 1}: ${line.error}` };
    }
    if (seenSno.has(line.sno)) {
      return { error: `Serial number ${line.sno} is used more than once. Each line needs a unique serial number.` };
    }
    seenSno.add(line.sno);
    specs.push(line);
  }

  specs.sort((a, b) => a.sno - b.sno);
  return { item_dcode: item, condition, grade, size, specs };
}
