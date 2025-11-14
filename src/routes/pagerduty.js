const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const router = express.Router();
const { log, error } = require("../utils/logger");
const { updateTicket, addTicketNote } = require("../services/connectwiseService");

let lastWebhookEvent = null;

// --- Verify PagerDuty v3 Signature using service-specific secret ---
function verifyPagerDutySignature(req, secret) {
  try {
    const signatureHeader = req.get("X-PagerDuty-Signature");
    if (!signatureHeader) return false;

    const rawBody = req.body; // Buffer

    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(rawBody);
    const expectedSignature = `v1=${hmac.digest("hex")}`;

    return signatureHeader
      .split(",")
      .some(sig => sig.trim() === expectedSignature);
  } catch (err) {
    error("Signature verification error:", err);
    return false;
  }
}

// --- PAGERDUTY Webhook Handler ---
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const rawBody = req.body;
    const body = JSON.parse(rawBody.toString("utf8"));
    lastWebhookEvent = body;

    const event = body.event;
    if (!event || !event.data) {
      return res.status(400).json({ message: "Invalid PagerDuty v3 payload" });
    }

    const data = event.data;
    const eventType = event.event_type;
    const incident = data.incident || data; // handle both cases

    // --- 📝 Handle annotation events (notes added in PagerDuty UI) ---
    if (eventType === "incident.annotated") {
      const noteText =
        incident?.event_details?.description ||
        incident?.summary ||
        "Annotation added in PagerDuty";

      const match = incident.title?.match(/#(\d+)/);
      const ticketId = match ? match[1] : null;

      if (ticketId) {
        await addTicketNote(ticketId, noteText, "Detail");
        log(`🗒️ Added PagerDuty annotation to ConnectWise Ticket #${ticketId}: ${noteText}`);
      } else {
        log(`⚠️ Skipped annotation event — no ticket ID found`);
      }

      return res.status(200).json({ message: "Annotation handled" });
    }

    // --- Extract service info safely ---
    const serviceId =
      incident.service?.id ||
      data.service?.id ||
      incident.services?.[0]?.id ||
      null;
    const serviceName =
      incident.service?.summary ||
      data.service?.summary ||
      incident.services?.[0]?.summary ||
      "Unknown Service";

    log(`Received event from PagerDuty service: ${serviceName} (${serviceId})`);

    if (!serviceId) {
      log(`ℹ️ Skipping PagerDuty event "${eventType}" — no service info (likely annotation or system event)`);
      return res.status(200).json({ message: "Event skipped (no service info)" });
    }

    // --- Map service to PD secret ---
    let secret = null;
    if (
      serviceId === process.env.PD_SERVICE_TS ||
      serviceName === "Technical Support"
    ) {
      secret = process.env.PD_SECRET_TS;
    } else if (
      serviceId === process.env.PD_SERVICE_NOC ||
      serviceName === "Alerts"
    ) {
      secret = process.env.PD_SECRET_NOC;
    } else if (
      serviceId === process.env.PD_SERVICE_SOC ||
      serviceName === "Security Operations Center"
    ) {
      secret = process.env.PD_SECRET_SOC;
    } else {
      error(`Unknown PagerDuty service: ${serviceName} (${serviceId})`);
      return res.status(400).json({ message: `Unknown service: ${serviceName}` });
    }

    // --- Verify signature ---
    if (!verifyPagerDutySignature(req, secret)) {
      error(`PagerDuty signature verification failed for service: ${serviceName}`);
      return res.status(400).json({ message: "Invalid signature" });
    }

    // --- Extract ConnectWise Ticket ID ---
    const match = incident.title?.match(/#(\d+)/);
    const ticketId = match ? match[1] : null;
    if (!ticketId) {
      log(`No ConnectWise ticket ID found in incident title`);
      return res.status(200).json({ message: "No ConnectWise ticket ID found" });
    }

    log(`Matched PagerDuty incident → ConnectWise Ticket #${ticketId} (Service: ${serviceName})`);

    // --- Map PagerDuty → CW Status ---
    let statusUpdate = null;
    if (eventType === "incident.resolved") statusUpdate = "Returned To Normal";
    if (eventType === "incident.acknowledged") statusUpdate = "Acknowledged";

    // --- Map PD Priority → CW Priority ---
    let priorityUpdate = null;
    const pdPriorityId = incident.priority?.id;
    if (pdPriorityId) {
      switch (pdPriorityId) {
        case process.env.PD_PRIORITY_P1:
          priorityUpdate = "1a - Emergency";
          break;
        case process.env.PD_PRIORITY_P2:
          priorityUpdate = "2a - Critical";
          break;
        case process.env.PD_PRIORITY_P3:
          priorityUpdate = "3 - High";
          break;
        case process.env.PD_PRIORITY_P4:
          priorityUpdate = "4a - Normal";
          break;
        case process.env.PD_PRIORITY_P5:
          priorityUpdate = "10a - Maintenance";
          break;
      }
    }

    const updates = [];

    if (statusUpdate) {
      updates.push({
        op: "replace",
        path: "status",
        value: { name: statusUpdate },
      });
    }

    if (priorityUpdate) {
      const cwPriorityMap = {
        "1a - Emergency": 6,
        "2a - Critical": 15,
        "3 - High": 8,
        "4a - Normal": 7,
        "10a - Maintenance": 12,
      };

      const priorityId = cwPriorityMap[priorityUpdate];
      if (priorityId) {
        updates.push({
          op: "replace",
          path: "priority",
          value: { id: priorityId, name: priorityUpdate },
        });
        log(`🔄 Updating priority → ${priorityUpdate}`);
      }
    }

    // --- Apply updates to CW ticket ---
    if (updates.length > 0) {
      await updateTicket(ticketId, updates);
      log(`✅ Updated ConnectWise Ticket #${ticketId}`);
    }

    // --- Add resolution note if resolved ---
    if (eventType === "incident.resolved") {
      let resolutionNote = "Resolved in PagerDuty";

      try {
        // Fetch latest PagerDuty notes for the incident
        const notesRes = await axios.get(
          `https://api.pagerduty.com/incidents/${incident.id}/notes`,
          {
            headers: {
              Authorization: `Token token=${process.env.PD_API_KEY}`,
              Accept: "application/vnd.pagerduty+json;version=2",
              "Content-Type": "application/json",
            },
          }
        );

        const notes = notesRes.data?.notes || [];

        if (notes.length > 0) {
          // Find note that starts with "Resolution Note:"
          const resolutionEntry = notes.find(note =>
            note.content?.trim().startsWith("Resolution Note:")
          );

          if (resolutionEntry) {
            // Clean it up to remove the prefix
            resolutionNote = resolutionEntry.content
              .replace(/^Resolution Note:\s*/i, "")
              .trim();
            log(`✅ Found Resolution Note in PagerDuty: ${resolutionNote}`);
          } else {
            // If no "Resolution Note:" found, use the latest note as fallback
            const latestNote = notes[notes.length - 1].content?.trim();
            resolutionNote = latestNote || resolutionNote;
            log("⚠️ No 'Resolution Note:' found — using latest note instead.");
          }
        } else {
          log("⚠️ No notes found for PagerDuty incident — using fallback text.");
        }
      } catch (err) {
        log(`❌ Error fetching PagerDuty notes: ${err.message}`);
      }

      // Save only one resolution note to ConnectWise
      await addTicketNote(ticketId, resolutionNote, "Resolution");
      log(`📝 Added resolution note to ConnectWise Ticket #${ticketId}: ${resolutionNote}`);
    }

    res.status(200).json({ message: "PagerDuty v3 webhook processed successfully" });
  } catch (err) {
    error("❌ Error handling PagerDuty webhook:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});



// --- Debug route ---
router.get("/last-event", (req, res) => {
  if (!lastWebhookEvent)
    return res.status(404).json({ message: "No webhook event received yet" });
  res.json(lastWebhookEvent);
});

module.exports = router;
