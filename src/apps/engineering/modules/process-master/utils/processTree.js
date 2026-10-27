/**
 * Process tree in plain JS. `tree` = Map(proccode → { proccode, procname, parent_id, depth }) of active processes (model: loadTree).
 * Everything walks up parent_id from a process to its master.
 */

export const MAX_PROCESS_DEPTH = 20;

/** Codes from the master down to `code`: Cutting(1) > Rough(2) > Fine(3) → [1, 2, 3]. Stops at a missing parent or a loop. */
export function pathIds(tree, code) {
  const ids = [];
  for (let node = tree.get(code); node && !ids.includes(node.proccode); node = tree.get(node.parent_id)) {
    ids.unshift(node.proccode);
  }
  return ids;
}

export const pathLabel = (tree, code) => pathIds(tree, code).map((i) => tree.get(i).procname).join(" > ");
export const levelOf = (tree, code) => pathIds(tree, code).length - 1; // 0 master, 1 sub …
export const subtreeIds = (tree, code) => [...tree.keys()].filter((i) => pathIds(tree, i).includes(code)); // code + all under it

/** Check the parent of a new process (`processCode` null) or of a moved one → { parent_id, depth }. */
export function resolveParent(tree, parentId, processCode = null) {
  if (!parentId) return { parent_id: null, depth: 0 };
  const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });
  if (!tree.has(parentId)) throw fail("Parent process not found");
  if (processCode && pathIds(tree, parentId).includes(processCode)) {
    throw fail("Parent cannot be this process or one of its sub-processes");
  }

  const depth = levelOf(tree, parentId) + 1;
  // A moved process takes its sub-processes along → its deepest one must fit too.
  const below = processCode
    ? Math.max(...subtreeIds(tree, processCode).map((i) => levelOf(tree, i))) - levelOf(tree, processCode)
    : 0;
  if (depth + below > MAX_PROCESS_DEPTH) throw fail(`Maximum process depth is ${MAX_PROCESS_DEPTH}`);
  return { parent_id: parentId, depth };
}
