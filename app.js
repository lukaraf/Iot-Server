const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Static (ako imaš index.html u rootu projekta)
app.use(express.static(__dirname));

// Render/hosting port
const PORT = process.env.PORT || 3000;

// Secrets/config iz env
const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = process.env.MONGO_DB_NAME || "iot";

// Real-time TTL
const DEVICE_TTL_MS = Number(process.env.DEVICE_TTL_MS || 60_000);
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 5_000);
const LIVE_BUFFER_MAX = Number(process.env.LIVE_BUFFER_MAX || 50);

// ================== MONGODB SCHEMAS ==================

const TemperatureSchema = new mongoose.Schema({
  device_unique_id: { type: String, index: true, required: true },
  value: { type: Number, required: true },
  fan: { type: Number, default: 0 },
  mode: { type: String, default: null },
  timestamp: { type: Date, default: Date.now },
});

const MessageSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  device_unique_id: { type: String, required: true, index: true },
  message: { type: mongoose.Schema.Types.Mixed, required: true },
});

const DeviceMessageSchema = new mongoose.Schema({
  device_unique_id: { type: String, index: true, required: true },
  timestamp: { type: Date, default: Date.now },
  params_to_send: { type: mongoose.Schema.Types.Mixed, required: true },
  consumed: { type: Boolean, default: false },
});

const Temperature = mongoose.model("Temperature", TemperatureSchema);
const Message = mongoose.model("Message", MessageSchema);
const DeviceMessage = mongoose.model("DeviceMessage", DeviceMessageSchema);

// ================== REAL-TIME STATE (RAM) ==================

const liveSamples = []; // graf (zadnjih N)
const lastSeenByDevice = new Map(); // device_id -> lastSeenMs
const lastSampleByDevice = new Map(); // device_id -> poslednji sample

// Cleanup expired devices
setInterval(() => {
  const now = Date.now();
  for (const [deviceId, lastSeen] of lastSeenByDevice.entries()) {
    if (now - lastSeen > DEVICE_TTL_MS) {
      lastSeenByDevice.delete(deviceId);
      lastSampleByDevice.delete(deviceId);
      console.log("🟡 Device expired from live state:", deviceId);
    }
  }
}, CLEANUP_INTERVAL_MS);

// ================== DB CONNECT ==================

async function connectMongo() {
  if (!MONGO_URL) {
    console.error("❌ MONGO_URL nije postavljen (env var).");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URL, { dbName: DB_NAME });
  console.log("✅ MongoDB povezano:", DB_NAME);
}

// ================== ROUTES ==================

// ✅ Root JSON (brzi test da si deployovao novu verziju)
app.get("/__version", (req, res) => {
  res.json({
    ok: true,
    name: "iot-backend",
    version: "live-devices-enabled",
    mongoReadyState: mongoose.connection.readyState,
    ttlMs: DEVICE_TTL_MS,
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mongoReadyState: mongoose.connection.readyState,
    ttlMs: DEVICE_TTL_MS,
  });
});

// Pico -> POST /api/ingest { device_unique_id, temp, fan, mode? }
app.post("/api/ingest", async (req, res) => {
  try {
    const { device_unique_id, temp, fan, mode } = req.body;

    if (!device_unique_id || typeof device_unique_id !== "string") {
      return res.status(400).json({ error: "device_unique_id (string) je obavezan" });
    }

    const tempNum = Number(temp);
    if (!Number.isFinite(tempNum)) {
      return res.status(400).json({ error: "temp (number) je obavezan" });
    }

    const fanNum = Number.isFinite(Number(fan)) ? Number(fan) : 0;
    const modeStr = typeof mode === "string" ? mode : null;

    const nowMs = Date.now();
    const sample = {
      device_unique_id,
      value: tempNum,
      fan: fanNum,
      mode: modeStr,
      timestamp: new Date(),
    };

    // 1) LIVE state
    lastSeenByDevice.set(device_unique_id, nowMs);
    lastSampleByDevice.set(device_unique_id, sample);

    liveSamples.push(sample);
    if (liveSamples.length > LIVE_BUFFER_MAX) liveSamples.shift();

    // 2) Mongo persist
    if (mongoose.connection.readyState === 1) {
      await Message.create({
        device_unique_id,
        message: req.body,
        timestamp: new Date(),
      });
      await Temperature.create(sample);
    }

    return res.status(201).json({ status: "ok" });
  } catch (err) {
    console.error("Greška u /api/ingest:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// Live graf (RAM)
app.get("/api/data", (req, res) => {
  res.json(liveSamples);
});

// ✅ Live devices (RAM)
app.get("/api/live-devices", (req, res) => {
  const now = Date.now();
  const result = [];

  for (const [deviceId, sample] of lastSampleByDevice.entries()) {
    const lastSeen = lastSeenByDevice.get(deviceId) || 0;
    const ageMs = now - lastSeen;

    if (ageMs <= DEVICE_TTL_MS) {
      result.push({
        device_unique_id: deviceId,
        lastSeenMs: lastSeen,
        ageMs,
        last: sample,
      });
    }
  }

  result.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  res.json(result);
});

// Istorija iz baze (Mongo)
app.get("/api/db-data", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 500);
    const deviceId = req.query.device_unique_id;

    const filter = deviceId ? { device_unique_id: deviceId } : {};
    const results = await Temperature.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    res.json(results.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UI -> POST /api/device-message
app.post("/api/device-message", async (req, res) => {
  try {
    const { device_unique_id, params_to_send } = req.body;

    if (!device_unique_id || typeof device_unique_id !== "string") {
      return res.status(400).json({ error: "device_unique_id (string) je obavezan" });
    }
    if (params_to_send === undefined) {
      return res.status(400).json({ error: "params_to_send je obavezan" });
    }

    const msg = await DeviceMessage.create({
      device_unique_id,
      params_to_send,
      consumed: false,
      timestamp: new Date(),
    });

    return res.status(201).json({ status: "queued", id: msg._id });
  } catch (err) {
    console.error("Greška u POST /api/device-message:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// Pico -> GET /api/device-message/:device_unique_id
app.get("/api/device-message/:device_unique_id", async (req, res) => {
  try {
    const { device_unique_id } = req.params;
    const peek = req.query.peek === "1";

    const filter = { device_unique_id, consumed: false };

    const msg = peek
      ? await DeviceMessage.findOne(filter).sort({ timestamp: 1 }).lean()
      : await DeviceMessage.findOneAndUpdate(
          filter,
          { $set: { consumed: true } },
          { sort: { timestamp: 1 }, new: true }
        ).lean();

    if (!msg) return res.status(204).send();

    return res.json({
      device_unique_id: msg.device_unique_id,
      timestamp: msg.timestamp,
      params_to_send: msg.params_to_send,
      consumed: msg.consumed,
    });
  } catch (err) {
    console.error("Greška u GET /api/device-message/:device_unique_id:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// ✅ Ako baš želiš da / vraća index.html kad postoji, a ako ne postoji JSON
app.get("/", (req, res) => {
  const p = path.join(__dirname, "index.html");
  // express.static će ga već servirati ako postoji,
  // ali ovo je fallback:
  res.sendFile(p, (err) => {
    if (err) {
      res.json({ ok: true, hint: "Upload index.html or use /__version" });
    }
  });
});

// ✅ Catch-all 404 JSON (lakše za debug)
app.use((req, res) => {
  res.status(404).json({ error: "not found", path: req.path });
});

// ================== START ==================
(async () => {
  try {
    await connectMongo();
    app.listen(PORT, () => {
      console.log(`✅ Server radi na portu ${PORT}`);
      console.log("✅ Routes: /health, /__version, /api/ingest, /api/data, /api/live-devices, /api/db-data, /api/device-message");
    });
  } catch (e) {
    console.error("❌ Startup error:", e);
    process.exit(1);
  }
})();
