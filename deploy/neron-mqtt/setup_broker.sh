#!/bin/bash
set -euo pipefail
DIR=/docker/neron-mqtt
mkdir -p "$DIR/config"
cd "$DIR"

PASS=$(openssl rand -hex 12)
USER=neronmqtt

# Create passwd file inside a throwaway mosquitto container
docker run --rm -v "$DIR/config:/mosquitto/config" eclipse-mosquitto:2 \
  mosquitto_passwd -c -b /mosquitto/config/passwd "$USER" "$PASS"

chmod 0700 "$DIR/config/passwd" || true

cat > "$DIR/.broker_creds" <<EOF
MQTT_USERNAME=$USER
MQTT_PASSWORD=$PASS
MQTT_BROKER_HOST=ipbx.bmtaxopc.com
MQTT_BROKER_PORT=1883
MQTT_BROKER_URL=mqtt://ipbx.bmtaxopc.com:1883
EOF
chmod 600 "$DIR/.broker_creds"

ufw allow 1883/tcp comment 'Neron MQTT' || true
ufw reload || true

docker compose -f "$DIR/docker-compose.yml" up -d

echo "BROKER_READY"
cat "$DIR/.broker_creds"
