// server.js
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const bodyParser = require("body-parser");

const connectwiseRoutes = require("./src/routes/connectwise");
const pagerdutyRoutes = require("./src/routes/pagerduty");

const app = express();

// Capture raw body for signature verification
app.use(
  "/pagerduty/webhook",
  bodyParser.raw({
    type: [
      "application/json",
      "application/vnd.pagerduty+json",
      "application/vnd.pagerduty+json;version=3",
    ],
  })
);

// Normal JSON parsing for all other routes
app.use(express.json());
app.use(morgan("dev"));

// Mount routes
app.use("/connectwise", connectwiseRoutes);
app.use("/pagerduty", pagerdutyRoutes);

// Health check
app.get("/", (req, res) =>
  res.send("✅ ConnectWise ↔ PagerDuty Integration Running (Webhook V3)")
);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
