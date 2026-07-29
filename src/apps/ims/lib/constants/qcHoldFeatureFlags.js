/**
 * QC Hold feature toggles — change here to re-enable flows without hunting the codebase.
 *
 * QC_HOLD_PARTIAL_ENABLED = false  →  only Full Hold + Full Submit (current default).
 * QC_HOLD_PARTIAL_ENABLED = true   →  also Partial Hold scan + Partial Submit.
 */

export const QC_HOLD_PARTIAL_ENABLED = false;
