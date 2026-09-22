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
      app_id: user.app_id || null,
    },
    config.jwtSecret,
    { expiresIn: "7d" }
  );
}

function requireAuth(req, res, next) {
  const token =
    readBearer(req) ||
    String(req.query.access_token || req.query.token || "").trim();
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

/**
 * Like requireAuth, but if JWT was signed by another host that shares this DB
 * (e.g. production token → local contacts API), accept the payload when the
 * user id still exists. Used only for read-only name/directory lookups.
 */
async function requireAuthSharedDb(req, res, next) {
  const token =
    readBearer(req) ||
    String(req.query.access_token || req.query.token || "").trim();
  if (!token) {
    return res.status(401).json({ status: "error", message: "Login required" });
  }
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    try {
      const payload = jwt.decode(token);
      const id = payload && typeof payload === "object" ? payload.id : null;
      if (!id) {
        return res.status(401).json({ status: "error", message: "Session expired" });
      }
      const rows = await query(
        `SELECT id, name, mobile, extension, role, status, app_id
         FROM users WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!rows[0] || rows[0].status === "disabled") {
        return res.status(401).json({ status: "error", message: "Session expired" });
      }
      req.user = {
        id: rows[0].id,
        name: rows[0].name,
        mobile: rows[0].mobile,
        extension: rows[0].extension,
        role: rows[0].role,
        app_id: rows[0].app_id || null,
      };
      return next();
    } catch {
      return res.status(401).json({ status: "error", message: "Session expired" });
    }
  }
}

function requireAdmin(req, res, next) {
  const role = String(req.user?.role || "");
  if (role !== "admin" && role !== "owner") {
    return res.status(403).json({ status: "error", message: "Admin only" });
  }
  return next();
}

async function findApiKey(value) {
  if (!value) return null;
  if (config.apiKey && value === config.apiKey) {
    return { source: "env", key_type: "app", name: "env-API_KEY" };
  }
  const rows = await query(
    `SELECT id, name, key_type, user_id, app_id
     FROM api_keys
     WHERE api_key = ? AND active = 1
     LIMIT 1`,
    [value]
  );
  return rows[0] || null;
}

async function attachUserFromKey(req, key) {
  req.apiClient = key;
  if (key.key_type === "user" && key.user_id) {
    const users = await query(
      `SELECT id, name, mobile, extension, role, status, app_id
       FROM users WHERE id = ? LIMIT 1`,
      [key.user_id]
    );
    if (users[0] && users[0].status !== "disabled") {
      req.user = {
        id: users[0].id,
        name: users[0].name,
        mobile: users[0].mobile,
        extension: users[0].extension,
        role: users[0].role,
        app_id: users[0].app_id || key.app_id || null,
      };
    }
  } else if (key.app_id) {
    req.appId = key.app_id;
  }
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
    await attachUserFromKey(req, key);
    return next();
  }

  return res.status(401).json({
    status: "error",
    message: "Login or developer token required (X-Api-Key)",
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
  requireAuthSharedDb,
  requireAdmin,
  requireAuthOrKey,
  requireApiKey,
};
