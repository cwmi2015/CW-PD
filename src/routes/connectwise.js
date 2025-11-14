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

// -------------------------------------------
// Route: Manually sync a CW ticket to PagerDuty
// -------------------------------------------
router.get("/sync-ticket/:id", async (req, res) => {
  const ticketId = req.params.id;

  try {
    // Step 1️⃣: Fetch ticket from ConnectWise
    const cwResponse = await axios.get(
      `https://na.myconnectwise.net/v2025_1/apis/3.0/service/tickets/${ticketId}`,
      { headers: baseHeaders }
    );
    const ticket = cwResponse.data;

    if (!ticket) {
      return res.status(404).json({ message: `Ticket #${ticketId} not found in ConnectWise` });
    }

    log(`Fetched ConnectWise Ticket #${ticketId}`);

    // Step 2️⃣: Filter allowed boards
    if (!allowedBoards.includes(ticket.board?.name)) {
      log(`Ticket #${ticketId} skipped: board "${ticket.board?.name}" not allowed`);
      return res.status(200).json({
        message: `Ticket #${ticketId} skipped: board "${ticket.board?.name}" is not allowed`,
        ticket,
      });
    }

    // Step 3️⃣: Fetch Initial Description from Notes
    const description = await getTicketDescription(ticket.id);
    if (description) ticket.description = description;

    // Step 4️⃣: Trigger PagerDuty incident
    await createIncident(ticket);
    log(`Triggered PagerDuty incident for Ticket #${ticketId}`);

    res.status(200).json({
      message: `PagerDuty incident created for ConnectWise Ticket #${ticketId}`,
      ticket,
    });
  } catch (err) {
    const msg = err.response?.data || err.message;
    error(`Failed to sync Ticket #${ticketId} to PagerDuty`, msg);
    res.status(500).json({
      message: "Error syncing ConnectWise ticket to PagerDuty",
      error: msg,
    });
  }
});

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
      // If no PD incident exists yet, create one
      const newIncident = await createIncident(ticket);
      existingIncident = newIncident;
      log(`🚨 Created PagerDuty incident for new Ticket #${ticket.id}`);
    } else {
      // --- Check PD incident current status ---
      const pdStatus = existingIncident.status; // usually 'triggered', 'acknowledged', or 'resolved'
      log(`🔍 Existing PagerDuty incident ${existingIncident.id} status: ${pdStatus}`);

      if (TRIGGER_STATUSES.includes(status)) {
        if (pdStatus === "resolved") {
          // PagerDuty won't allow re-opening resolved incidents → create new one
          const newIncident = await createIncident(ticket);
          log(`🔁 Ticket #${ticket.id} was resolved — created NEW PagerDuty incident ${newIncident.id}`);
        } else {
          log(`ℹ️ Ticket #${ticket.id} already active in PagerDuty (status: ${pdStatus})`);
        }
      } else if (RESOLVE_STATUSES.includes(status)) {
        if (pdStatus !== "resolved") {
          await updateIncident(existingIncident.id, "resolved");
          log(`✅ Ticket #${ticket.id} → PagerDuty status set to RESOLVED`);
        } else {
          log(`ℹ️ Ticket #${ticket.id} already resolved in PagerDuty`);
        }
      } else {
        log(`ℹ️ Ticket #${ticket.id} → CW Status "${status}" has no PD mapping`);
      }
    }

    res.status(200).json({ message: "CW Webhook processed", status, ticket });
  } catch (err) {
    error("❌ Error processing CW webhook", err);
    res.status(500).json({ message: "Error creating/updating PagerDuty incident", error: err.message });
  }
});

module.exports = router;
