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
  // Multi-tenant apps (each manages its own PBX / MQTT / users / calling)
  await query(`
    CREATE TABLE IF NOT EXISTS apps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(80) NOT NULL UNIQUE,
      status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

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

  // Developer tokens: app (org-wide) vs user (agent-scoped)
  try {
    await query(
      `ALTER TABLE api_keys
       ADD COLUMN key_type VARCHAR(20) NOT NULL DEFAULT 'app' AFTER name`
    );
  } catch (err) {
    if (!String(err.message || "").includes("Duplicate column")) throw err;
  }
  try {
    await query(
      `ALTER TABLE api_keys
       ADD COLUMN user_id INT NULL AFTER key_type`
    );
  } catch (err) {
    if (!String(err.message || "").includes("Duplicate column")) throw err;
  }

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

  await addColumnIfMissing("devices", "app_id", "INT NULL");
  await addColumnIfMissing("users", "app_id", "INT NULL");
  await addColumnIfMissing("api_keys", "app_id", "INT NULL");

  // Seed default Bmtax app and attach existing live config (do not rotate tokens)
  let bmtax = await query(
    `SELECT * FROM apps WHERE slug = 'bmtax' OR name = 'Bmtax' ORDER BY id ASC LIMIT 1`
  );
  if (!bmtax[0]) {
    const ins = await query(
      `INSERT INTO apps (name, slug, status, is_default, notes)
       VALUES ('Bmtax', 'bmtax', 'active', 1,
         'Default app — preserves current live MQTT / PBX connection')`
    );
    bmtax = await query("SELECT * FROM apps WHERE id = ?", [ins.insertId]);
  } else if (!bmtax[0].is_default) {
    await query("UPDATE apps SET is_default = 1 WHERE id = ?", [bmtax[0].id]);
  }
  const bmtaxId = bmtax[0].id;

  await query("UPDATE devices SET app_id = ? WHERE app_id IS NULL", [bmtaxId]);
  await query("UPDATE users SET app_id = ? WHERE app_id IS NULL", [bmtaxId]);
  await query("UPDATE api_keys SET app_id = ? WHERE app_id IS NULL", [bmtaxId]);
  await query(
    "UPDATE devices SET organization_id = ? WHERE organization_id IS NULL OR organization_id = 1",
    [bmtaxId]
  );

  const existing = await query(
    "SELECT id FROM devices WHERE model = 'Neron 20' LIMIT 1"
  );

  if (existing.length === 0) {
    await query(
      `INSERT INTO devices (name, model, api_type, base_url, notes, app_id, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "Office Neron 20",
        "Neron 20",
        "agent",
        "http://127.0.0.1",
        "Local LAN PBX. Cloud queues calls; LAN agent executes onyxcxm APIs.",
        bmtaxId,
        bmtaxId,
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
      `INSERT INTO users (name, mobile, role, status, app_id)
       VALUES (?, ?, 'admin', 'active', ?)`,
      ["Admin", defaultMobile, bmtaxId]
    );
  }

  await query(`
    CREATE TABLE IF NOT EXISTS inbound_routes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      app_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      priority INT NOT NULL DEFAULT 10,
      match_type ENUM('all', 'did', 'caller_prefix') NOT NULL DEFAULT 'all',
      match_value VARCHAR(40) NULL,
      sticky_last_agent TINYINT(1) NOT NULL DEFAULT 1,
      sticky_days INT NOT NULL DEFAULT 7,
      ring_timeout_sec INT NOT NULL DEFAULT 20,
      queue_number VARCHAR(40) NULL,
      notes TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_inbound_routes_app (app_id, enabled, priority),
      CONSTRAINT fk_inbound_routes_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS inbound_route_steps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      route_id INT NOT NULL,
      extension VARCHAR(40) NOT NULL,
      timeout_sec INT NOT NULL DEFAULT 20,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_inbound_steps_route (route_id, sort_order),
      CONSTRAINT fk_inbound_steps_route FOREIGN KEY (route_id) REFERENCES inbound_routes(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS inbound_mappings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      app_id INT NOT NULL,
      phone VARCHAR(40) NOT NULL,
      match_key VARCHAR(20) NOT NULL,
      extension VARCHAR(40) NOT NULL,
      failover_extensions_json TEXT NULL,
      name VARCHAR(120) NULL,
      notes TEXT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_inbound_map_app_key (app_id, match_key),
      INDEX idx_inbound_map_app (app_id, enabled),
      CONSTRAINT fk_inbound_map_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS inbound_decisions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      app_id INT NOT NULL,
      route_id INT NULL,
      caller VARCHAR(40) NULL,
      did VARCHAR(40) NULL,
      mapped_extension VARCHAR(40) NULL,
      sticky_extension VARCHAR(40) NULL,
      first_extension VARCHAR(40) NULL,
      hunt_json MEDIUMTEXT NULL,
      reason VARCHAR(255) NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'routed',
      call_id VARCHAR(80) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_inbound_decisions_app (app_id, created_at),
      CONSTRAINT fk_inbound_decisions_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    )
  `);

  const defaultRoute = await query(
    `SELECT id FROM inbound_routes WHERE app_id = ? ORDER BY id ASC LIMIT 1`,
    [bmtaxId]
  );
  if (!defaultRoute[0]) {
    const ins = await query(
      `INSERT INTO inbound_routes
        (app_id, name, enabled, priority, match_type, sticky_last_agent, sticky_days, ring_timeout_sec, notes)
       VALUES (?, 'Ring last agent', 1, 10, 'all', 1, 7, 20,
         'Callbacks ring the desk that last dialed this customer')`,
      [bmtaxId]
    );
    await query(
      `INSERT INTO inbound_route_steps (route_id, extension, timeout_sec, sort_order)
       SELECT ?, extension, 20, 0 FROM users
       WHERE app_id = ? AND extension IS NOT NULL AND extension != '' AND status = 'active'
       ORDER BY id ASC LIMIT 3`,
      [ins.insertId, bmtaxId]
    );
  }

  // Bulk calling: groups, contacts, voice prompts, campaigns
  await query(`
    CREATE TABLE IF NOT EXISTS bulk_groups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      app_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      description TEXT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_bulk_groups_app (app_id),
      CONSTRAINT fk_bulk_groups_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bulk_contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_id INT NOT NULL,
      name VARCHAR(120) NULL,
      phone VARCHAR(40) NOT NULL,
      phone_key VARCHAR(20) NOT NULL,
      variables_json TEXT NULL,
      notes TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_bulk_contact_group_key (group_id, phone_key),
      INDEX idx_bulk_contacts_group (group_id),
      CONSTRAINT fk_bulk_contacts_group FOREIGN KEY (group_id) REFERENCES bulk_groups(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bulk_prompts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      app_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      kind ENUM('file', 'url', 'script') NOT NULL DEFAULT 'file',
      file_ref VARCHAR(500) NULL,
      script_template TEXT NULL,
      notes TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_bulk_prompts_app (app_id),
      CONSTRAINT fk_bulk_prompts_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bulk_campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      app_id INT NOT NULL,
      group_id INT NULL,
      prompt_id INT NULL,
      name VARCHAR(160) NOT NULL,
      mode ENUM('live', 'prerecorded') NOT NULL DEFAULT 'live',
      extension VARCHAR(40) NOT NULL,
      auto_answer TINYINT(1) NOT NULL DEFAULT 1,
      delay_sec INT NOT NULL DEFAULT 8,
      status ENUM('draft', 'running', 'paused', 'completed', 'cancelled', 'failed') NOT NULL DEFAULT 'draft',
      total INT NOT NULL DEFAULT 0,
      queued INT NOT NULL DEFAULT 0,
      dialed INT NOT NULL DEFAULT 0,
      answered INT NOT NULL DEFAULT 0,
      failed INT NOT NULL DEFAULT 0,
      skipped INT NOT NULL DEFAULT 0,
      created_by INT NULL,
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_bulk_campaigns_app (app_id, status),
      CONSTRAINT fk_bulk_campaigns_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
      CONSTRAINT fk_bulk_campaigns_group FOREIGN KEY (group_id) REFERENCES bulk_groups(id) ON DELETE SET NULL,
      CONSTRAINT fk_bulk_campaigns_prompt FOREIGN KEY (prompt_id) REFERENCES bulk_prompts(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bulk_campaign_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT NOT NULL,
      contact_id INT NULL,
      phone VARCHAR(40) NOT NULL,
      display_name VARCHAR(120) NULL,
      variables_json TEXT NULL,
      rendered_script TEXT NULL,
      status ENUM('queued', 'dialing', 'dialed', 'answered', 'failed', 'skipped', 'cancelled') NOT NULL DEFAULT 'queued',
      pbx_call_id INT NULL,
      error_message VARCHAR(500) NULL,
      dialed_at DATETIME NULL,
      ended_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_bulk_items_campaign (campaign_id, status),
      CONSTRAINT fk_bulk_items_campaign FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS app_contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      app_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      phone_key VARCHAR(20) NOT NULL,
      company VARCHAR(160) NULL,
      email VARCHAR(160) NULL,
      notes TEXT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_app_contacts_phone (app_id, phone_key),
      INDEX idx_app_contacts_app (app_id, name),
      CONSTRAINT fk_app_contacts_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    )
  `);

  // CRM screen-pop: webhook to CRM UI + optional CRM DB name lookup by phone
  await addColumnIfMissing("apps", "crm_webhook_url", "TEXT NULL");
  await addColumnIfMissing("apps", "crm_webhook_secret", "VARCHAR(120) NULL");
  await addColumnIfMissing(
    "apps",
    "crm_lookup_url",
    "TEXT NULL"
  );
  await addColumnIfMissing(
    "apps",
    "crm_lookup_auth_header",
    "VARCHAR(255) NULL"
  );

  await query(`
    CREATE TABLE IF NOT EXISTS crm_deliveries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      app_id INT NOT NULL,
      event VARCHAR(60) NOT NULL DEFAULT 'incoming_call',
      url TEXT NOT NULL,
      payload_json TEXT NULL,
      status_code INT NULL,
      response_body TEXT NULL,
      error_message VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_crm_deliveries_app (app_id, created_at),
      CONSTRAINT fk_crm_deliveries_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    )
  `);

  // Browser softphone (JsSIP / WebRTC)
  await addColumnIfMissing("apps", "sip_host", "VARCHAR(255) NULL");
  await addColumnIfMissing("apps", "sip_ws_url", "VARCHAR(512) NULL");
  await addColumnIfMissing("users", "sip_password_enc", "TEXT NULL");
  await addColumnIfMissing(
    "users",
    "phone_mode",
    "VARCHAR(20) NOT NULL DEFAULT 'desk'"
  );
}

module.exports = { migrate };
