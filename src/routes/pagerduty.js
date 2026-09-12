// pagerduty.js
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const router = express.Router();
const { log, error } = require("../utils/logger");
const { getIncidentLogEntries } = require("../services/pagerdutyService");
const { updateTicket, addTicketNote, getTicket } = require("../services/connectwiseService");
const { isSyntheticResolution } = require("../services/pagerdutyTransitionGuard");

let lastWebhookEvent = null;

const RESPONDER_REPLY_EVENT_TYPES = new Set([
  "incident.responder.replied",
  "responder.replied",
  "incident.responder_request_replied",
  "responder_request_replied",
]);

const ACCEPTED_RESPONDER_REPLIES = new Set(["accept", "accepted"]);

function normalizeWebhookValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function getReferenceLabel(reference) {
  if (!reference) return "unknown";
  if (typeof reference === "string") return reference;
  return reference.summary || reference.name || reference.id || reference.type || "unknown";
}

function getPagerDutyChannelType(channel) {
  if (!channel) return "not listed";
  if (typeof channel === "string") return channel;
  return channel.type || channel.name || "not listed";
}

function getLogEntrySummary(entry) {
  const summary =
    entry?.summary ||
    entry?.event_details?.description ||
    entry?.details?.description ||
    "";

  return String(summary).replace(/\s+/g, " ").trim().slice(0, 300);
}

function getPagerDutyEventContext(event, data) {
  const actor =
    event?.agent ||
    data?.agent ||
    data?.acted_by ||
    data?.user ||
    data?.responder_request?.requester ||
    null;

  const channel =
    event?.channel ||
    data?.channel ||
    data?.notification?.channel ||
    data?.responder_request?.channel ||
    null;

  const channelType = getPagerDutyChannelType(channel);

  return {
    actor: getReferenceLabel(actor),
    actorType: actor?.type || "unknown",
    channel: getReferenceLabel(channel),
    channelType:
      channelType !== "not listed"
        ? channelType
        : data?.channel_type || "not included in webhook",
  };
}

async function logRecentPagerDutyChannels(incidentId, eventType) {
  if (!incidentId) return;

  const entries = await getIncidentLogEntries(incidentId, 10);

  const recentEntries = entries.slice(0, 10).map(entry => ({
    type: entry.type || "unknown",
    channelType: getPagerDutyChannelType(entry.channel),
    agent: getReferenceLabel(entry.agent),
    createdAt: entry.created_at || "unknown",
    summary: getLogEntrySummary(entry),
  }));

  const notifications = recentEntries.filter(entry =>
    /notify|notification|notified/i.test(`${entry.type} ${entry.summary}`)
  );

  const escalations = recentEntries.filter(entry =>
    /escalat/i.test(`${entry.type} ${entry.summary}`)
  );

  log(`PagerDuty activity after ${eventType} for incident ${incidentId}`, {
    notifications,
    escalations,
    recentEntries,
  });
}

function isAcceptedResponderReply(eventType, data) {
  if (!RESPONDER_REPLY_EVENT_TYPES.has(String(eventType || "").toLowerCase())) {
    return false;
  }

  const replyValues = [];

  const collectReplyValues = (value, key = "", insideReplyField = false) => {
    const isReplyField =
      insideReplyField ||
      /(response|reply|answer|action|choice|decision|status|state)/i.test(key);

    if (Array.isArray(value)) {
      value.forEach(item => collectReplyValues(item, key, isReplyField));
      return;
    }

    if (!value || typeof value !== "object") {
      if (isReplyField) {
        replyValues.push(value);
      }
      return;
    }

    Object.entries(value).forEach(([childKey, childValue]) => {
      collectReplyValues(childValue, childKey, isReplyField);
    });
  };

  collectReplyValues(data);

  return replyValues.some(value =>
    ACCEPTED_RESPONDER_REPLIES.has(normalizeWebhookValue(value))
  );
}

function getTicketIdFromIncident(incident, data) {
  const incidentKey =
    incident?.incident_key ||
    data?.incident_key ||
    data?.responder_request?.incident_key ||
    data?.responder_request?.incident?.incident_key;

  const keyMatch = String(incidentKey || "").match(
    /(?:^|[^A-Z0-9])CW-(\d+)(?:$|[^0-9])/i
  );

  if (keyMatch) return keyMatch[1];

  const titleMatch = String(incident?.title || "").match(/#(\d+)/);
  return titleMatch ? titleMatch[1] : null;
}

async function getFullPagerDutyIncident(incident) {
  if (
    !incident?.id ||
    (incident.service?.id && incident.title && incident.incident_key)
  ) {
    return incident;
  }

  try {
    const res = await axios.get(
      `${process.env.PD_API_URL || "https://api.pagerduty.com"}/incidents/${incident.id}`,
      {
        headers: {
          Authorization: `Token token=${process.env.PD_API_KEY}`,
          Accept: "application/vnd.pagerduty+json;version=2",
          "Content-Type": "application/json",
        },
      }
    );

    const fullIncident = res.data?.incident;

    if (fullIncident) {
      log(`Fetched full PagerDuty incident details for ${incident.id}`);
      return { ...incident, ...fullIncident };
    }
  } catch (err) {
    error(`Failed to fetch full PagerDuty incident ${incident?.id}`, err.message);
  }

  return incident;
}

function verifyPagerDutySignature(req, secret) {
  try {
    const signatureHeader = req.get("X-PagerDuty-Signature");

    if (!signatureHeader) return false;

    const rawBody = req.body;
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

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const rawBody = req.body;
      const body = JSON.parse(rawBody.toString("utf8"));

      lastWebhookEvent = body;

      const event = body.event;

      if (!event || !event.data) {
        return res
          .status(200)
          .json({ message: "Invalid PagerDuty v3 payload" });
      }

      const data = event.data;
      const eventType = event.event_type;
      let incident = data.incident || data;

      const eventContext = getPagerDutyEventContext(event, data);

      log(
        `PagerDuty event ${eventType || "unknown"} ` +
          `(id=${event.id || "unknown"}, occurred=${event.occurred_at || "unknown"}): ` +
          `actor=${eventContext.actor} (${eventContext.actorType}), ` +
          `channel=${eventContext.channel} (${eventContext.channelType})`
      );

      if (eventType === "incident.escalated") {
        log(
          `PagerDuty escalation event received for incident ${
            incident?.id || "unknown"
          }`
        );
      }

      if (eventType === "incident.acknowledged") {
        log(
          `PagerDuty acknowledgment event received for incident ${
            incident?.id || "unknown"
          }`
        );
      }

      if (
        RESPONDER_REPLY_EVENT_TYPES.has(
          String(eventType || "").toLowerCase()
        )
      ) {
        incident = await getFullPagerDutyIncident(incident);
      }

      if (eventType === "incident.annotated") {
        const noteText =
          incident?.event_details?.description ||
          incident?.summary ||
          "Annotation added in PagerDuty";

        const ticketId = getTicketIdFromIncident(incident, data);

        if (ticketId) {
          await addTicketNote(ticketId, noteText, "Detail");
          log(
            `Added PagerDuty annotation to ConnectWise Ticket #${ticketId}: ${noteText}`
          );
        } else {
          log("Skipped annotation event — no ticket ID found");
        }

        return res.status(200).json({ message: "Annotation handled" });
      }

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
        log(
          `Skipping PagerDuty event "${eventType}" — no service info`
        );

        return res
          .status(200)
          .json({ message: "Event skipped (no service info)" });
      }

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

        return res
          .status(200)
          .json({ message: `Unknown service: ${serviceName}` });
      }

      if (!verifyPagerDutySignature(req, secret)) {
        error(`PagerDuty signature verification failed for service: ${serviceName}`);

        return res.status(200).json({ message: "Invalid signature" });
      }

      const ticketId = getTicketIdFromIncident(incident, data);

      if (!ticketId) {
        log("No ConnectWise ticket ID found in incident title");

        return res
          .status(200)
          .json({ message: "No ConnectWise ticket ID found" });
      }

      log(
        `Matched PagerDuty incident → ConnectWise Ticket #${ticketId} ` +
          `(Service: ${serviceName})`
      );

      await logRecentPagerDutyChannels(incident.id, eventType);

      if (
        eventType === "incident.resolved" &&
        isSyntheticResolution(incident.id)
      ) {
        log(
          `Ignored temporary PagerDuty resolution for incident ${incident.id} ` +
            `during ConnectWise ticket #${ticketId} re-trigger`
        );

        return res
          .status(200)
          .json({ message: "Temporary resolution ignored" });
      }

      let statusUpdate = null;

      if (eventType === "incident.resolved") {
        const cwTicket = await getTicket(ticketId);
        const cwStatus = (cwTicket.status?.name || "").toLowerCase();

        const isClosedInCW =
          cwStatus.includes("cancel") ||
          cwStatus.includes("close") ||
          cwStatus.includes("complete");

        const isChatAbandoned = cwStatus === "chat abandoned";

        if (isClosedInCW && !isChatAbandoned) {
          log(
            `CW ticket #${ticketId} already closed (${cwStatus}) ` +
              "→ skipping status update"
          );
        } else {
          statusUpdate = "Returned To Normal";
          log(
            `PagerDuty resolved → updating CW ticket #${ticketId} ` +
              "to Returned To Normal"
          );
        }
      }

      if (eventType === "incident.acknowledged") {
        statusUpdate = "Acknowledged";
      }

      if (isAcceptedResponderReply(eventType, data)) {
        statusUpdate = "Acknowledged";

        log(
          `PagerDuty responder accepted the request for incident ${incident.id} ` +
            `→ updating ConnectWise Ticket #${ticketId} to Acknowledged`
        );
      } else if (
        RESPONDER_REPLY_EVENT_TYPES.has(
          String(eventType || "").toLowerCase()
        )
      ) {
        log(
          `PagerDuty responder reply for incident ${incident.id} ` +
            `was not an accepted response → leaving ConnectWise Ticket #${ticketId} unchanged`
        );
      }

      let priorityUpdate = null;
      const pdPriorityId = incident.priority?.id;

      const isResponderReplyEvent = RESPONDER_REPLY_EVENT_TYPES.has(
        String(eventType || "").toLowerCase()
      );

      if (pdPriorityId && !isResponderReplyEvent) {
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

          log(`Updating priority → ${priorityUpdate}`);
        }
      }

      if (updates.length > 0) {
        await updateTicket(ticketId, updates);
        log(`Updated ConnectWise Ticket #${ticketId}`);
      }

      if (eventType === "incident.resolved") {
        let resolutionNote = "Resolved in PagerDuty";

        try {
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
            const resolutionEntry = notes.find(note =>
              note.content?.trim().startsWith("Resolution Note:")
            );

            if (resolutionEntry) {
              resolutionNote = resolutionEntry.content
                .replace(/^Resolution Note:\s*/i, "")
                .trim();

              log(`Found Resolution Note in PagerDuty: ${resolutionNote}`);
            } else {
              const latestNote = notes[notes.length - 1].content?.trim();
              resolutionNote = latestNote || resolutionNote;
              log("No Resolution Note found — using latest note instead.");
            }
          } else {
            log("No notes found for PagerDuty incident — using fallback text.");
          }
        } catch (err) {
          log(`Error fetching PagerDuty notes: ${err.message}`);
        }

        await addTicketNote(ticketId, resolutionNote, "Resolution");

        log(
          `Added resolution note to ConnectWise Ticket #${ticketId}: ` +
            resolutionNote
        );
      }

      return res
        .status(200)
        .json({ message: "PagerDuty v3 webhook processed successfully" });
    } catch (err) {
      error("Error handling PagerDuty webhook:", err);

      return res.status(500).json({
        message: "Internal Server Error",
      });
    }
  }
);

router.get("/last-event", (req, res) => {
  if (!lastWebhookEvent) {
    return res.status(404).json({ message: "No webhook event received yet" });
  }

  res.json(lastWebhookEvent);
});

module.exports = router;
