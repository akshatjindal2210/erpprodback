import packageJson from "../../package.json" with { type: "json" };

/** API / health version. Keep in sync with release tags. */
export const APP_VERSION = packageJson.version;
