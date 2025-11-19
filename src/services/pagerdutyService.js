// src/services/pagerdutyService.js
const axios = require("axios");
const { log, error } = require("../utils/logger");
const incidentLock = new Set(); // Prevent race condition

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

// Create a new PagerDuty incident
exports.createIncident = async (ticket) => {
  const incidentKey = `CW-${ticket.id}`;

  // ⛔ Prevent race-condition duplicate creation
  if (incidentLock.has(incidentKey)) {
    log(`⏳ Waiting: Another process is creating incident for ${incidentKey}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  } else {
    incidentLock.add(incidentKey);
  }

  try {
    // 🛑 Check again after lock (avoid duplicate)
    let existing = await exports.getIncidentByKey(incidentKey);
    if (existing) {
      log(`⚠ Incident for ${incidentKey} already exists → ${existing.id}`);
      return existing;
    }

    // 🚀 Proceed with creation
    let serviceId;
    if (ticket.board?.name === "Technical Support") {
      const summary = ticket.summary || "";
      const allowedKeywords = [
        "via Critical",
        "via Non Critical",
        "via Technical Support",
      ];
      const containsAllowed = allowedKeywords.some(kw =>
        new RegExp(kw, "i").test(summary)
      );
      if (!containsAllowed) {
        log(`Skipped incident creation for Ticket #${ticket.id} — summary does not contain allowed keywords`);
        return null;
      }
      serviceId = process.env.PD_SERVICE_TS;
    } else if (ticket.board?.name === "Security Operations Center") {
      serviceId = process.env.PD_SERVICE_SOC;
    } else if (ticket.board?.name === "Alerts") {
      serviceId = process.env.PD_SERVICE_NOC;
    } else {
      throw new Error(`Ticket board "${ticket.board?.name}" is not mapped`);
    }

    // Priority handling...
    const priorityName = (ticket.priority?.name || "").toLowerCase();
    let priorityId = null;
    let urgency = "low";
    let priorityCode = null;

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
    } else {
      log(`Ticket #${ticket.id} skipped — priority "${ticket.priority?.name}" is NOT allowed for PagerDuty.`);
      return null; 
    }

    const summaryClean = (ticket.summary || "No summary").replace(/\s+/g, " ").trim();
    const title = `${priorityCode} | #${ticket.id} - ${summaryClean}`;

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
        incident_key: incidentKey, // 🔑 ensures uniqueness
      },
    };

    // 🛠 Create Incident
    const res = await axios.post(`${PD_API_URL}/incidents`, payload, { headers: pdHeaders });
    const incident = res.data?.incident;
    if (!incident) throw new Error("PagerDuty did not return incident object");

    log(`🎯 Created PagerDuty incident ${incident.id}`);

    if (ticket.description) {
      await axios.post(
        `${PD_API_URL}/incidents/${incident.id}/notes`,
        { note: { content: ticket.description } },
        { headers: pdHeaders }
      );
    }

    return incident;

  } catch (err) {
    error("🚨 Failed to create PagerDuty incident", err.response?.data || err.message);
    throw err;
  } finally {
    incidentLock.delete(incidentKey); // 🔓 Unlock
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


    log(`Updated PagerDuty incident ${incidentId} → ${status}`);
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
    const res = await axios.get(
      `${PD_API_URL}/incidents?incident_key=${incidentKey}&limit=1`,
      { headers: pdHeaders }
    );

    return res.data?.incidents?.[0] || null;
  } catch (err) {
    error(`Failed to fetch incident by key ${incidentKey}`, err.message);
    return null;
  }
};

