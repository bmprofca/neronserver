const jwt = require("jsonwebtoken");
const config = require("../config");
const { query } = require("../db");

function readBearer(req) {
  const auth = req.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function signUser(user) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      mobile: user.mobile,
      extension: user.extension,
      role: user.role,
    },
    config.jwtSecret,
    { expiresIn: "7d" }
  );
}

function requireAuth(req, res, next) {
  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ status: "error", message: "Login required" });
  }
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ status: "error", message: "Session expired" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ status: "error", message: "Admin only" });
  }
  return next();
}

async function findApiKey(value) {
  if (!value) return null;
  if (config.apiKey && value === config.apiKey) {
    return { source: "env" };
  }
  const rows = await query(
    "SELECT id, name FROM api_keys WHERE api_key = ? AND active = 1 LIMIT 1",
    [value]
  );
  return rows[0] || null;
}

async function requireAuthOrKey(req, res, next) {
  const bearer = readBearer(req);
  const headerKey = req.get("x-api-key") || "";

  if (bearer) {
    try {
      req.user = jwt.verify(bearer, config.jwtSecret);
      return next();
    } catch {
      // fall through and treat bearer as an API key
    }
  }

  const key = await findApiKey(headerKey || bearer);
  if (key) {
    req.apiClient = key;
    return next();
  }

  return res.status(401).json({
    status: "error",
    message: "Login or API key required",
  });
}

async function requireApiKey(req, res, next) {
  const headerKey = req.get("x-api-key") || "";
  const bearer = readBearer(req);
  const key = await findApiKey(headerKey || bearer);

  if (key) {
    req.apiClient = key;
    return next();
  }

  if (!config.apiKey) {
    const keys = await query("SELECT id FROM api_keys WHERE active = 1 LIMIT 1");
    if (keys.length === 0) {
      return next();
    }
  }

  return res.status(401).json({
    status: "error",
    message: "Invalid or missing API key",
  });
}

module.exports = {
  signUser,
  requireAuth,
  requireAdmin,
  requireAuthOrKey,
  requireApiKey,
};
