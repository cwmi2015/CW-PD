// services/connectwiseService.js
const axios = require("axios");
const { log, error } = require("../utils/logger");

const CW_URL = process.env.CW_SITE_URL;
const COMPANY = process.env.CW_COMPANY_ID;
const PUBLIC_KEY = process.env.CW_PUBLIC_KEY;
const PRIVATE_KEY = process.env.CW_PRIVATE_KEY;
const CLIENT_ID = process.env.CW_CLIENT_ID;

const authHeader =
  "Basic " + Buffer.from(`${COMPANY}+${PUBLIC_KEY}:${PRIVATE_KEY}`).toString("base64");

const baseHeaders = {
  Authorization: authHeader,
  "Content-Type": "application/json",
  Accept: "application/json",
  clientId: CLIENT_ID,
};

// ----------------------
// Helper: Get company by name
// ----------------------
async function getCompanyByName(name) {
  try {
    const res = await axios.get(
      `${CW_URL}/v4_6_release/apis/3.0/company/companies?conditions=name="${name}"`,
      { headers: baseHeaders }
    );
    return res.data?.[0];
  } catch (err) {
    error("Failed to fetch company by name", err.message);
    return null;
  }
}

// ----------------------
// Create Ticket
// ----------------------
exports.createTicket = async (data) => {
  try {
    // 🔹 Find company ID if only name was given
    let companyObj = data.company;
    if (typeof companyObj === "string") {
      const company = await getCompanyByName(companyObj);
      if (!company) {
        throw new Error(`Company "${companyObj}" not found in ConnectWise`);
      }
      companyObj = { id: company.id, name: company.name };
    }

    const payload = {
      summary: data.summary,
      company: companyObj,
      status: { name: "New" },
      priority: { name: data.priority || "Medium" },
      initialDescription: data.description || "Created via integration",
      board: { name: data.board || "Service Desk" },
    };

    const res = await axios.post(
      `https://na.myconnectwise.net/v2025_1/apis/3.0/service/tickets`,
      payload,
      { headers: baseHeaders }
    );

    log("Created ticket in ConnectWise", res.data);
    return res.data;
  } catch (err) {
    const msg = err.response?.data || err.message;
    error("Failed to create ConnectWise ticket", msg);
    throw err;
  }
};

// ----------------------
// Update Ticket
// ----------------------
exports.updateTicket = async (ticketId, updates) => {
  try {
    const res = await axios.patch(
      `https://na.myconnectwise.net/v2025_1/apis/3.0/service/tickets/${ticketId}`,
      updates,
      { headers: baseHeaders }
    );

    log(`Updated ticket #${ticketId} in ConnectWise`, res.data);
    return res.data;
  } catch (err) {
    const msg = err.response?.data || err.message;
    error(`Failed to update ticket #${ticketId}`, msg);
    throw err;
  }
};


exports.addTicketNote = async (ticketId, text, type = "Resolution") => {
  try {
    const payload = {
      text,
      detailDescriptionFlag: false,
      internalAnalysisFlag: false,
      resolutionFlag: false,
    };

    // --- Correct flag mapping ---
    if (type.toLowerCase() === "resolution") payload.resolutionFlag = true;
    else if (type.toLowerCase() === "internal") payload.internalAnalysisFlag = true;
    else payload.detailDescriptionFlag = true;

    // ✅ Use your working static URL pattern
    const url = `https://na.myconnectwise.net/v2025_1/apis/3.0/service/tickets/${ticketId}/notes`;

    // ✅ EXACT headers from your cURL
    const headers = {
      "Authorization": "Basic bGJ0K3pBVTU2Z3N1azJkZW9ORTA6emJHNlNiZXJlcGlKcGpuQw==",
      "Content-Type": "application/json",
      "clientId": "83c1f52b-2fda-4d71-a910-2494d76beec6",
    };

    const res = await axios.post(url, payload, { headers });

    log(`🗒️ Added "${type}" note to Ticket #${ticketId}`);
    return res.data;
  } catch (err) {
    const msg = err.response?.data || err.message;
    error(`❌ Failed to add note to Ticket #${ticketId}`, msg);
    throw err;
  }
};

// ----------------------
// Get Ticket Initial Description
// ----------------------
exports.getTicketDescription = async (ticketId) => {
  try {
    const notesUrl = `https://na.myconnectwise.net/v2025_1/apis/3.0/service/tickets/${ticketId}/notes`;
    const res = await axios.get(notesUrl, { headers: baseHeaders });

    // Find note with "detailDescriptionFlag" = true → this is the Initial Description
    const note = res.data.find((n) => n.detailDescriptionFlag === true);

    if (note) {
      log(`Fetched Initial Description for Ticket #${ticketId}`, note.text);
      return note.text;
    }

    log(`No Initial Description found for Ticket #${ticketId}`);
    return null;
  } catch (err) {
    const msg = err.response?.data || err.message;
    error(`Failed to fetch notes for Ticket #${ticketId}`, msg);
    return null;
  }
};
