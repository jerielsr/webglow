# WebGlow

WebGlow turns a phone, tablet, or any modern browser into an API-controlled light display, and can also bring physical WLED devices into the same fixture sheet. Its password-protected portal is a console-style programmer with fixture selection, touch-first masters, faders, fades, patterns, chases, cue recording, and playback, while the REST API remains available for Home Assistant and other automation. Updates reach open displays live over WebSocket and survive container restarts.

This is the first service layer for a future Home Assistant integration/add-on, Bitfocus Companion module, and Art-Net adapter. Those integrations are not included yet.

> [!IMPORTANT]
> A web page cannot reliably change a phone or tablet's physical backlight level. `brightness` controls the brightness of the pixels WebGlow renders; set the device's hardware brightness manually for maximum light output.

## Docker deployment

The standard [compose.yaml](./compose.yaml) is intentionally a source-build file. For a local Docker deployment, **clone, then build locally**—do not run `docker compose pull` against this file. The separate image-only [compose.portainer.yaml](./compose.portainer.yaml) is for Portainer after the publish workflow has produced an image.

On the Docker host, clone your repository, create an environment file, and choose strong, separate secrets for automation and password recovery:

```sh
git clone https://github.com/jerielsr/webglow.git webglow
cd webglow
cp .env.example .env
# Edit .env and replace both generated-secret placeholders with long random values.
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
   | `WEBGLOW_API_TOKEN` | Optional automation/API Bearer token; use a long random value, for example the output of `openssl rand -hex 32`. |
   | `WEBGLOW_PASSWORD_RESET_TOKEN` | A different long random recovery secret used only to reset the portal password. |
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

Open the portal at `http://<server-ip>:1828`. On its first visit, create the portal username and password. **Control** is the console programmer and cue stack; **Setup** creates and manages fixtures; **Settings** contains server, container, account, and public-URL settings. The portal uses client-side navigation and includes a PWA manifest/service worker, so moving between these views does not reload the application.

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
    "kind": "display",
    "state": {
      "on": false,
      "brightness": 100,
      "color": "#FFFFFF",
      "pattern": "solid",
      "speed": 50,
      "fadeMs": 0,
      "phaseOffset": 0,
      "patternStartedAt": 1760000000000
    },
    "revision": 0,
    "updatedAt": "2026-01-01T00:00:00.000Z"
  },
  "displayPath": "/display/kitchen-tablet"
}
```

Open `http://<server-ip>:1828/display/kitchen-tablet` on the device. The light starts off deliberately, avoiding a surprise bright screen. Tap the small `i` button to enter fullscreen or request Wake Lock; both features require a user gesture and can vary by browser.

### Add a WLED fixture

In **Setup**, select **WLED device**, enter its reachable base address (for example, http://wled.local) and segment number, then connect it. WebGlow checks the device's JSON API before saving it, reads its current output, and learns the effect IDs available on that WLED build. The fixture then appears alongside web displays and receives programmer, batch, chase, blackout, restore, and cue commands.

The same operation is available to an automation controller:

~~~
curl --request POST http://localhost:1828/api/v1/lights \
  --header 'Authorization: Bearer replace-with-a-long-random-token' \
  --header 'Content-Type: application/json' \
  --data '{"id":"garden-pixels","name":"Garden pixels","kind":"wled","wled":{"url":"http://wled.local","segment":0}}'
~~~

WebGlow uses WLED's documented JSON API at /json and /json/state; the WLED device must be reachable from the WebGlow container. A WLED fixture is a physical output, so it does not have a display URL. Use **Refresh WLED** in Setup to pull its current state back into the console. Each programmer, chase, batch, and cue action uses one shared effect clock; browser displays receive the same start time and WLED fixtures receive the same WLED effect timebase, so effects remain phase-aligned.

### Audience guest lights

For an audience, open **Settings** → **Audience registration** and enable guest access. WebGlow reveals a shareable join URL and an in-portal QR code. A guest opens the link, enters a display name, and is redirected to a unique full-screen light page. Their fixture appears immediately in the normal console fixture sheet, so it can be selected, programmed, included in cues, or controlled with every light at once.

Guest registration is closed by default and is rate-limited to 12 registrations per source network every 10 minutes. Close it once everyone has joined. The **Masters** panel shows registered and active guest counts, active guest WebSocket connections, WebSocket data sent to guest displays, and the persisted state footprint for guest fixtures. This makes it practical to watch audience participation without exposing the portal login or API bearer token.

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
    "fadeMs": 0,
    "phaseOffset": 0,
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
| `POST` | `/api/v1/lights` | Create a web display, or a WLED fixture with `kind: "wled"` and a `wled` connection object. |
| `GET` | `/api/v1/lights/:id` | Get an existing light. Returns `404` when it has not been created. |
| `PATCH` | `/api/v1/lights/:id` | Update its name or state. Requires an existing light. |
| `POST` | `/api/v1/lights/:id/wled/refresh` | Pull the current state from a WLED fixture. |
| `POST` | `/api/v1/lights/batch` | Apply one output-state patch to all or selected lights. |
| `POST` | `/api/v1/lights/chase` | Create a phase-spaced chase across all or selected lights. |
| `GET` | `/api/v1/scenes` | List recorded console cues. |
| `POST` | `/api/v1/scenes` | Record a cue with a number, target fixtures, and output state. |
| `POST` | `/api/v1/scenes/:sceneId/go` | Run a recorded cue. |
| `DELETE` | `/api/v1/scenes/:sceneId` | Delete a recorded cue. |
| `GET` | `/api/v1/metrics` | Process, host, and WebGlow traffic snapshot. |
| `GET` / `PATCH` | `/api/v1/settings` | Read or set the public application URL used in display links. |
| `GET` | `/api/v1/guest-registration` | Public registration availability check. |
| `POST` | `/api/v1/guest-registration` | Publicly register one unique browser light when guest access is enabled. |
| `GET` | `/api/v1/guest-registration/qr` | Authenticated SVG QR code for the join URL. |
| `GET` | `/api/v1/guests` | Authenticated guest counts, activity, and guest-specific resource usage. |
| `DELETE` | `/api/v1/lights/:id` | Remove a light and turn connected displays black. |
| `GET` | `/display/:id` | Full-screen browser renderer for that light. |
| `GET` | `/api/v1/ws?role=display&lightId=:id` | Display-only live state stream. |

For multi-light automation, `POST /api/v1/lights/batch` accepts `{ "ids": "all" | ["id"], "state": { ...patch } }`. `POST /api/v1/lights/chase` accepts `ids`, `speed`, `fadeMs`, optional `color`, and optional `on`; it assigns evenly spaced phase offsets. A console cue is recorded through `POST /api/v1/scenes` with an `id` such as `1` or `12.5`, a target `ids` value, and an output `state`.

WLED fixtures accept the same output patches as displays. WebGlow translates brightness from 0–100 to WLED's 0–255 range, fade time to WLED transition units, colour to the configured segment, and semantic patterns to effect IDs discovered from that fixture. If an installed WLED build does not expose an equivalent effect, WebGlow still applies power, brightness, colour, speed, and fade without changing its active effect.

The browser portal is protected by its own username/password session; the portal never stores an API token in the browser. Once a portal account exists, management API routes require either that portal session or `Authorization: Bearer <token>` when `WEBGLOW_API_TOKEN` is configured. Read/display routes remain unauthenticated so a device can open its display URL without putting a controller credential in the URL. Run WebGlow on a trusted network or place it behind an authenticated reverse proxy when that is not acceptable.

`PATCH` accepts any combination of the following fields:

| Field | Value |
| --- | --- |
| `name` | String containing 1–80 characters. |
| `on` | Boolean. `false` renders black but retains settings. |
| `brightness` | Number from `0` to `100`; rendered brightness, not physical device brightness. |
| `color` | Three- or six-digit CSS hex colour, such as `#0AB` or `#00AABB`. |
| `pattern` | `solid`, `breathe`, `pulse`, `strobe`, `rainbow`, `chase`, or `twinkle`. |
| `speed` | Number from `0` to `100`. It changes animation speed. |
| `fadeMs` | Number from `0` to `60000`. Display transition duration in milliseconds. |
| `phaseOffset` | Number from `0` to `1` used to space a multi-light effect. |
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
| `DATA_DIR` | `./data` locally, `/data` in Docker | Directory containing `lights.json`, the password-hash-only `settings.json`, and persisted console `scenes.json`. |
| `WEBGLOW_API_TOKEN` | unset | Optional Bearer token for external automation such as Home Assistant. It does not log into the browser portal. |
| `WEBGLOW_PASSWORD_RESET_TOKEN` | unset | Optional recovery secret for the Setup page's reset-password form. Set it before relying on password recovery. |
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
