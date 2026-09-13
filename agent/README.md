# Neron 20 LAN Agent (Windows)

## Option A — Double-click (easiest)

1. Copy `NeronLanAgent.env.example` → `NeronLanAgent.env`
2. Paste your API key from cloud **API integration**
3. Double-click **`run-agent.cmd`**
4. Leave the window open while making calls from https://call.bmtaxopc.com

## Option B — Standalone .exe

From the `server` folder (needs Node once to build):

```powershell
npm install
npm run agent:build-exe
```

Output: `agent/dist/NeronLanAgent.exe`

Copy to any office PC:

- `NeronLanAgent.exe`
- `NeronLanAgent.env` (from the example, with your key)

Double-click the `.exe`. Keep it open.

## Calling without a local agent?

Cloud Hostinger **cannot** reach `192.168.0.180` alone. Alternatives:

1. **VPN (recommended if you want no agent app)**  
   Put Tailscale/WireGuard on the Hostinger VPS *or* use a VPS that joins the office LAN, then set API Manager to **Local** mode and dial MQTT directly.

2. **Run the whole API on an office PC**  
   Host Node + MySQL (or remote DB) on the same LAN as Neron — no cloud bridge needed; use Local mode.

3. **Do not expose MQTT port 1883 to the public internet**  
   Security risk.

The small LAN agent (this tool) is still the simplest and safest for Hostinger cloud.
