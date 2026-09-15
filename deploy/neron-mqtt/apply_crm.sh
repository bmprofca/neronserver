#!/bin/bash
set -euo pipefail
python3 /tmp/update_crm_env.py
cd /opt/neron-server
docker compose up -d --force-recreate
sleep 5
docker logs neron-server-neron-api-1 --tail 30
echo "---"
ss -tlnp | grep 1883 || true
PASS=$(grep MQTT_PASSWORD /docker/neron-mqtt/.broker_creds | cut -d= -f2)
docker exec neron-mqtt-broker mosquitto_sub -h 127.0.0.1 -p 1883 -u neronmqtt -P "$PASS" -t '$SYS/broker/version' -C 1 -W 5 || true
curl -sk https://ipbx.bmtaxopc.com/api/health
echo
