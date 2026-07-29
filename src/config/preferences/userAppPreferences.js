/** Shared user preference keys — table: mst_user_app_preferences */

export const USER_PREF_APP_TYPES = Object.freeze(["core", "ims", "task"]);

export const USER_PREF_KEYS = Object.freeze({
  TASK_CL_TASK_DEFAULTS: "cl_task.defaults",
});

export const CL_TASK_DEFAULTS_PREF = {
  app_type: "task",
  pref_key: USER_PREF_KEYS.TASK_CL_TASK_DEFAULTS,
};
