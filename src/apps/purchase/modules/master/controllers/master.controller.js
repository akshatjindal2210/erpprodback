import { createGroupMasterControllers } from "../../../../ims/lib/utils/master/createGroupMasterControllers.js";
import { PURCHASE_GROUP_NAME } from "../../../lib/config/groupFilter.js";

export const { getItems, getItemById, getItemsViews } = createGroupMasterControllers({
  groupName: PURCHASE_GROUP_NAME,
});
