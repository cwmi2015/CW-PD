// connectwise.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const { log, error } = require("../utils/logger");
const {
  createIncident,
  updateIncident,
  getIncidentByKey,
  retriggerIncident,
} = require("../services/pagerdutyService");
const {
  getTicketDescription,
} = require("../services/connectwiseService");

const CW_URL = process.env.CW_SITE_URL;
const COMPANY = process.env.CW_COMPANY_ID;
const PUBLIC_KEY = process.env.CW_PUBLIC_KEY;
const PRIVATE_KEY = process.env.CW_PRIVATE_KEY;
const CLIENT_ID = process.env.CW_CLIENT_ID;

const allowedBoards = [
  "Technical Support",
  "Security Operations Center",
  "Alerts",
];

const authHeader =
  "Basic " +
  Buffer.from(`${COMPANY}+${PUBLIC_KEY}:${PRIVATE_KEY}`).toString("base64");

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

    if (typeof ticket === "string") {
      ticket = JSON.parse(ticket);
    }

    const type = (
      req.body.type ||
      req.body.Type ||
      ""
    ).toLowerCase();

    const event = req.body.event || req.body.action || req.body.Action;

    if (type !== "ticket") {
      return res.status(200).json({
        message: "Ignored non-ticket webhook",
      });
    }

    if (!ticket || !ticket.id) {
      return res.status(200).json({
        message: "Missing ticket object or ID",
      });
    }

    // --- Check Board Filter ---
    if (!allowedBoards.includes(ticket.board?.name)) {
      log(
        `⏩ Skipped Ticket #${ticket.id}: board "${ticket.board?.name}" not allowed`
      );

      return res.status(200).json({
        message: "Board not allowed",
      });
    }

    // --- Get Ticket Description ---
    const description = await getTicketDescription(ticket.id);

    if (description) {
      ticket.description = description;
    }

    const status = (ticket.status?.name || "").trim();

    // ConnectWise can format the same status as "Reopened",
    // "Re-Opened", or "Re opened" depending on the source.
    const normalizeStatus = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

    // --- Define Status Mapping ---
    const TRIGGER_STATUSES = new Set([
      "new",
      "reopened",
      "detectionwaitingirtassignment",
      "detectionaugmentt",
      "detectionnodeware",
      "newemailconnector",
      "newportal",
      "newchat",
    ]);

    const normalizedStatus = normalizeStatus(status);

    const isClosedStatus =
      normalizedStatus.includes("cancel") ||
      normalizedStatus.includes("close") ||
      normalizedStatus.includes("complete") ||
      normalizedStatus === "returnedtonormal";

    const isChatAbandoned = normalizedStatus === "chatabandoned";

    const incidentKey = `CW-${ticket.id}`;

    let existingIncident = await getIncidentByKey(incidentKey);

    if (!existingIncident) {
      log(
        `🕵️ No incident found initially for ${incidentKey}. Verifying once more after delay...`
      );

      // Wait 2 seconds to let PagerDuty register before checking again.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Final check to prevent duplicates.
      existingIncident = await getIncidentByKey(incidentKey);
    }

    if (!existingIncident) {
      // Still not found, so create a new incident.
      const newIncident = await createIncident(ticket);

      // Some tickets are intentionally skipped by PagerDuty rules,
      // such as unsupported priorities or Technical Support summaries.
      if (!newIncident) {
        log(`No PagerDuty incident created for Ticket #${ticket.id}`);

        return res.status(200).json({
          message: "CW Webhook processed without PagerDuty incident",
          status,
          ticket,
        });
      }

      existingIncident = newIncident;

      log(
        `Created NEW PagerDuty incident for Ticket #${ticket.id} → Incident ID: ${newIncident.id}`
      );
    } else {
      // --- Existing PagerDuty Incident Found ---
      const pdStatus = existingIncident.status;

      log(
        `🔍 Existing PagerDuty incident found (${existingIncident.id}) with status: ${pdStatus}`
      );

      // --- CW Ticket Status Handling ---
      // Re-trigger the existing PagerDuty incident when the
      // ConnectWise ticket is new or reopened.
      if (TRIGGER_STATUSES.has(normalizedStatus)) {
        if (pdStatus === "resolved" || pdStatus === "acknowledged") {
          await retriggerIncident(existingIncident.id);

          log(
            `🔁 Ticket #${ticket.id} Re-Opened → PagerDuty incident ${existingIncident.id} re-triggered`
          );
        } else {
          log(
            `✅ Ticket #${ticket.id} already active in PagerDuty (status: ${pdStatus})`
          );
        }
      } else if (isClosedStatus || isChatAbandoned) {
        if (pdStatus !== "resolved") {
          await updateIncident(existingIncident.id, "resolved");

          log(
            `Ticket #${ticket.id} → PagerDuty status updated to RESOLVED`
          );
        } else {
          log(
            `Ticket #${ticket.id} already resolved in PagerDuty`
          );
        }
      } else {
        log(
          `Ticket #${ticket.id} → CW Status "${status}" has no PagerDuty mapping`
        );
      }
    }

    return res.status(200).json({
      message: "CW Webhook processed",
      status,
      ticket,
    });
  } catch (err) {
    error("Error processing CW webhook", err);

    return res.status(500).json({
      message: "Error creating/updating PagerDuty incident",
      error: err.message,
    });
  }
});

module.exports = router;
