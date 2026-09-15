# Broker mode — call without LAN agent

Both **CRM** (`ipbx.bmtaxopc.com`) and **Neron PBX** connect outbound to the same MQTT broker.

## Neron API Manager

| Field | Value |
|--------|--------|
| Enable | ON |
| Host | `ipbx.bmtaxopc.com` |
| Port | `1883` |
| Enable TLS | **OFF** |
| Certificate | None |
| Username | (from VPS broker creds) |
| Password | (from VPS broker creds) |
| Client ID | same as CRM device Client ID |
| Token | same as CRM device Token |

## CRM

- Mode: **Broker**
- Same Client ID + Token
- Server `.env`: `MQTT_BROKER_URL=mqtt://ipbx.bmtaxopc.com:1883` (+ user/pass)

No office PC agent required. Only Neron + cloud server must stay online.

## Own broker

See `server/deploy/neron-mqtt/` and `server/deploy/mosquitto/`.
