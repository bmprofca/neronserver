#!/usr/bin/env python3
from pathlib import Path
import re

creds = {}
for line in Path("/docker/neron-mqtt/.broker_creds").read_text().splitlines():
    if "=" in line:
        k, v = line.split("=", 1)
        creds[k] = v

env_path = Path("/opt/neron-server/.env")
text = env_path.read_text()

updates = {
    "MQTT_BROKER_URL": creds["MQTT_BROKER_URL"],
    "MQTT_USERNAME": creds["MQTT_USERNAME"],
    "MQTT_PASSWORD": creds["MQTT_PASSWORD"],
    "MQTT_CLIENT_ID": "crm-ipbx-bmtaxopc-prod",
    "MQTT_REJECT_UNAUTHORIZED": "false",
}

for key, val in updates.items():
    if re.search(rf"^{key}=", text, flags=re.M):
        text = re.sub(rf"^{key}=.*$", f"{key}={val}", text, flags=re.M)
    else:
        text = text.rstrip() + f"\n{key}={val}\n"

env_path.write_text(text)
print("ENV_UPDATED")
for k in ("MQTT_BROKER_URL", "MQTT_USERNAME", "MQTT_CLIENT_ID"):
    print(f"{k}={updates[k]}")
