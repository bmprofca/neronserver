# Neron N-20 MQTT setup (outbound to public broker)

This guide configures the office Neron so it **connects out** to your public MQTT broker (TLS 8883). No LAN agent, no port-forward to the PBX.

Field names in LuCI may differ by firmware — use the closest match.

## 1. Find MQTT / API Manager

1. Open Neron web UI on LAN (example `https://192.168.0.180`).
2. Go to **System → API** (API Manager) or MQTT / IoT settings.
3. Enable the MQTT / API client.

## 2. Broker settings on Neron

| Setting | Value |
|--------|--------|
| Broker hostname | `mqtt.example.com` (your broker DNS) |
| Port | `8883` (MQTT over TLS) |
| TLS / SSL | **On** |
| Username | PBX broker user (e.g. `neron_office_1`) |
| Password | PBX broker password |
| Client ID | Unique, e.g. `neron-nxg-01` |
| Token / Device token | Same token saved in CRM API integration |
| Keep-alive | 60 |
| Reconnect | Enabled |

Save and restart the MQTT/API service if the UI offers it.

## 3. CRM cloud settings

1. Server `.env`: set `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`.
2. Web **API integration** → mode **Broker** → paste **Token** (same as Neron) → Save.
3. **Test Neron 20** — Connected when Neron has published recently.

## 4. Verify

### CRM health

`GET https://your-crm/api/health` → `mqtt.connected: true`

### deviceInfo (from CRM admin)

`POST /api/pbx/devices/:id/test`

### Topics (conceptual)

- Command: `device/{token}/api/v1.0/command/system`
- Response: `device/{token}/api/v1.0/response`
- Event: `device/{token}/api/v1.0/event`
- CDR: `device/{token}/api/v1.0/cdr`

### Safe click-to-call test

Use Dialer with your own mobile. Confirm extension rings first, then mobile.

## 5. Troubleshooting

| Symptom | Check |
|--------|--------|
| CRM mqtt.connected false | Broker URL, TLS certs, username/password |
| Connected but Neron offline | Neron outbound firewall/DNS; ACL token mismatch |
| Dial timeout | Token mismatch; Neron not subscribed to command topics |
| TLS errors | CA trust; `MQTT_REJECT_UNAUTHORIZED` |

## Confirmed dial command (this project)

Live Neron 20 tests used:

```json
{
  "cmd": "dial",
  "caller": "1001",
  "callee": "07002695990",
  "dialpermission": "1001",
  "autoanswer": "yes",
  "request_id": "uuid"
}
```

Override via env: `NERON_DIAL_CMD`, `NERON_DIAL_CALLER_FIELD`, etc. if firmware differs.

Recording download is **not** implemented until the firmware MQTT method is confirmed.
