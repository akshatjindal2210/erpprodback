/**
 * Neighbor qty gap (kg) for auto-split. Change here only.
 * Keep the same values in: frontend/.../lib/helpers/coilUid.js
 *
 * Neighbor coils differ by min…max kg (2 coils or 200).
 * Qtys stay near the average — they do not climb from first coil to last.
 * When total >= coil count → every coil qty >= 1. Sum always equals total.
 */
export const COIL_QTY_DIFF = { min: 4, max: 10 };

export function roundCoilQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v);
}

/** Equal split — remainder (+1) on first coils. */
export function equalSplitQtyAcrossCoils(totalQty, coilCount) {
  const n = Math.max(1, Number(coilCount) || 1);
  const total = roundCoilQty(totalQty);
  if (n === 1) return [total];
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

function ensureNoZeroQtys(qtys, total) {
  const n = qtys.length;
  if (total < n) return qtys;
  for (let guard = 0; guard < n * 2; guard++) {
    const zi = qtys.findIndex((q) => q < 1);
    if (zi < 0) break;
    let donor = -1;
    let donorQty = 1;
    for (let i = 0; i < n; i++) {
      if (qtys[i] > donorQty) {
        donorQty = qtys[i];
        donor = i;
      }
    }
    if (donor < 0 || qtys[donor] <= 1) break;
    qtys[donor] -= 1;
    qtys[zi] += 1;
  }
  return qtys;
}

function reconcileToTotal(qtys, total) {
  const n = qtys.length;
  if (n === 0) return qtys;
  let sum = qtys.reduce((s, q) => s + q, 0);
  let diff = total - sum;
  if (diff === 0) return qtys;

  if (diff > 0) {
    qtys[n - 1] += diff;
    return qtys;
  }

  let need = -diff;
  const minEach = total >= n ? 1 : 0;
  while (need > 0) {
    let idx = -1;
    let best = minEach;
    for (let i = 0; i < n; i++) {
      if (qtys[i] > best) {
        best = qtys[i];
        idx = i;
      }
    }
    if (idx < 0) break;
    const take = Math.min(need, qtys[idx] - minEach);
    if (take <= 0) break;
    qtys[idx] -= take;
    need -= take;
  }
  return qtys;
}

function enforceMaxGap(qtys, max) {
  const n = qtys.length;
  let guard = 0;
  let changed = true;
  while (changed && guard < n * n) {
    changed = false;
    guard += 1;
    for (let i = 0; i < n - 1; i++) {
      const gap = qtys[i] - qtys[i + 1];
      if (gap > max) {
        const move = Math.min(gap - max, qtys[i] - 1);
        if (move > 0) {
          qtys[i] -= move;
          qtys[i + 1] += move;
          changed = true;
        }
      } else if (-gap > max) {
        const move = Math.min(-gap - max, qtys[i + 1] - 1);
        if (move > 0) {
          qtys[i + 1] -= move;
          qtys[i] += move;
          changed = true;
        }
      }
    }
  }
  return qtys;
}

function enforceMinGap(qtys, min) {
  const n = qtys.length;
  if (min <= 0) return qtys;
  let guard = 0;
  let changed = true;
  while (changed && guard < n * n) {
    changed = false;
    guard += 1;
    for (let i = 0; i < n - 1; i++) {
      const gap = qtys[i] - qtys[i + 1];
      const abs = Math.abs(gap);
      if (abs >= min) continue;
      const need = min - abs;
      if (gap >= 0) {
        const move = Math.min(need, qtys[i + 1] - 1);
        if (move > 0) {
          qtys[i] += move;
          qtys[i + 1] -= move;
          changed = true;
        }
      } else {
        const move = Math.min(need, qtys[i] - 1);
        if (move > 0) {
          qtys[i + 1] += move;
          qtys[i] -= move;
          changed = true;
        }
      }
    }
  }
  return qtys;
}

/**
 * High/low wave around the average. Neighbor gap cycles through min…max
 * so the smallest and largest coil stay about `max` kg apart — not n × min.
 */
function applyZigzag(qtys, min, max) {
  const n = qtys.length;
  const halfLo = Math.max(1, Math.ceil(min / 2));
  const halfHi = Math.max(halfLo, Math.floor(max / 2));
  const span = halfHi - halfLo + 1;
  for (let i = 0; i + 1 < n; i += 2) {
    const half = halfLo + ((i / 2) % span);
    const available = qtys[i + 1] - 1;
    if (available <= 0) continue;
    const extra = Math.min(half, available);
    if (extra > 0) {
      qtys[i] += extra;
      qtys[i + 1] -= extra;
    }
  }
  if (n % 2 === 1 && n >= 3) {
    const last = n - 1;
    const prev = last - 1;
    const gap = Math.abs(qtys[last] - qtys[prev]);
    if (gap < min && qtys[prev] > 1) {
      const need = Math.min(min - gap, qtys[prev] - 1);
      if (need > 0) {
        qtys[prev] -= need;
        qtys[last] += need;
      }
    }
  }
  return qtys;
}

function polishGaps(qtys, total, min, max) {
  ensureNoZeroQtys(qtys, total);
  reconcileToTotal(qtys, total);
  enforceMaxGap(qtys, max);
  enforceMinGap(qtys, min);
  ensureNoZeroQtys(qtys, total);
  reconcileToTotal(qtys, total);
  return qtys;
}

/** Uneven split: neighbor gaps in COIL_QTY_DIFF.min…max; qtys stay near the average. */
export function splitQtyAcrossCoils(totalQty, coilCount) {
  const n = Math.max(1, Number(coilCount) || 1);
  const total = roundCoilQty(totalQty);
  const { min, max } = COIL_QTY_DIFF;
  if (n === 1) return [total];
  if (total <= 0) return Array.from({ length: n }, () => 0);

  const qtys = equalSplitQtyAcrossCoils(total, n);
  if (total < n) return reconcileToTotal(qtys, total);

  applyZigzag(qtys, min, max);
  return polishGaps(qtys, total, min, max);
}
