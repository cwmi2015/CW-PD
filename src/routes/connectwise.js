// connectwise.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const crypto = require("crypto");
const { log, error } = require("../utils/logger");
const {
  createIncident,
  updateIncident,
  getIncidentByKey,
  retriggerIncident,
} = require("../services/pagerdutyService");
const { getTicketDescription } = require("../services/connectwiseService");
const {
  markSyntheticResolution,
  clearSyntheticResolution,
} = require("../services/pagerdutyTransitionGuard");

const CW_URL = process.env.CW_SITE_URL;
const COMPANY = process.env.CW_COMPANY_ID;
const PUBLIC_KEY = process.env.CW_PUBLIC_KEY;
const PRIVATE_KEY = process.env.CW_PRIVATE_KEY;
const CLIENT_ID = process.env.CW_CLIENT_ID;
const allowedBoards = ["Technical Support", "Security Operations Center", "Alerts"];
const lastObservedStatus = new Map();
// Temporary process-local dedupe for duplicate deliveries of the same CW event.
// This is deliberately event-based, so a later genuine Acknowledged -> Re-Opened
// transition is still allowed. Replace with persistent storage for production.
const recentWebhookEvents = new Map();
const WEBHOOK_DEDUPE_TTL_MS = 10 * 60 * 1000;

const authHeader =
  "Basic " + Buffer.from(`${COMPANY}+${PUBLIC_KEY}:${PRIVATE_KEY}`).toString("base64");

const baseHeaders = {
  Authorization: authHeader,
  "Content-Type": "application/json",
  Accept: "application/json",
  clientId: CLIENT_ID,
};

const normalizeStatus = value =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function getWebhookFingerprint(req, ticket, status, event) {
  const body = req.body || {};
  const providerEventId =
    body.webhookId ||
    body.webhook_id ||
    body.eventId ||
    body.event_id ||
    body.messageId ||
    body.message_id;

  if (providerEventId) {
    return `provider-event:${providerEventId}`;
  }

  const lastUpdated =
    ticket._info?.lastUpdated ||
    ticket.lastUpdated ||
    body.lastUpdated ||
    body.updatedAt ||
    body.updated_at;

  if (lastUpdated) {
    return [
      `ticket:${ticket.id}`,
      `status:${normalizeStatus(status)}`,
      `updated:${lastUpdated}`,
      `event:${String(event || "").toLowerCase()}`,
    ].join("|");
  }

  // Some CW webhook payloads do not include an update timestamp. Hash the
  // complete payload so an exact retry is still recognized as a duplicate.
  return `payload:${crypto
    .createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex")}`;
}

function claimWebhookEvent(fingerprint) {
  const now = Date.now();

  for (const [key, claimedAt] of recentWebhookEvents) {
    if (now - claimedAt >= WEBHOOK_DEDUPE_TTL_MS) {
      recentWebhookEvents.delete(key);
    }
  }

  if (recentWebhookEvents.has(fingerprint)) return false;
  recentWebhookEvents.set(fingerprint, now);
  return true;
}

// ---- CONNECTWISE Webhook Handler -----
router.post("/webhook", async (req, res) => {
  let claimedWebhookFingerprint = null;

  try {
    log("📩 CW Webhook Received:", JSON.stringify(req.body, null, 2));

    let ticket = req.body.instance || req.body.entity || req.body.Entity;
    if (typeof ticket === "string") ticket = JSON.parse(ticket);

    const type = (req.body.type || req.body.Type || "").toLowerCase();
    const event = req.body.event || req.body.action || req.body.Action;

    if (type !== "ticket") return res.status(200).json({ message: "Ignored non-ticket webhook" });
    if (!ticket || !ticket.id) return res.status(200).json({ message: "Missing ticket object or ID" });

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
    // ConnectWise can format the same status as "Reopened", "Re-Opened",
    // or "Re opened" depending on the source of the update.
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
    const webhookFingerprint = getWebhookFingerprint(req, ticket, status, event);
    if (!claimWebhookEvent(webhookFingerprint)) {
      log(
        `⏭️ Duplicate CW webhook ignored for Ticket #${ticket.id} ` +
          `(status="${status}", event=${event || "unknown"}, ` +
          `fingerprint=${webhookFingerprint})`
      );
      return res.status(200).json({ message: "Duplicate CW webhook ignored", status, ticket });
    }
    claimedWebhookFingerprint = webhookFingerprint;

    const previousNormalizedStatus = lastObservedStatus.get(String(ticket.id));
    lastObservedStatus.set(String(ticket.id), normalizedStatus);
    log(
      `🧭 CW Ticket #${ticket.id} status transition: ` +
        `${previousNormalizedStatus || "unknown"} → ${normalizedStatus || "unknown"} ` +
        `(displayed as "${status || "unknown"}", event=${event || "unknown"})`
    );

    if (normalizedStatus === "esc" || normalizedStatus.includes("escalat")) {
      log(
        `🚨 CW Ticket #${ticket.id} has ESC/escalated status ` +
          `(displayed as "${status}")`
      );
    }
    const isClosedStatus =
      normalizedStatus.includes("cancel") ||
      normalizedStatus.includes("close") ||
      normalizedStatus.includes("complete") ||
      normalizedStatus === "returnedtonormal";

    const isChatAbandoned = normalizedStatus === "chatabandoned";
    const isTerminalStatus = isClosedStatus || isChatAbandoned;

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
      // A reopen must only notify an existing incident. Never create a new
      // PagerDuty incident when the original incident cannot be found.
      if (normalizedStatus === "reopened") {
        log(
          `⚠ No existing PagerDuty incident found for reopened Ticket #${ticket.id}; ` +
            "skipping to avoid creating a duplicate incident"
        );
        return res.status(200).json({
          message: "Reopened ticket has no matching PagerDuty incident",
          status,
          ticket,
        });
      }

      // Still not found → Create a new incident (safe)
      const newIncident = await createIncident(ticket);
      if (!newIncident) {
        log(`No PagerDuty incident created for Ticket #${ticket.id}`);
        return res.status(200).json({
          message: "CW Webhook processed without PagerDuty incident",
          status,
          ticket,
        });
      }
      existingIncident = newIncident;
      log(`Created NEW PagerDuty incident for Ticket #${ticket.id} → Incident ID: ${newIncident.id}`);
    } else {
      // --- Existing PD Incident Found ---
      const pdStatus = existingIncident.status; // 'triggered', 'acknowledged', 'resolved'
      log(`🔍 Existing PagerDuty incident found (${existingIncident.id}) with status: ${pdStatus}`);

      // --- CW Ticket Status Handling ---
      if (TRIGGER_STATUSES.has(normalizedStatus)) {
        const isReopened = normalizedStatus === "reopened";

        try {
          if (
            pdStatus === "resolved" &&
            (!isReopened || previousNormalizedStatus !== "reopened")
          ) {
            await retriggerIncident(existingIncident);
            log(`🔁 Ticket #${ticket.id} ${status} → PagerDuty incident ${existingIncident.id} re-triggered`);
          } else if (
            isReopened &&
            pdStatus === "acknowledged" &&
            previousNormalizedStatus !== "reopened"
          ) {
            // PagerDuty does not allow Acknowledged -> Triggered directly.
            // Resolve and immediately re-trigger the same incident instead.
            // Guard the temporary resolved webhook so it cannot change CW to RTN.
            const guardExpiresAt = markSyntheticResolution(existingIncident.id);
            log(
              `🔄 Reopen transition started for CW #${ticket.id}: ` +
                `PagerDuty ${existingIncident.id} is acknowledged; ` +
                `temporary resolution guard active until ${new Date(guardExpiresAt).toISOString()}`
            );
            try {
              await updateIncident(existingIncident.id, "resolved");
              log(
                `🔄 Temporary PagerDuty resolution completed for incident ${existingIncident.id}; ` +
                  "re-triggering the same incident"
              );
              await retriggerIncident(existingIncident);
              log(
                `✅ Reopen transition completed for CW #${ticket.id}: ` +
                  `same PagerDuty incident ${existingIncident.id} is triggered`
              );
            } catch (err) {
              clearSyntheticResolution(existingIncident.id);
              error(
                `❌ Reopen transition failed for CW #${ticket.id} / PagerDuty ${existingIncident.id}; ` +
                  "temporary guard cleared",
                err
              );
              throw err;
            }
          } else if (isReopened && previousNormalizedStatus === "reopened") {
            log(
              `⏭️ Ticket #${ticket.id} is still Re-Opened with no intervening CW status ` +
                "change → skipping duplicate PagerDuty re-trigger"
            );
          } else if (isReopened && pdStatus === "acknowledged") {
            log(
              `⏭️ Ticket #${ticket.id} Re-Opened event was already handled → ` +
                "skipping duplicate PagerDuty re-trigger"
            );
          } else {
            log(`✅ Ticket #${ticket.id} already active in PagerDuty (status: ${pdStatus})`);
          }
        } catch (err) {
          // Allow a later webhook to retry after a failed PagerDuty call.
          lastObservedStatus.delete(String(ticket.id));
          throw err;
        }
      } else if (isTerminalStatus) {
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
    if (claimedWebhookFingerprint) {
      recentWebhookEvents.delete(claimedWebhookFingerprint);
    }
    error(" Error processing CW webhook", err);
    res.status(500).json({ message: "Error creating/updating PagerDuty incident", error: err.message });
  }
});

module.exports = router;
