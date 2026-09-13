const config = require("../config");

function requireApiKey(req, res, next) {
  if (!config.apiKey) {
    return next();
  }

  const header = req.get("x-api-key") || "";
  const auth = req.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (header === config.apiKey || bearer === config.apiKey) {
    return next();
  }

  return res.status(401).json({
    status: "error",
    message: "Invalid or missing API key",
  });
}

module.exports = { requireApiKey };
