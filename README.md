# WebGlow

WebGlow turns a phone, tablet, or any modern browser into an API-controlled light display, and can also bring physical WLED and uDMX DMX fixtures into the same fixture sheet. Its password-protected portal is a console-style programmer with fixture selection, touch-first masters, faders, fades, patterns, chases, cue recording, and playback, while the REST API remains available for Home Assistant and other automation. Updates reach open displays live over WebSocket and survive container restarts.

This is the first service layer for a future Home Assistant integration/add-on, Bitfocus Companion module, and Art-Net adapter. Those integrations are not included yet.

> [!IMPORTANT]
> A web page cannot reliably change a phone or tablet's physical backlight level. `brightness` controls the brightness of the pixels WebGlow renders; set the device's hardware brightness manually for maximum light output.

## Run as a macOS app

WebGlow also ships as a standalone Electron app, so the Mac that runs the console does not need Docker or a separate Node.js installation. The app includes the local service, opens the portal in its own window, and keeps its data under macOS Application Support. It listens on port `1828` by default and on the Mac's network interfaces so phones, WLED devices, and other controllers on the LAN can connect. The first launch may ask macOS Firewall to allow incoming connections.

Download the universal `WebGlow-<version>-universal.dmg` from [GitHub Releases](https://github.com/jerielsr/webglow/releases/latest), open it, and drag WebGlow into Applications. Pushing a version tag such as `v0.2.0` runs the macOS packaging workflow and attaches the DMG to that release; running that workflow manually makes a downloadable Actions artifact. The universal build includes Intel (`x64`) and Apple Silicon (`arm64`) support. If macOS says the app cannot be verified, use **System Settings → Privacy & Security → Open Anyway** only if you trust the DMG source. Public distribution without that warning requires signing and notarizing the app with an Apple Developer identity; the repository build is not configured with signing credentials.

To build the DMG yourself on a Mac, install Node.js `22.18` or newer, clone this repository, then run:

```sh
npm ci
npm run desktop:mac
```

The DMG is written to `release/`. Architecture-specific builds are also available with `npm run desktop:mac:x64` and `npm run desktop:mac:arm64`. Building the macOS package should be done on macOS. To run the desktop app from the checkout during development, use `npm run desktop:dev`.

On first launch, create the portal account in the app window. The selected microphone is used locally for timecode only; audio is not sent to guest display devices. Go to **Settings → SMPTE / LTC input**, choose a Mac microphone or connected audio interface, choose a frame rate, and start the monitor. macOS will ask for microphone permission. Feed LTC audio into that input, wait for the lock indicator, then arm LTC in **Control → Timecode show**. Frame rates are 23.976, 24, 25, 29.97 drop-frame, and 30 fps. Cue timelines can be prepared manually or captured from the live clock, then placed on the project/show timecode. **Play test** uses the same placed timeline without requiring an LTC source. Cue triggers are initiated when the corresponding frame is received; actual light output still depends on the Mac, network, and display/WLED response time.

For DMX, connect the uDMX USB adapter to the Mac running WebGlow. Check detection in **Settings → DMX**, then create and patch fixtures in **Setup** using a profile and a non-overlapping address. The built-in Stairville LED PAR 64 profile is five channels in the requested order: Operation Mode, Red, Green, Blue, Speed. WebGlow also lets you build custom profiles and define operation-mode values from the fixture's manual.

The timecode workflow separates per-song cue timelines from the project/show timeline that places them, a structure also discussed in [FreeShow's timecode feature request](https://github.com/ChurchApps/FreeShow/issues/1877). The universal target is provided by Electron Builder's [macOS architecture support](https://www.electron.build/docs/architecture/).

## Showfiles

Use **Settings → Showfile** to export the current cues and cue stacks, timecode timelines, configured fixtures and their current output, custom DMX fixture profiles, plus audience-section and fixture-sheet ordering. The optional media checkbox embeds media currently referenced by fixture states or cues into the same `.wgshow` file (up to 200 MB total), so the file can be moved to another WebGlow install without a separate media folder.

Loading a showfile replaces configured fixtures, cues/stacks, timecode timelines, and the included section/order preferences. QR-registered guest lights, portal account credentials, server/API settings, and unrelated media-library assets are preserved. WLED fixtures from the imported show may receive the saved output state. The authenticated API is `GET /api/v1/showfile?includeMedia=true` to export with referenced media, and `PUT /api/v1/showfile` to load a showfile.

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

The WebGlow portal is available at `http://<server-ip>:1828` and, when enabled, `https://<server-ip>:18443`. Its lights, settings, cues, command history, and uploaded media live in the named Docker volume `webglow-data`.

### HTTPS for phone and tablet displays

The Compose deployments start HTTPS on port `18443` by default, alongside the existing HTTP/API port `1828`. The Mac app also starts this HTTPS listener. HTTPS requests and WebSockets use the same application routes as HTTP. Set `WEBGLOW_HTTPS_ENABLED=false` to turn the HTTPS listener off.

When no custom certificate is configured, WebGlow creates a private local certificate authority and an IP/domain-matched server certificate, then stores them under the persistent data directory. The generated server certificate includes the host's visible network IP addresses, `localhost`, the machine hostname, any hostname in `WEBGLOW_PUBLIC_URL`, and names listed in `WEBGLOW_TLS_HOSTS`. WebGlow also learns the host from incoming HTTP requests and refreshes its local certificate, so the first visit to the portal on the LAN teaches it the Docker host's LAN IP. To prepare names before the first visit or to add a DNS hostname, configure them before starting the stack, for example:

```dotenv
WEBGLOW_PUBLIC_URL=https://192.168.1.20:18443
WEBGLOW_TLS_HOSTS=192.168.1.20,lights.example.org
```

The HTTPS certificate will match those names, but the generated local CA is not trusted by phones and browsers automatically. In **Settings → Server & API**, download the WebGlow CA certificate and install/trust it on each client device to remove the browser warning; the page also displays its SHA-256 fingerprint for verification. For a seamless guest experience without installing a CA on every phone, provide a publicly trusted certificate for a domain you control. A trusted custom cert must cover the exact host in the public URL and include its certificate chain.

To use a custom PEM certificate and key in Docker, mount their host directory read-only into the container (for example `/absolute/path/certs:/certs:ro` in the Portainer stack), then set:

```dotenv
WEBGLOW_TLS_CERT_FILE=/certs/fullchain.pem
WEBGLOW_TLS_KEY_FILE=/certs/privkey.pem
WEBGLOW_PUBLIC_URL=https://lights.example.org:18443
```

If HTTPS is enabled, WebGlow's generated join and display links use HTTPS. Existing HTTP access remains available on port `1828`, so HTTP-based automations can continue to work. If you save a public URL for a different hostname without opening WebGlow through that hostname over HTTP, restart WebGlow so it can refresh the generated certificate SANs from the saved URL.

### Cloudflare Tunnel remote access

WebGlow can run a remotely managed Cloudflare Tunnel connector from **Settings → Server & API → Cloudflare Tunnel**. In the Cloudflare dashboard, create a tunnel under **Networking → Tunnels**, then add a **Published application** route for your domain with the service URL `http://127.0.0.1:1828`. Paste the tunnel's connector token into WebGlow, save, and connect. Set the same public HTTPS origin in the **Public application URL** field so guest QR codes and fixture URLs use the Cloudflare hostname. Optionally enable automatic tunnel startup.

The token is persisted in the WebGlow settings file, which is written with owner-only file permissions, and is never returned by its API. The connector uses Cloudflare's `TUNNEL_TOKEN` environment variable instead of a command-line argument. The Docker image includes `cloudflared`; for the macOS app, install it with `brew install cloudflared`. Cloudflare Tunnel publishes the app over HTTPS without requiring a venue router change, but protect the WebGlow portal with its username/password and consider a Cloudflare Access policy if the portal itself should not be public. See Cloudflare's [tunnel setup guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) and [cloudflared downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).

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
   | `WEBGLOW_HTTPS_ENABLED` | `true` by default; set to `false` to disable HTTPS. |
   | `WEBGLOW_HTTPS_PORT` | `18443` by default; HTTPS port inside the container. |
   | `WEBGLOW_HTTPS_HOST_PORT` | `18443` by default; host-facing port. Use `443` only when it is free, then configure the public URL without a port. |
   | `WEBGLOW_PUBLIC_URL` | Optional full public URL, e.g. `https://lights.example.org:18443`; it also contributes its host to the generated certificate. |
   | `WEBGLOW_TLS_HOSTS` | Optional comma-separated DNS names/IPs to include in the generated certificate, especially the Docker host's LAN IP. |
   | `WEBGLOW_TLS_CERT_FILE` / `WEBGLOW_TLS_KEY_FILE` | Optional custom PEM certificate and private-key paths. Add a read-only bind mount for the certificate directory (e.g. `/srv/webglow/certs:/certs:ro`). |
   | `WEBGLOW_CORS_ORIGIN` | Optional; keep `*` for the default or set your controller's exact origin. |
   | `WEBGLOW_IMAGE` | Optional; defaults to `ghcr.io/jerielsr/webglow`. Set this for a fork or another registry. |
   | `WEBGLOW_IMAGE_TAG` | Optional; defaults to `latest`. Pin a version tag for controlled upgrades. |

5. Deploy the stack. Portainer pulls the image, creates the persistent `webglow-data` volume, and publishes HTTP on `1828` and HTTPS on `18443` by default.

For an equivalent command-line deployment after the image exists:

```sh
docker compose --env-file .env -f compose.portainer.yaml pull
docker compose --env-file .env -f compose.portainer.yaml up --detach
```

For updates, push a new image and use Portainer's **re-pull image and redeploy** option (or its Git/registry update automation). Do not delete the `webglow-data` volume during a normal redeploy: it holds the light state, cues, settings, command history, and media library.

Open the portal at `http://<server-ip>:1828` or `https://<server-ip>:18443`. On its first visit, create the portal username and password. **Control** is the live console programmer and cue stack; **Timelines** is a dedicated wide workspace for song-relative and project-absolute timecode editing; **Setup** creates and manages fixtures; **Monitor** provides process, host, traffic, display-socket, and guest activity diagnostics; **Settings** contains server, container, account, public URL, and Cloudflare Tunnel settings. Programmer and master changes are sent live after a short input debounce, so an Apply action is not required. The portal uses client-side navigation and includes a PWA manifest/service worker, so moving between these views does not reload the application.

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

### Patch a uDMX fixture

DMX output is optional: browser lights, WLED, guest registration, and the programmer work without an adapter. Connect the original uDMX adapter (USB ID `16c0:05dc`) to the machine running WebGlow. In **Settings → DMX**, check adapter detection and output diagnostics. In **Setup**, choose a DMX fixture, select a profile, and type its start address, or open **Patch by channel** and drag a fixture onto the 512-channel grid (touch users can select a fixture and tap its start channel). Existing fixtures can be moved without deleting them. The fixture appears in the same programmer and cue workflows as browser and WLED fixtures. WebGlow sends only through the highest patched channel using the adapter's vendor `SetChannelRange` request described in [uDMX_cmds.h](https://github.com/mirdej/udmx/blob/master/common/uDMX_cmds.h). Dynamic effects refresh at 25 frames per second with a shared clock; unpatched addresses in the sent range are zeroed. Its profile maps operation mode, RGB, dimmer, speed, and fixed channels to the fixture's channel layout; custom operation-mode mappings use values in the fixture's manual, entered as `pattern=value` pairs.

In **Program → Quick effects**, select a ready-made chase, colour chase, rainbow, breathe, sparkle, strobe, or ramp, then tune colour, speed, direction, and fade with the programmer controls. Effects apply live to selected fixtures (or all fixtures when none are selected) and can be saved into a cue. If macOS reports that the uDMX device did not respond (`0xe00002ed`), reconnect the adapter and make sure another lighting application is not using it; this is an IOKit “device not responding” status, not a WebGlow account or browser permission error.

The built-in Stairville profile is five channels in this order: Operation Mode, Red, Green, Blue, Speed. Fixture variants can use different channel order or mode ranges, so verify that the fixture is set to the matching five-channel personality. If it differs, create a custom profile rather than patching against a different channel mode.

The uDMX design is bus-powered and lacks galvanic isolation; its manufacturer warns that wiring faults can damage the USB host. Use the safety precautions documented by [Anyma](https://www.anyma.ch/research/udmx/). Docker needs direct access to the USB device: on a Linux Docker host, find its current device node (for example with `lsusb` and `ls -l /dev/bus/usb/001/004`), then add a `devices:` mapping under the `webglow` service in the Compose/Portainer stack, replacing that example path with the actual node on the Docker host:

```yaml
devices:
  - /dev/bus/usb/001/004:/dev/bus/usb/001/004
```

Grant the container's `node` user read/write access to that USB device using the host's udev/group permissions; the USB bus/device number can change after reconnecting. Docker Desktop on macOS does not expose an attached USB adapter to containers by default, so use the native macOS app when the adapter is plugged into a Mac.

API endpoints:

```text
GET    /api/v1/dmx/status
GET    /api/v1/dmx/profiles
POST   /api/v1/dmx/profiles
PATCH  /api/v1/dmx/profiles/:profileId
DELETE /api/v1/dmx/profiles/:profileId
PATCH  /api/v1/lights/:lightId/dmx-patch
```

Create a fixture through `POST /api/v1/lights` with a patch profile and address:

```json
{
  "id": "front-par",
  "name": "Front PAR",
  "kind": "dmx",
  "dmx": {
    "profileId": "stairville-led-par-64-5ch",
    "startAddress": 1
  }
}
```

### Audience guest lights

For an audience, open **Settings** → **Audience registration** and enable guest access. The join QR is shown in **Setup → Fixture workflow** and in Settings; click any QR preview to enlarge it, then download a transparent PNG from the enlarged view. A guest opens the link, enters a display name and seating section, and is redirected to a unique full-screen light page. Their fixture appears immediately in the normal console fixture sheet, so it can be selected, programmed, included in cues, or controlled with every light at once. This guest flow does not require uDMX hardware.

Guest devices keep an opaque browser token so they can return to the same fixture without registering again during **Settings → Audience → Remember this device for**. Their light is retained at least until that grace period expires, even if automatic inactive-guest cleanup is configured for a shorter interval. From the display information button, a guest can choose **Leave and remove my light** to deregister their fixture and clear the saved browser profile.

Display pages request the browser Screen Wake Lock automatically where available. If the browser requires a gesture, a small **Keep screen awake** button appears on the display; the same control remains in the display information panel. Wake Lock requires HTTPS in browsers that enforce secure contexts and may be released by the operating system, so it cannot be guaranteed on every device. Cloudflare Tunnel is one way to provide the HTTPS URL; avoid hidden looping media as a workaround.

Guest registration is closed by default and is rate-limited to 12 registrations per source network every 10 minutes. Close it once everyone has joined. The **Masters** panel shows registered and active guest counts, active guest WebSocket connections, WebSocket data sent to guest displays, and the persisted state footprint for guest fixtures. This makes it practical to watch audience participation without exposing the portal login or API bearer token.

In **Settings**, command-history retention can be set to all, one year, one month, one week, or one day; shortening retention permanently removes older entries, and the panel reports its on-disk footprint. The command line's **History** control opens the retained operator log in pages. Optional guest cleanup removes QR-created fixtures after their display has been absent for the selected inactivity period.

The **Display media library** accepts JPEG, PNG, WebP, GIF, MP4, and WebM uploads up to 40 MB. Images, animated GIFs, and muted/looping videos are hosted in the persistent `DATA_DIR/media` folder and loaded by browser displays from their WebGlow URL. Video supports HTTP byte ranges and long-lived browser caching; the image/video bytes are not sent inside lighting WebSocket messages. To keep audience Wi‑Fi responsive, use short, low-resolution clips. When recording cues, choose **All current & future** to make a cue dynamically follow the fixture count; **Auto-scale effect** recalculates phase offsets whenever that active cue is run or the fixture roster changes.

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
| `POST` | `/api/v1/lights` | Create a web display, WLED fixture, or DMX fixture with `kind: "dmx"` and a `dmx` profile/address object. |
| `GET` | `/api/v1/dmx/status` | Check whether the uDMX adapter is connected and how many DMX fixtures are patched. |
| `GET` / `POST` | `/api/v1/dmx/profiles` | List built-in/custom profiles or create a custom profile. |
| `PATCH` / `DELETE` | `/api/v1/dmx/profiles/:profileId` | Update or delete a custom profile (profiles in use cannot be deleted). |
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
| `GET` | `/api/v1/history` | History count/storage summary; add `?includeEvents=true&offset=0` to fetch up to 200 newest-first entries per page. |
| `GET` / `PATCH` | `/api/v1/settings` | Read or set the public application URL used in display links. |
| `GET` / `PATCH` | `/api/v1/tunnel` | Read Cloudflare Tunnel status or update its saved token, hostname, and startup preference (token is never returned). |
| `POST` | `/api/v1/tunnel/start` | Start the configured `cloudflared` connector. |
| `POST` | `/api/v1/tunnel/stop` | Stop the running connector. |
| `GET` / `POST` | `/api/v1/media` | List or upload display media (multipart field `file`). |
| `DELETE` | `/api/v1/media/:assetId` | Remove a media asset and clear it from displays using it. |
| `GET` | `/media/:assetId` | Public, cacheable media stream used by display devices. |
| `GET` | `/api/v1/guest-registration` | Public registration availability check. |
| `POST` | `/api/v1/guest-registration` | Publicly register one unique browser light when guest access is enabled. |
| `GET` | `/api/v1/guest-registration/qr` | Authenticated SVG QR code for the join URL. |
| `GET` | `/api/v1/guests` | Authenticated guest counts, activity, and guest-specific resource usage. |
| `DELETE` | `/api/v1/lights/:id` | Remove a light and turn connected displays black. |
| `GET` | `/display/:id` | Full-screen browser renderer for that light. |
| `GET` | `/api/v1/ws?role=display&lightId=:id` | Display-only live state stream. |

For multi-light automation, `POST /api/v1/lights/batch` accepts `{ "ids": "all" | ["id"], "state": { ...patch } }`. `POST /api/v1/lights/chase` accepts `ids`, `speed`, `fadeMs`, optional `color`, and optional `on`; it assigns evenly spaced phase offsets. A console cue is recorded through `POST /api/v1/scenes` with an `id` such as `1` or `12.5`, a target `ids` value, and an output `state`. Set `ids` to `all` for a dynamic cue that includes fixtures joining later; optional `scaleEffect: true` redistributes effect phase offsets when the cue runs and as the fixture roster changes.

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
| `DATA_DIR` | `./data` locally, `/data` in Docker | Directory containing persisted lights, settings, cues, timecode, media, and `dmx-profiles.json`. |
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
