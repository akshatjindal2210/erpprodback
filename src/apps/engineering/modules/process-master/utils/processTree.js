/**
 * Process tree in plain JS. `tree` = Map(id → { id, name, parent_id, depth }) of active processes (model: loadTree).
 * Everything walks up parent_id from a process to its master.
 */

export const MAX_PROCESS_DEPTH = 20;

/** Ids from the master down to `id`: Cutting(1) > Rough(2) > Fine(3) → [1, 2, 3]. Stops at a missing parent or a loop. */
export function pathIds(tree, id) {
  const ids = [];
  for (let node = tree.get(id); node && !ids.includes(node.id); node = tree.get(node.parent_id)) ids.unshift(node.id);
  return ids;
}

export const pathLabel = (tree, id) => pathIds(tree, id).map((i) => tree.get(i).name).join(" > ");
export const levelOf = (tree, id) => pathIds(tree, id).length - 1; // 0 master, 1 sub …
export const subtreeIds = (tree, id) => [...tree.keys()].filter((i) => pathIds(tree, i).includes(id)); // id + all under it

/** Check the parent of a new process (`processId` null) or of a moved one → { parent_id, depth }. */
export function resolveParent(tree, parentId, processId = null) {
  if (!parentId) return { parent_id: null, depth: 0 };
  const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });
  if (!tree.has(parentId)) throw fail("Parent process not found");
  if (processId && pathIds(tree, parentId).includes(processId)) throw fail("Parent cannot be this process or one of its sub-processes");

  const depth = levelOf(tree, parentId) + 1;
  // A moved process takes its sub-processes along → its deepest one must fit too.
  const below = processId ? Math.max(...subtreeIds(tree, processId).map((i) => levelOf(tree, i))) - levelOf(tree, processId) : 0;
  if (depth + below > MAX_PROCESS_DEPTH) throw fail(`Maximum process depth is ${MAX_PROCESS_DEPTH}`);
  return { parent_id: parentId, depth };
}
