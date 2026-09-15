#!/bin/bash
set -e
cd /opt/neron-server
docker compose up -d --build
sleep 2
docker exec neron-server-neron-api-1 grep -o 'main\.[^"]*\.js' /app/public/index.html
echo DEPLOYED
