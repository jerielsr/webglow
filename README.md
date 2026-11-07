# WebGlow

WebGlow turns a phone, tablet, or any modern browser into an API-controlled light display. Open a unique display URL on the device, then use the REST API to set its on/off state, rendered brightness, colour, and pattern. Updates reach open displays live over WebSocket and survive container restarts.

This is the first service layer for a future Home Assistant integration/add-on, Bitfocus Companion module, and Art-Net adapter. Those integrations are not included yet.

> [!IMPORTANT]
> A web page cannot reliably change a phone or tablet's physical backlight level. `brightness` controls the brightness of the pixels WebGlow renders; set the device's hardware brightness manually for maximum light output.

## Quick start with Docker

From this folder:

```sh
WEBGLOW_API_TOKEN='replace-with-a-long-random-token' docker compose up --build -d
```

The service is then available at `http://<server-ip>:3000`. Its saved lights live in the named Docker volume `webglow-data`.

Create a light and open the returned `displayPath` on the phone or tablet you want to use:

```sh
curl --request POST http://localhost:3000/api/v1/lights \
  --header 'Authorization: Bearer replace-with-a-long-random-token' \
  --header 'Content-Type: application/json' \
  --data '{"id":"kitchen-tablet","name":"Kitchen tablet"}'
```

Example response:

```json
{
  "light": {
    "id": "kitchen-tablet",
    "name": "Kitchen tablet",
    "state": {
      "on": false,
      "brightness": 100,
      "color": "#FFFFFF",
      "pattern": "solid",
      "speed": 50,
      "patternStartedAt": 1760000000000
    },
    "revision": 0,
    "updatedAt": "2026-01-01T00:00:00.000Z"
  },
  "displayPath": "/display/kitchen-tablet"
}
```

Open `http://<server-ip>:3000/display/kitchen-tablet` on the device. The light starts off deliberately, avoiding a surprise bright screen. Tap the small `i` button to enter fullscreen or request Wake Lock; both features require a user gesture and can vary by browser.

## Control it

Turn the display on with a solid cyan output:

```sh
curl --request PATCH http://localhost:3000/api/v1/lights/kitchen-tablet \
  --header 'Authorization: Bearer replace-with-a-long-random-token' \
  --header 'Content-Type: application/json' \
  --data '{"on":true,"brightness":75,"color":"#00D9FF","pattern":"solid"}'
```

Try a pattern:

```sh
curl --request PATCH http://localhost:3000/api/v1/lights/kitchen-tablet \
  --header 'Authorization: Bearer replace-with-a-long-random-token' \
  --header 'Content-Type: application/json' \
  --data '{"pattern":"rainbow","speed":35}'
```

Turn it off without losing its colour, brightness, or pattern settings:

```sh
curl --request PATCH http://localhost:3000/api/v1/lights/kitchen-tablet \
  --header 'Authorization: Bearer replace-with-a-long-random-token' \
  --header 'Content-Type: application/json' \
  --data '{"on":false}'
```

## API reference

All successful light resources have this shape:

```json
{
  "id": "kitchen-tablet",
  "name": "Kitchen tablet",
  "state": {
    "on": true,
    "brightness": 75,
    "color": "#00D9FF",
    "pattern": "solid",
    "speed": 35,
    "patternStartedAt": 1760000000000
  },
  "revision": 2,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Container health check. |
| `GET` | `/api/v1/info` | API version and supported capabilities. |
| `GET` | `/api/v1/lights` | List known logical lights. |
| `POST` | `/api/v1/lights` | Create a light. Body accepts optional `id` and `name`. |
| `GET` | `/api/v1/lights/:id` | Get a light. A first display fetch creates it with safe, off defaults. |
| `PATCH` | `/api/v1/lights/:id` | Update its state. Requires an existing light. |
| `GET` | `/display/:id` | Full-screen browser renderer for that light. |
| `GET` | `/api/v1/ws?role=display&lightId=:id` | Display-only live state stream. |

When `WEBGLOW_API_TOKEN` is set, `POST` and `PATCH` require `Authorization: Bearer <token>`. Read/display routes remain unauthenticated so a device can open its display URL without putting a controller credential in the URL. Run WebGlow on a trusted network or place it behind an authenticated reverse proxy when that is not acceptable.

`PATCH` accepts any combination of the following fields:

| Field | Value |
| --- | --- |
| `on` | Boolean. `false` renders black but retains settings. |
| `brightness` | Number from `0` to `100`; rendered brightness, not physical device brightness. |
| `color` | Three- or six-digit CSS hex colour, such as `#0AB` or `#00AABB`. |
| `pattern` | `solid`, `pulse`, `strobe`, or `rainbow`. |
| `speed` | Number from `0` to `100`. It changes animation speed. |
| `expectedRevision` | Optional current revision for optimistic concurrency; a stale value returns `409`. |

The API rejects unknown fields and returns errors as:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "brightness must be a number from 0 to 100."
  }
}
```

### Live display protocol

The browser renderer connects to the WebSocket endpoint after loading its initial REST state. It receives a complete resource, rather than animation frames, in either message form:

```json
{ "type": "state.snapshot", "light": { "…": "light resource" } }
{ "type": "state.changed", "light": { "…": "light resource" } }
```

It reconnects automatically and falls back to a five-second REST refresh if a WebSocket connection is unavailable. Patterns are rendered locally, keeping multiple devices in sync without streaming video.

For photosensitivity safety, WebGlow constrains the browser strobe renderer to roughly 0.5–3 Hz.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `./data` locally, `/data` in Docker | Directory containing `lights.json`. |
| `WEBGLOW_API_TOKEN` | unset | Optional Bearer token that protects controller endpoints. Set this in real deployments. |
| `WEBGLOW_CORS_ORIGIN` | `*` | Allowed CORS origin for REST controllers. Set a specific origin when a browser-based controller needs one. |

## Local development

Requires Node.js 22.18 or newer.

```sh
npm install
npm test
npm run build
WEBGLOW_API_TOKEN='development-token' npm start
```

`npm test` compiles the service and runs API integration tests covering creation, state updates, validation, display delivery, revisions, and controller authentication.

## Home Assistant direction

The REST resource maps directly to a Home Assistant `LightEntity`: `brightness` maps from `0–100` to HA's `0–255`, `color` to RGB, and `pattern` to an effect. A subsequent HACS custom integration can use `GET /api/v1/lights` for discovery and `PATCH /api/v1/lights/:id` for commands. A Home Assistant add-on (the container package) is a separate deliverable from that HACS integration; this Docker image is intentionally ready to be wrapped by either one.
