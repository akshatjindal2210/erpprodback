import { fetchImsDataRaw } from "../services/ims.service.js";

export const getSchedulePlanning = async (req, res) => {
  try {
    const result = await fetchImsDataRaw("pack");
    res.json(result);
  } catch (err) {
    console.error("[schedule-planning]", err);
    res.status(500).json({
      success: false,
      message: "Could not load schedule planning data.",
      records: [],
    });
  }
};
