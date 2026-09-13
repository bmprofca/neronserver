const express = require("express");
const cors = require("cors");
const config = require("./config");
const { ping } = require("./db");
const { migrate } = require("./migrate");
const { requireAuthOrKey, requireApiKey } = require("./middleware/auth");
const authRouter = require("./routes/auth");
const usersRouter = require("./routes/users");
const settingsRouter = require("./routes/settings");
const devicesRouter = require("./routes/devices");
const callsRouter = require("./routes/calls");
const jobsRouter = require("./routes/jobs");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", async (req, res) => {
  let database = "disconnected";
  try {
    await ping();
    database = "connected";
  } catch (err) {
    database = err.message;
  }

  res.json({
    status: database === "connected" ? "ok" : "degraded",
    service: "neron-cloud-api",
    device: "Neron 20",
    database,
    host: config.db.host,
  });
});

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/devices", requireAuthOrKey, devicesRouter);
app.use("/api/calls", requireAuthOrKey, callsRouter);
app.use("/api/jobs", requireApiKey, jobsRouter);

app.use((req, res) => {
  res.status(404).json({ status: "error", message: "Not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    status: "error",
    message: err.message || "Internal server error",
  });
});

async function start() {
  if (!config.db.password) {
    console.warn(
      "DB_PASSWORD is empty. Add the Hostinger MySQL password in server/.env"
    );
  }

  try {
    await ping();
    await migrate();
    console.log(`MySQL connected: ${config.db.host}/${config.db.database}`);
  } catch (err) {
    console.error("MySQL connection failed:", err.message);
    console.error(
      "Enable remote MySQL on Hostinger and set DB_PASSWORD in server/.env"
    );
  }

  app.listen(config.port, () => {
    console.log(`Cloud API listening on http://localhost:${config.port}`);
  });
}

start();
