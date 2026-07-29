/**
 * Evaluate an inspector actual value against a Spec Master line.
 * @returns {{ result: 'pass'|'fail', message?: string }}
 */
export function evaluateSpecLine(spec, actualRaw) {
  const specType = String(spec?.spec_type || "").trim().toLowerCase();
  const actualText = actualRaw == null ? "" : String(actualRaw).trim();

  if (!actualText) {
    return { result: "fail", message: "Actual value is required." };
  }

  if (specType === "dropdown") {
    const correct = String(spec?.correct_option || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const match = correct.some((opt) => opt.toLowerCase() === actualText.toLowerCase());
    return match
      ? { result: "pass" }
      : { result: "fail", message: `Expected one of: ${correct.join(", ") || "—"}` };
  }

  const actual = Number(actualText);
  if (!Number.isFinite(actual)) {
    return { result: "fail", message: "Enter a valid number." };
  }

  const min = Number(spec?.min_value);
  const max = Number(spec?.max_value);

  if (specType === "min") {
    const floor = Number.isFinite(min) ? min : 0;
    return actual >= floor
      ? { result: "pass" }
      : { result: "fail", message: `Must be ≥ ${floor}` };
  }

  if (specType === "max") {
    const ceil = Number.isFinite(max) ? max : 0;
    return actual <= ceil
      ? { result: "pass" }
      : { result: "fail", message: `Must be ≤ ${ceil}` };
  }

  if (specType === "range") {
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 0;
    return actual >= lo && actual <= hi
      ? { result: "pass" }
      : { result: "fail", message: `Must be between ${lo} and ${hi}` };
  }

  return { result: "fail", message: `"${specType || "—"}" is not a valid specification type.` };
}

export function formatExpected(spec) {
  const specType = String(spec?.spec_type || "").trim().toLowerCase();
  if (specType === "min") return `≥ ${Number(spec?.min_value) || 0}`;
  if (specType === "max") return `≤ ${Number(spec?.max_value) || 0}`;
  if (specType === "range") {
    return `${Number(spec?.min_value) || 0} – ${Number(spec?.max_value) || 0}`;
  }
  if (specType === "dropdown") {
    return String(spec?.correct_option || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" | ") || "—";
  }
  return "—";
}
