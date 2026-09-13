const { query } = require("./db");

async function addColumnIfMissing(table, column, definition) {
  const rows = await query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length === 0) {
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      model VARCHAR(40) NOT NULL DEFAULT 'Neron 20',
      serial VARCHAR(80) DEFAULT NULL,
      mqtt_token VARCHAR(255) DEFAULT NULL,
      base_url VARCHAR(255) DEFAULT NULL,
      api_type ENUM('http', 'mqtt', 'agent') NOT NULL DEFAULT 'agent',
      default_gateway VARCHAR(80) DEFAULT NULL,
      status ENUM('offline', 'online', 'unknown') NOT NULL DEFAULT 'unknown',
      last_seen_at DATETIME DEFAULT NULL,
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      mobile VARCHAR(20) NOT NULL UNIQUE,
      extension VARCHAR(40) DEFAULT NULL,
      role ENUM('admin', 'agent') NOT NULL DEFAULT 'agent',
      status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mobile VARCHAR(20) NOT NULL,
      code VARCHAR(6) NOT NULL,
      expires_at DATETIME NOT NULL,
      used TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_otp_mobile (mobile, used)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      api_key VARCHAR(80) NOT NULL UNIQUE,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS calls (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id INT NOT NULL,
      type ENUM('extnCall', 'numCall', 'ivrCall', 'hangup') NOT NULL,
      extension VARCHAR(40) DEFAULT NULL,
      caller_id_number VARCHAR(40) DEFAULT NULL,
      callee_id_number VARCHAR(40) DEFAULT NULL,
      gateway VARCHAR(80) DEFAULT NULL,
      ivr VARCHAR(40) DEFAULT NULL,
      uuid VARCHAR(80) DEFAULT NULL,
      status ENUM('queued', 'dispatching', 'success', 'failed', 'hungup') NOT NULL DEFAULT 'queued',
      message TEXT,
      raw_response MEDIUMTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_calls_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  await addColumnIfMissing("calls", "user_id", "INT NULL");
  await addColumnIfMissing(
    "calls",
    "dialer_mode",
    "ENUM('auto_answer', 'hard_phone') NOT NULL DEFAULT 'hard_phone'"
  );
  await addColumnIfMissing("devices", "luci_api_url", "TEXT NULL");
  await addColumnIfMissing(
    "devices",
    "integration_mode",
    "ENUM('local', 'cloud') NOT NULL DEFAULT 'local'"
  );
  await addColumnIfMissing("devices", "stok", "VARCHAR(120) NULL");
  await addColumnIfMissing("devices", "mqtt_host", "VARCHAR(120) NULL");
  await addColumnIfMissing("devices", "mqtt_port", "INT NULL DEFAULT 1883");
  await addColumnIfMissing("devices", "mqtt_username", "VARCHAR(120) NULL");
  await addColumnIfMissing("devices", "mqtt_password", "VARCHAR(255) NULL");
  await addColumnIfMissing("devices", "mqtt_client_id", "VARCHAR(120) NULL");
  await addColumnIfMissing(
    "devices",
    "api_enabled",
    "TINYINT(1) NOT NULL DEFAULT 1"
  );

  const existing = await query(
    "SELECT id FROM devices WHERE model = 'Neron 20' LIMIT 1"
  );

  if (existing.length === 0) {
    await query(
      `INSERT INTO devices (name, model, api_type, base_url, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [
        "Office Neron 20",
        "Neron 20",
        "agent",
        "http://127.0.0.1",
        "Local LAN PBX. Cloud queues calls; LAN agent executes onyxcxm APIs.",
      ]
    );
  }

  const defaultMobile = "7002695990";
  const defaultUser = await query(
    "SELECT id FROM users WHERE mobile = ? LIMIT 1",
    [defaultMobile]
  );
  if (defaultUser.length === 0) {
    await query(
      `INSERT INTO users (name, mobile, role, status)
       VALUES (?, ?, 'admin', 'active')`,
      ["Admin", defaultMobile]
    );
  }
}

module.exports = { migrate };
