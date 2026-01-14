const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

// ================== KONSTANTE ==================

const MONGO_URL =
  "mongodb+srv://lseselj16721ri_db_user:2QbxMOE2nPiXPCvb@iot.zlenagm.mongodb.net/?retryWrites=true&w=majority&appName=iot";

// JEDINSTVENI ID UREDJAJA (primer)
const COOLING_DEVICE_UNIQUE_ID = "pico-temp-001";

// ================== MONGODB SCHEMAS ==================

const TemperatureSchema = new mongoose.Schema({
  device_unique_id: { type: String, index: true },
  value: Number,
  fan: Number,
  mode: { type: String, default: null }, // <-- DODATO (AUTO / FORCED_ON / FORCED_OFF)
  timestamp: { type: Date, default: Date.now },
});

const DeviceSchema = new mongoose.Schema({
  device_unique_id: { type: String, unique: true, index: true },
  name: String,
  location: String,
  type: String,
});

const MessageSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  device_unique_id: { type: String, required: true, index: true },
  message: { type: mongoose.Schema.Types.Mixed, required: true }, // ceo payload (temp, fan, itd.)
});

const DeviceMessageSchema = new mongoose.Schema({
  device_unique_id: { type: String, index: true },
  timestamp: { type: Date, default: Date.now },
  params_to_send: { type: mongoose.Schema.Types.Mixed, required: true },
  consumed: { type: Boolean, default: false },
});

// ================== MONGODB MODELS ==================

const Temperature = mongoose.model("Temperature", TemperatureSchema);
const Device = mongoose.model("Device", DeviceSchema);
const Message = mongoose.model("Message", MessageSchema);
const DeviceMessage = mongoose.model("DeviceMessage", DeviceMessageSchema);

// ================== INIT DEVICE (DEMO) ==================

async function ensureCoolingDeviceRegistered() {
  try {
    const dev = await Device.findOneAndUpdate(
      { device_unique_id: COOLING_DEVICE_UNIQUE_ID },
      {
        device_unique_id: COOLING_DEVICE_UNIQUE_ID,
        name: "Pico cooling system",
        location: "Room 1",
        type: "temp+fan",
      },
      { upsert: true, new: true }
    );
    console.log("Device registrovan:", dev.device_unique_id);
  } catch (err) {
    console.error("Greška pri registraciji device-a:", err);
  }
}

mongoose
  .connect(MONGO_URL, { dbName: "iot" })
  .then(async () => {
    console.log("MongoDB povezano");
    await ensureCoolingDeviceRegistered();
  })
  .catch((err) => console.log("MongoDB greška:", err.message));

// ================== LIVE BUFFER ==================

let liveBuffer = [];

// ================== HEALTH ==================
app.get("/health", (req, res) => {
  res.json({ ok: true, mongoReadyState: mongoose.connection.readyState });
});

// ================== API – PICO W PREKO WiFi ==================

// Pico šalje POST na /api/ingest sa JSON-om { device_unique_id, temp, fan, mode? }
app.post("/api/ingest", async (req, res) => {
  try {
    const { device_unique_id, temp, fan, mode } = req.body; // <-- mode DODAT

    // 1) validacija
    if (!device_unique_id || typeof device_unique_id !== "string") {
      return res
        .status(400)
        .json({ error: "device_unique_id (string) je obavezan" });
    }

    const tempNum = Number(temp);
    if (!Number.isFinite(tempNum)) {
      return res.status(400).json({ error: "temp (number) je obavezan" });
    }

    // 2) proveri da li je uređaj registrovan
    const dev = await Device.findOne({ device_unique_id }).lean();
    if (!dev) {
      return res.status(403).json({ error: "unknown device" });
    }

    // 3) upiši poruku u messages kolekciju (ceo payload)
    if (mongoose.connection.readyState === 1) {
      await Message.create({
        device_unique_id,
        message: req.body,
        timestamp: new Date(),
      });
    }

    // 4) sample za graf + temperature kolekciju
    const sample = {
      device_unique_id,
      value: tempNum,
      fan: Number.isFinite(Number(fan)) ? Number(fan) : fan ?? 0,
      mode: typeof mode === "string" ? mode : null, // <-- FIX: sad postoji mode
      timestamp: new Date(),
    };

    // RAM buffer
    liveBuffer.push(sample);
    if (liveBuffer.length > 20) liveBuffer.shift();

    // upis u Mongo
    if (mongoose.connection.readyState === 1) {
      await Temperature.create(sample);
      console.log(
        "Sačuvano:",
        device_unique_id,
        tempNum,
        "°C, fan =",
        sample.fan,
        "mode =",
        sample.mode
      );
    }

    return res.status(201).json({ status: "ok" });
  } catch (err) {
    console.error("Greška u /api/ingest:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// podaci za grafikon (zadnjih 20 uzoraka u RAM-u)
app.get("/api/data", (req, res) => {
  res.json(liveBuffer);
});

// podaci iz baze (istorija)
app.get("/api/db-data", async (req, res) => {
  try {
    const results = await Temperature.find()
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();
    res.json(results.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Web/UI šalje komandu uređaju: { device_unique_id, params_to_send }
app.post("/api/device-message", async (req, res) => {
  try {
    const { device_unique_id, params_to_send } = req.body;

    if (!device_unique_id || typeof device_unique_id !== "string") {
      return res
        .status(400)
        .json({ error: "device_unique_id (string) je obavezan" });
    }

    if (params_to_send === undefined) {
      return res.status(400).json({ error: "params_to_send je obavezan" });
    }

    // proveri da li je uređaj registrovan
    const dev = await Device.findOne({ device_unique_id }).lean();
    if (!dev) {
      return res.status(403).json({ error: "unknown device" });
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

// Pico preuzima komandu: GET /api/device-message/:device_unique_id
// - default: “consume” (potroši poruku)
// - peek=1: samo pogledaj, ne troši
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
    console.error("Greška u GET /api/device-message/:id:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// svi uređaji + poslednje 3 temperature za svaki
app.get("/devices", async (req, res) => {
  try {
    const devices = await Device.find().lean();

    const result = await Promise.all(
      devices.map(async (d) => {
        const id = d.device_unique_id;
        const name = d.name || id;
        const location = d.location || "";
        const isCooling = id === COOLING_DEVICE_UNIQUE_ID;

        let lastThreeTemps = [];
        if (id) {
          const lastThree = await Temperature.find({ device_unique_id: id })
            .sort({ timestamp: -1 })
            .limit(3)
            .lean();

          lastThreeTemps = lastThree
            .map((t) => ({
              value: t.value,
              fan: t.fan,
              mode: t.mode ?? null, // <-- DODATO
              timestamp: t.timestamp,
            }))
            .reverse();
        }

        return {
          device_unique_id: id,
          name,
          location,
          type: d.type || null,
          isCooling,
          lastThreeTemps,
        };
      })
    );

    res.json(result);
  } catch (err) {
    console.error("Greška u /devices:", err);
    res.status(500).json({ error: "Neuspešno čitanje devices" });
  }
});

// index.html za grafikon
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server radi na http://localhost:${PORT}`);
});
