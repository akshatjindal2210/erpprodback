import { createGroupMasterControllers } from "../../../../ims/lib/utils/master/createGroupMasterControllers.js";
import { PRODUCTION_GROUP_NAME } from "../../../lib/config/groupFilter.js";

export const { getItems, getItemById, getItemsViews } = createGroupMasterControllers({
  groupName: PRODUCTION_GROUP_NAME,
});
