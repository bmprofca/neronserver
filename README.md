# Neron server

Express API, MQTT broker client, click-to-call, and production deploy assets.

```
server/
  src/           API + MQTT
  public/        Built React UI (from client via npm run build:ui)
  agent/         Optional LAN agent
  deploy/        Mosquitto / VPS scripts
  docs/          Broker setup notes
  Dockerfile
  docker-compose.yml
```

```bash
cd server
npm install
npm run dev    # or: npm start
```

Health: `http://localhost:5000/api/health`

Deploy: see `deploy/` and `docs/`.
