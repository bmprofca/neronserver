# Mosquitto TLS broker for Neron outbound MQTT

## Generate self-signed certs (dev only)

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -days 365 -nodes \
  -keyout certs/ca.key -out certs/ca.crt -subj "/CN=NeronMQTT-CA"
openssl req -newkey rsa:2048 -nodes -keyout certs/server.key \
  -out certs/server.csr -subj "/CN=mqtt.example.com"
openssl x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -out certs/server.crt -days 365
```

Use a real certificate (Let's Encrypt) in production. Set `MQTT_REJECT_UNAUTHORIZED=true`.

## Passwords

```bash
docker run --rm -v "$PWD/config:/mosquitto/config" eclipse-mosquitto:2 \
  mosquitto_passwd -c -b /mosquitto/config/passwd crm_backend 'STRONG_CRM_PASS'
docker run --rm -v "$PWD/config:/mosquitto/config" eclipse-mosquitto:2 \
  mosquitto_passwd -b /mosquitto/config/passwd neron_office_1 'STRONG_PBX_PASS'
```

Edit `config/acl` and replace `OFFICE_TOKEN_HERE` with the real Neron device token.

## Run

```bash
docker compose up -d
```

Firewall: allow **inbound TCP 8883** only. Do **not** expose 1883.

## CRM .env

```
MQTT_BROKER_URL=mqtts://mqtt.example.com:8883
MQTT_USERNAME=crm_backend
MQTT_PASSWORD=STRONG_CRM_PASS
MQTT_CLIENT_ID=crm-production-server
MQTT_REJECT_UNAUTHORIZED=true
```
