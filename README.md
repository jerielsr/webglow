# WebGlow

WebGlow turns a phone, tablet, or any modern browser into an API-controlled light display. Its browser portal creates and manages displays, while the REST API can set their on/off state, rendered brightness, colour, and pattern. Updates reach open displays live over WebSocket and survive container restarts.

This is the first service layer for a future Home Assistant integration/add-on, Bitfocus Companion module, and Art-Net adapter. Those integrations are not included yet.

> [!IMPORTANT]
> A web page cannot reliably change a phone or tablet's physical backlight level. `brightness` controls the brightness of the pixels WebGlow renders; set the device's hardware brightness manually for maximum light output.

## Docker deployment

The standard [compose.yaml](./compose.yaml) is intentionally a source-build file. For a local Docker deployment, **clone, then build locally**—do not run `docker compose pull` against this file. The separate image-only [compose.portainer.yaml](./compose.portainer.yaml) is for Portainer after the publish workflow has produced an image.

On the Docker host, clone your repository, create an environment file, and choose a strong controller token:

```sh
git clone https://github.com/jerielsr/webglow.git webglow
cd webglow
cp .env.example .env
# Edit .env and replace WEBGLOW_API_TOKEN with a long random value.
```

Build and start the stack:

```sh
docker compose --env-file .env up --build --detach
```

The WebGlow portal is then available at `http://<server-ip>:1828`. Its saved lights live in the named Docker volume `webglow-data`.

Useful lifecycle commands:

```sh
# Confirm the container and its health state.
docker compose --env-file .env ps

# Follow application logs.
docker compose --env-file .env logs --follow

# Update after pulling newer source from your Git remote.
git pull --ff-only
docker compose --env-file .env up --build --detach

# Stop the service without deleting saved lights.
docker compose --env-file .env down
```

To use another host port, set `WEBGLOW_PORT` in `.env`; for example `WEBGLOW_PORT=8088` serves WebGlow on port `8088` while it continues to listen on port `1828` inside the container.

### Deploy as a Portainer stack

Portainer Git stacks should pull a prebuilt image rather than try to execute Compose `build:` steps. The image-only [compose.portainer.yaml](./compose.portainer.yaml) is provided for that purpose; [compose.yaml](./compose.yaml) remains the local source-build file.

#### Publish the image once

The included [publish-image.yml](./.github/workflows/publish-image.yml) GitHub Actions workflow builds `linux/amd64` and `linux/arm64` images and publishes them to GitHub Container Registry as `ghcr.io/jerielsr/webglow` whenever `main` is pushed. It adds `latest`, branch, tag, and commit-SHA tags.

After pushing this repository to `main`:

1. Wait for the **Publish container image** GitHub Actions workflow to finish successfully.
2. Open the repository's **Packages** page and make the `webglow` container package public, or configure GHCR registry credentials in Portainer if you want to keep it private.
3. Confirm the first image is available with:

   ```sh
   docker pull ghcr.io/jerielsr/webglow:latest
   ```

The workflow is included in this repository, but it cannot publish an image until these changes are committed and pushed. If you fork the repository or use another registry, set `WEBGLOW_IMAGE` to your image name in `.env` or Portainer instead.

#### Portainer steps

These steps target a Docker Standalone endpoint. In a Swarm deployment, the named volume is local to a node; use shared storage or pin the service to a suitable node before relying on it for persistent light state.

1. Push this repository to a Git server that the Portainer host can reach.
2. In Portainer, select **Stacks** → **Add stack** → **Repository**.
3. Give the stack a name such as `webglow`, enter the repository URL and branch, and set the compose path to `compose.portainer.yaml`.
4. Add stack environment variables:

   | Variable | Value |
   | --- | --- |
   | `WEBGLOW_API_TOKEN` | A long random secret, for example the output of `openssl rand -hex 32`. |
   | `WEBGLOW_PORT` | `1828`, or the host port you want to expose. |
   | `WEBGLOW_CORS_ORIGIN` | Optional; keep `*` for the default or set your controller's exact origin. |
   | `WEBGLOW_IMAGE` | Optional; defaults to `ghcr.io/jerielsr/webglow`. Set this for a fork or another registry. |
   | `WEBGLOW_IMAGE_TAG` | Optional; defaults to `latest`. Pin a version tag for controlled upgrades. |

5. Deploy the stack. Portainer pulls the image, creates the persistent `webglow-data` volume, and publishes the selected host port.

For an equivalent command-line deployment after the image exists:

```sh
docker compose --env-file .env -f compose.portainer.yaml pull
docker compose --env-file .env -f compose.portainer.yaml up --detach
```

For updates, push a new image and use Portainer's **re-pull image and redeploy** option (or its Git/registry update automation). Do not delete the `webglow-data` volume during a normal redeploy: it holds `lights.json` and keeps your configured lights.

Open the portal at `http://<server-ip>:1828`, add your API token in **Controller access** when prompted, and create a light. It provides the display link to open on the phone or tablet. The same lifecycle is available through the API:

```sh
curl --request POST http://localhost:1828/api/v1/lights \
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

Open `http://<server-ip>:1828/display/kitchen-tablet` on the device. The light starts off deliberately, avoiding a surprise bright screen. Tap the small `i` button to enter fullscreen or request Wake Lock; both features require a user gesture and can vary by browser.

## Control it

Turn the display on with a solid cyan output:

```sh
curl --request PATCH http://localhost:1828/api/v1/lights/kitchen-tablet \
  --header 'Authorization: Bearer replace-with-a-long-random-token' \
  --header 'Content-Type: application/json' \
  --data '{"on":true,"brightness":75,"color":"#00D9FF","pattern":"solid"}'
```

Try a pattern:

```sh
curl --request PATCH http://localhost:1828/api/v1/lights/kitchen-tablet \
  --header 'Authorization: Bearer replace-with-a-long-random-token' \
  --header 'Content-Type: application/json' \
  --data '{"pattern":"rainbow","speed":35}'
```

Turn it off without losing its colour, brightness, or pattern settings:

```sh
curl --request PATCH http://localhost:1828/api/v1/lights/kitchen-tablet \
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
| `GET` | `/` | Browser portal to create, manage, and control lights. |
| `GET` | `/api/v1/info` | API version and supported capabilities. |
| `GET` | `/api/v1/lights` | List known logical lights. |
| `POST` | `/api/v1/lights` | Create a light. Body accepts optional `id` and `name`. |
| `GET` | `/api/v1/lights/:id` | Get an existing light. Returns `404` when it has not been created. |
| `PATCH` | `/api/v1/lights/:id` | Update its name or state. Requires an existing light. |
| `DELETE` | `/api/v1/lights/:id` | Remove a light and turn connected displays black. |
| `GET` | `/display/:id` | Full-screen browser renderer for that light. |
| `GET` | `/api/v1/ws?role=display&lightId=:id` | Display-only live state stream. |

When `WEBGLOW_API_TOKEN` is set, `POST` and `PATCH` require `Authorization: Bearer <token>`. Read/display routes remain unauthenticated so a device can open its display URL without putting a controller credential in the URL. Run WebGlow on a trusted network or place it behind an authenticated reverse proxy when that is not acceptable.

`PATCH` accepts any combination of the following fields:

| Field | Value |
| --- | --- |
| `name` | String containing 1–80 characters. |
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
| `PORT` | `1828` | HTTP and portal port. |
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
