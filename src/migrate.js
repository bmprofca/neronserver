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
  await addColumnIfMissing("devices", "organization_id", "INT NOT NULL DEFAULT 1");
  await addColumnIfMissing("devices", "location", "VARCHAR(120) NULL");
  await addColumnIfMissing("devices", "firmware_version", "VARCHAR(80) NULL");
  await addColumnIfMissing(
    "devices",
    "connection_status",
    "VARCHAR(40) NULL DEFAULT 'unknown'"
  );
  await addColumnIfMissing("devices", "mqtt_token_enc", "TEXT NULL");
  await addColumnIfMissing("devices", "enabled", "TINYINT(1) NOT NULL DEFAULT 1");

  // Expand enums for broker mode (ignore if already applied)
  try {
    await query(
      `ALTER TABLE devices
       MODIFY COLUMN integration_mode
       ENUM('local', 'cloud', 'broker') NOT NULL DEFAULT 'local'`
    );
  } catch {
    /* already migrated or unsupported */
  }
  try {
    await query(
      `ALTER TABLE devices
       MODIFY COLUMN api_type
       ENUM('http', 'mqtt', 'agent', 'broker') NOT NULL DEFAULT 'agent'`
    );
  } catch {
    /* already migrated */
  }

  await query(`
    CREATE TABLE IF NOT EXISTS pbx_extensions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pbx_device_id INT NOT NULL,
      user_id INT NULL,
      extension_number VARCHAR(40) NOT NULL,
      extension_name VARCHAR(120) NULL,
      extension_type VARCHAR(40) NULL,
      current_status VARCHAR(40) NULL DEFAULT 'unknown',
      last_status_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_pbx_ext (pbx_device_id, extension_number),
      CONSTRAINT fk_pbx_ext_device FOREIGN KEY (pbx_device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS pbx_mqtt_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pbx_device_id INT NOT NULL,
      crm_user_id INT NULL,
      request_id VARCHAR(64) NOT NULL,
      command VARCHAR(80) NULL,
      topic VARCHAR(255) NULL,
      payload_json MEDIUMTEXT,
      response_json MEDIUMTEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      UNIQUE KEY uq_pbx_req (request_id),
      INDEX idx_pbx_req_device (pbx_device_id, created_at),
      CONSTRAINT fk_pbx_req_device FOREIGN KEY (pbx_device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS pbx_call_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pbx_device_id INT NOT NULL,
      crm_user_id INT NULL,
      contact_id VARCHAR(64) NULL,
      request_id VARCHAR(64) NOT NULL,
      extension_number VARCHAR(40) NULL,
      customer_number VARCHAR(40) NULL,
      gateway VARCHAR(80) NULL,
      direction VARCHAR(20) NULL DEFAULT 'outbound',
      command_type VARCHAR(40) NULL DEFAULT 'extnCall',
      status VARCHAR(40) NOT NULL DEFAULT 'requested',
      error_message TEXT NULL,
      requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      acknowledged_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_pbx_call_req (request_id),
      INDEX idx_pbx_call_req_device (pbx_device_id, created_at),
      CONSTRAINT fk_pbx_call_req_device FOREIGN KEY (pbx_device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS pbx_calls (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pbx_device_id INT NOT NULL,
      crm_user_id INT NULL,
      contact_id VARCHAR(64) NULL,
      legacy_call_id INT NULL,
      request_id VARCHAR(64) NOT NULL,
      call_id VARCHAR(80) NULL,
      uuid VARCHAR(80) NULL,
      extension_number VARCHAR(40) NULL,
      customer_number VARCHAR(40) NULL,
      direction VARCHAR(20) NULL DEFAULT 'outbound',
      call_status VARCHAR(40) NOT NULL DEFAULT 'requested',
      started_at DATETIME NULL,
      ringing_at DATETIME NULL,
      answered_at DATETIME NULL,
      ended_at DATETIME NULL,
      duration_seconds INT NULL,
      billable_seconds INT NULL,
      hangup_cause VARCHAR(120) NULL,
      recording_reference VARCHAR(255) NULL,
      raw_cdr_json MEDIUMTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_pbx_calls_request (request_id),
      UNIQUE KEY uq_pbx_calls_callid (call_id),
      INDEX idx_pbx_calls_device_created (pbx_device_id, created_at),
      INDEX idx_pbx_calls_customer (customer_number),
      CONSTRAINT fk_pbx_calls_device FOREIGN KEY (pbx_device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS pbx_audit_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pbx_device_id INT NULL,
      crm_user_id INT NULL,
      action VARCHAR(80) NOT NULL,
      detail_json MEDIUMTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pbx_audit_created (created_at)
    )
  `);

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
