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

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

function healthHandler(req, res) {
  return ping()
    .then(() => {
      res.json({
        status: "ok",
        service: "neron-cloud-api",
        device: "Neron 20",
        database: "connected",
        host: config.db.host,
        path: req.path,
      });
    })
    .catch((err) => {
      res.status(200).json({
        status: "degraded",
        service: "neron-cloud-api",
        device: "Neron 20",
        database: err.message,
        host: config.db.host,
        path: req.path,
      });
    });
}

// Hostinger / panel often opens the site root — don't return bare "Not found"
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "neron-cloud-api",
    message: "Neron API is running",
    try: [
      "/api/health",
      "/api/auth/request-otp",
      "/api/calls",
      "/api/settings/neron",
    ],
  });
});

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/devices", requireAuthOrKey, devicesRouter);
app.use("/api/calls", requireAuthOrKey, callsRouter);
app.use("/api/jobs", requireApiKey, jobsRouter);

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: "Not found",
    method: req.method,
    path: req.originalUrl,
    hint: "Use /api/health to verify the API. Auth routes start with /api/auth/",
  });
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

  const host = process.env.HOST || "0.0.0.0";
  app.listen(config.port, host, () => {
    console.log(`Cloud API listening on http://${host}:${config.port}`);
  });
}

start();
