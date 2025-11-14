// src/services/pagerdutyService.js
const axios = require("axios");
const { log, error } = require("../utils/logger");

// Load from ENV ONLY (fix)
const PD_API_URL = process.env.PD_API_URL;
const PD_API_KEY = process.env.PD_API_KEY;

const pdHeaders = {
  Authorization: `Token token=${PD_API_KEY}`,
  Accept: "application/vnd.pagerduty+json;version=2",
  "Content-Type": "application/json",
  From: process.env.PD_USER_EMAIL,
};

// Validate ENV
if (!PD_API_KEY) throw new Error("❌ Missing PD_API_KEY");
if (!PD_API_URL) throw new Error("❌ Missing PD_API_URL");
if (!process.env.PD_SERVICE_TS) throw new Error("❌ Missing PD_SERVICE_TS");
if (!process.env.PD_USER_EMAIL) throw new Error("❌ Missing PD_USER_EMAIL");

// ----------------------------------------------
// Create a new PagerDuty incident
// ----------------------------------------------
exports.createIncident = async (ticket) => {
  try {
    let serviceId;

    if (ticket.board?.name === "Technical Support") serviceId = process.env.PD_SERVICE_TS;
    else if (ticket.board?.name === "Security Operations Center") serviceId = process.env.PD_SERVICE_SOC;
    else if (ticket.board?.name === "Alerts") serviceId = process.env.PD_SERVICE_NOC;
    else throw new Error(`Ticket board "${ticket.board?.name}" is not mapped`);

    const priorityName = (ticket.priority?.name || "").toLowerCase();
    let priorityId = process.env.PD_PRIORITY_P5;
    let urgency = "low";
    let priorityCode = "P5";

    if (["1a - emergency", "1b - emergency"].includes(priorityName)) {
      priorityId = process.env.PD_PRIORITY_P1;
      urgency = "high";
      priorityCode = "P1";
    } else if (["2a - critical", "2b - critical", "2c - critical"].includes(priorityName)) {
      priorityId = process.env.PD_PRIORITY_P2;
      urgency = "high";
      priorityCode = "P2";
    } else if (["3 - high"].includes(priorityName)) {
      priorityId = process.env.PD_PRIORITY_P3;
      urgency = "high";
      priorityCode = "P3";
    } else if (["4a - normal", "4b - normal", "4c - normal"].includes(priorityName)) {
      priorityId = process.env.PD_PRIORITY_P4;
      urgency = "low";
      priorityCode = "P4";
    }

    const summary = (ticket.summary || "No summary").replace(/\s+/g, " ").trim();
    const title = `${priorityCode} | #${ticket.id} - ${summary}`;

    const payload = {
      incident: {
        type: "incident",
        title,
        service: { id: serviceId, type: "service_reference" },
        urgency,
        priority: { id: priorityId, type: "priority_reference" },
        body: {
          type: "incident_body",
          details: ticket.description || ticket.summary || "No details provided.",
        },
        incident_key: `CW-${ticket.id}`,
      },
    };

    const res = await axios.post(`${PD_API_URL}/incidents`, payload, {
      headers: pdHeaders,
    });

    const incident = res.data?.incident;
    if (!incident) throw new Error("PagerDuty did not return incident object");

    log(`Created PagerDuty incident ${incident.id}`);

    if (ticket.description) {
      await axios.post(
        `${PD_API_URL}/incidents/${incident.id}/notes`,
        { note: { content: ticket.description } },
        { headers: { ...pdHeaders } }
      );
    }

    return incident;
  } catch (err) {
    error("Failed to create PagerDuty incident", err.response?.data || err.message);
    throw err;
  }
};

// Update PagerDuty incident (acknowledge / resolve)
exports.updateIncident = async (incidentId, status) => {
  try {
    const payload = {
      incident: { type: "incident", status },
    };

    const res = await axios.put(`${PD_API_URL}/incidents/${incidentId}`, payload, {
  headers: { 
    ...pdHeaders,
    From: process.env.PD_USER_EMAIL,
  },
});


    log(`🔄 Updated PagerDuty incident ${incidentId} → ${status}`);
    return res.data.incident;
  } catch (err) {
    const msg = err.response?.data || err.message;
    error(`Failed to update PagerDuty incident ${incidentId}`, msg);
    throw err;
  }
};

// Get PagerDuty Incident by Key (CW Ticket ID)
exports.getIncidentByKey = async (incidentKey) => {
  try {
    const res = await axios.get(`${PD_API_URL}/incidents?incident_key=${incidentKey}`, {
      headers: pdHeaders,
    });
    return res.data.incidents?.[0] || null;
  } catch (err) {
    error(`Failed to fetch incident by key ${incidentKey}`, err.message);
    return null;
  }
};
