// src/routes/connectwise.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const { log, error } = require("../utils/logger");
const { createIncident, updateIncident, getIncidentByKey } = require("../services/pagerdutyService");
const { getTicketDescription } = require("../services/connectwiseService");

const CW_URL = process.env.CW_SITE_URL;
const COMPANY = process.env.CW_COMPANY_ID;
const PUBLIC_KEY = process.env.CW_PUBLIC_KEY;
const PRIVATE_KEY = process.env.CW_PRIVATE_KEY;
const CLIENT_ID = process.env.CW_CLIENT_ID;
const allowedBoards = ["Technical Support", "Security Operations Center", "Alerts"];

const authHeader =
  "Basic " + Buffer.from(`${COMPANY}+${PUBLIC_KEY}:${PRIVATE_KEY}`).toString("base64");

const baseHeaders = {
  Authorization: authHeader,
  "Content-Type": "application/json",
  Accept: "application/json",
  clientId: CLIENT_ID,
};

// ---- CONNECTWISE Webhook Handler -----
router.post("/webhook", async (req, res) => {
  try {
    log("📩 CW Webhook Received:", JSON.stringify(req.body, null, 2));

    let ticket = req.body.instance || req.body.entity || req.body.Entity;
    if (typeof ticket === "string") ticket = JSON.parse(ticket);

    const type = (req.body.type || req.body.Type || "").toLowerCase();
    const event = req.body.event || req.body.action || req.body.Action;

    if (type !== "ticket") return res.status(200).json({ message: "Ignored non-ticket webhook" });
    if (!ticket || !ticket.id) return res.status(400).json({ message: "Missing ticket object or ID" });

    // --- Check Board Filter ---
    if (!allowedBoards.includes(ticket.board?.name)) {
      log(`⏩ Skipped Ticket #${ticket.id}: board "${ticket.board?.name}" not allowed`);
      return res.status(200).json({ message: "Board not allowed" });
    }

    // --- Get Ticket Description ---
    const description = await getTicketDescription(ticket.id);
    if (description) ticket.description = description;

    const status = (ticket.status?.name || "").trim();

    // --- Define Status Mapping ---
    const TRIGGER_STATUSES = [
      "New",
      "Re-Opened",
      "Detection: Waiting IRT Assignment",
      "Detection: Augmentt",
      "Detection: Nodeware",
      "New (email connector)",
      "New (Portal)",
      "New (Chat)",
    ];

    const RESOLVE_STATUSES = [
      "Cancelled",
      "Cancelled: Duplicate",
      "Cancelled: Child Ticket",
      "Cancelled: Self Resolved",
      "Completed: Resolved",
      "Completed: No Reply (Client)",
      "Completed: Do Not Notify",
      "Returned To Normal",
      "Completed: Marked by Client",
      "Completed: No Response",
      "Chat Abandoned",
    ];

    const incidentKey = `CW-${ticket.id}`;
    let existingIncident = await getIncidentByKey(incidentKey);

    if (!existingIncident) {
      log(`🕵️ No incident found initially for ${incidentKey}. Verifying once more after delay...`);

      // Wait 2 seconds to let PagerDuty register before checking again
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Final check to prevent duplicates
      existingIncident = await getIncidentByKey(incidentKey);
    }

    if (!existingIncident) {
      // Still not found → Create a new incident (safe)
      const newIncident = await createIncident(ticket);
      existingIncident = newIncident;
      log(`Created NEW PagerDuty incident for Ticket #${ticket.id} → Incident ID: ${newIncident.id}`);
    } else {
      // --- Existing PD Incident Found ---
      const pdStatus = existingIncident.status; // 'triggered', 'acknowledged', 'resolved'
      log(`🔍 Existing PagerDuty incident found (${existingIncident.id}) with status: ${pdStatus}`);

      // --- CW Ticket Status Handling ---
      if (TRIGGER_STATUSES.includes(status)) {
        if (pdStatus === "resolved") {
          // Can't reopen a resolved PD incident → Create a new one
          const newIncident = await createIncident(ticket);
          log(`Existing incident was resolved. Created NEW incident ${newIncident.id}`);
        } else {
          log(` Ticket #${ticket.id} already active in PagerDuty (status: ${pdStatus})`);
        }

      } else if (RESOLVE_STATUSES.includes(status)) {
        if (pdStatus !== "resolved") {
          await updateIncident(existingIncident.id, "resolved");
          log(`Ticket #${ticket.id} → PagerDuty status updated to RESOLVED`);
        } else {
          log(`Ticket #${ticket.id} already resolved in PagerDuty`);
        }

      } else {
        log(`Ticket #${ticket.id} → CW Status "${status}" has no PagerDuty mapping`);
      }
    }

    res.status(200).json({ message: "CW Webhook processed", status, ticket });
  } catch (err) {
    error(" Error processing CW webhook", err);
    res.status(500).json({ message: "Error creating/updating PagerDuty incident", error: err.message });
  }
});

module.exports = router;
