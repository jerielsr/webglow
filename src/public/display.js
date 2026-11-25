(() => {
  "use strict";

  const API_ROOT = "/api/v1";
  const REST_POLL_INTERVAL_MS = 5_000;
  const RECONNECT_INITIAL_DELAY_MS = 1_000;
  const RECONNECT_MAX_DELAY_MS = 30_000;
  const SOCKET_CONNECT_TIMEOUT_MS = 8_000;
  const MIN_EFFECT_HZ = 0.05;
  const MAX_EFFECT_HZ = 3;
  const ALLOWED_PATTERNS = new Set(["solid", "breathe", "pulse", "strobe", "rainbow", "chase", "twinkle", "ramp-up", "ramp-down", "multi-chase"]);
  const VISUAL_LAYER_PATTERNS = new Set(["snowflakes", "squares", "orbit"]);

  const canvas = document.querySelector("#light-canvas");
  const context = canvas.getContext("2d", { alpha: false });
  const overlay = document.querySelector("#display-overlay");
  const overlayToggle = document.querySelector("#overlay-toggle");
  const overlayClose = document.querySelector("#overlay-close");
  const statusElement = document.querySelector("#connection-status");
  const lightNameElement = document.querySelector("#light-name");
  const connectionDetailElement = document.querySelector("#connection-detail");
  const fullscreenButton = document.querySelector("#fullscreen-button");
  const leaveLightButton = document.querySelector("#leave-light-button");
  const leaveLightMessage = document.querySelector("#leave-light-message");
  const wakeLockStatus = document.querySelector("#wake-lock-status");

  const defaultState = Object.freeze({
    on: false,
    brightness: 0,
    color: "#ffffff",
    pattern: "solid",
    speed: 0,
    fadeMs: 0,
    phaseOffset: 0,
    mediaOpacity: 100,
    layers: [],
  });

  const lightId = getLightIdFromPath();
  const initialLight = {
    id: lightId || "",
    name: lightId ? `Light ${lightId}` : "No light selected",
    isGuest: false,
    state: { ...defaultState },
    revision: null,
    updatedAt: null,
    updatedAtMs: 0,
  };

  let light = initialLight;
  let lastRevision = null;
  let lastUpdatedAtMs = 0;
  let effectStartedAtMs = Date.now();
  let lightDeleted = false;
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let socketConnectTimer = null;
  let restPollTimer = null;
  let restFetchInFlight = false;
  let wakeLock = null;
  let wakeLockRequestPending = false;
  let wakeFallbackVideo = null;
  let wakeFallbackStream = null;
  let wakeFallbackCanvas = null;
  let wakeFallbackTimer = null;
  let wakeFallbackActive = false;
  // Displays request the browser wake lock automatically. If that is blocked,
  // try a muted, nearly invisible canvas-video fallback and retry on visibility
  // changes and user interaction; browser and OS policies can still override it.
  let wakeLockRequested = true;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let devicePixelRatio = 1;
  let connection = { state: "initial", message: "" };
  let transition = null;
  let mediaElement = null;
  let mediaUrl = "";
  let mediaKind = "";
  let mediaStartedAtMs = 0;

  const colorScratch = document.createElement("canvas");
  colorScratch.width = 1;
  colorScratch.height = 1;
  const colorContext = colorScratch.getContext("2d", { willReadFrequently: true });

  function getLightIdFromPath() {
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    const displayIndex = pathParts.indexOf("display");
    const encodedLightId = displayIndex === -1 ? "" : pathParts[displayIndex + 1];

    if (!encodedLightId) {
      return "";
    }

    try {
      return decodeURIComponent(encodedLightId);
    } catch {
      return encodedLightId;
    }
  }

  function clamp(value, minimum, maximum, fallback) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return fallback;
    }

    return Math.min(maximum, Math.max(minimum, numericValue));
  }

  function booleanValue(value, fallback = false) {
    if (value === true || value === false) {
      return value;
    }

    if (value === 1 || value === "true") {
      return true;
    }

    if (value === 0 || value === "false") {
      return false;
    }

    return fallback;
  }

  function normalisePattern(value) {
    const pattern = typeof value === "string" ? value.toLowerCase() : "";
    return ALLOWED_PATTERNS.has(pattern) ? pattern : "solid";
  }

  function normaliseColor(value, fallback) {
    if (typeof value !== "string" || !value.trim()) {
      return fallback;
    }

    const candidate = value.trim();
    if (window.CSS && typeof window.CSS.supports === "function" && !window.CSS.supports("color", candidate)) {
      return fallback;
    }

    return candidate;
  }

  function normaliseColors(value, fallback) {
    if (!Array.isArray(value)) return fallback;
    const colors = value.slice(0, 8).map((color) => normaliseColor(color, "")).filter(Boolean);
    return colors.length >= 2 ? colors : fallback;
  }

  function normaliseColorTransition(value, fallback = "snap") {
    if (value === "ramp") return "ramp-up";
    return ["snap", "fade", "ramp-up", "ramp-down"].includes(value) ? value : fallback;
  }

  function normaliseColorTransitions(value, colorCount, fallback) {
    if (colorCount < 2) return [];
    return Array.from({ length: colorCount }, (_, index) => normaliseColorTransition(value?.[index], fallback));
  }

  function normaliseResource(resource) {
    const rawState = resource && typeof resource.state === "object" && resource.state ? resource.state : {};
    const updatedAt = typeof resource?.updatedAt === "string" ? resource.updatedAt : null;
    const parsedUpdatedAt = updatedAt ? Date.parse(updatedAt) : NaN;
    const patternStartedAt = Number(rawState.patternStartedAt);

    return {
      id: resource?.id === undefined || resource?.id === null ? lightId : String(resource.id),
      name: typeof resource?.name === "string" && resource.name.trim() ? resource.name.trim() : `Light ${lightId}`,
      isGuest: Boolean(resource?.guest),
      state: {
        on: booleanValue(rawState.on, defaultState.on),
        brightness: clamp(rawState.brightness, 0, 100, defaultState.brightness),
        color: normaliseColor(rawState.color, defaultState.color),
        colors: normaliseColors(rawState.colors, []),
        colorTransition: normaliseColorTransition(rawState.colorTransition),
        colorTransitions: normaliseColorTransitions(rawState.colorTransitions, Array.isArray(rawState.colors) ? Math.min(8, rawState.colors.length) : 0, normaliseColorTransition(rawState.colorTransition)),
        colorStepMs: clamp(rawState.colorStepMs, 100, 60000, 750),
        pattern: normalisePattern(rawState.pattern),
        speed: clamp(rawState.speed, 0, 100, defaultState.speed),
        fadeMs: clamp(rawState.fadeMs, 0, 60000, defaultState.fadeMs),
        phaseOffset: clamp(rawState.phaseOffset, 0, 1, defaultState.phaseOffset),
        mediaUrl: typeof rawState.mediaUrl === "string" ? rawState.mediaUrl : "",
        mediaKind: rawState.mediaKind === "video" ? "video" : rawState.mediaUrl ? "image" : "",
        mediaStartedAt: Number(rawState.mediaStartedAt) || 0,
        mediaOpacity: clamp(rawState.mediaOpacity, 0, 100, 100),
        layers: normaliseLayers(rawState.layers),
        // Optional: newer servers provide this to keep many displays in phase.
        patternStartedAt: Number.isFinite(patternStartedAt) && patternStartedAt > 0 ? patternStartedAt : 0,
      },
      revision: resource?.revision ?? null,
      updatedAt,
      updatedAtMs: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0,
    };
  }

  function normaliseLayers(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 8).filter((layer) => layer && typeof layer === "object" && VISUAL_LAYER_PATTERNS.has(layer.pattern)).map((layer, index) => ({
      id: typeof layer.id === "string" ? layer.id : `layer-${index + 1}`,
      pattern: layer.pattern,
      color: normaliseColor(layer.color, "#EAF8FF"),
      opacity: clamp(layer.opacity, 0, 100, 68),
      density: Math.round(clamp(layer.density, 1, 120, 30)),
      size: clamp(layer.size, 8, 100, 48),
      speed: clamp(layer.speed, 0, 100, 35),
    }));
  }

  function isNewerResource(nextLight) {
    const nextRevision = Number(nextLight.revision);
    const currentRevision = Number(lastRevision);

    if (Number.isFinite(nextRevision) && Number.isFinite(currentRevision)) {
      if (nextRevision < currentRevision) {
        return false;
      }

      if (nextRevision > currentRevision) {
        return true;
      }
    }

    if (nextLight.updatedAtMs && lastUpdatedAtMs && nextLight.updatedAtMs < lastUpdatedAtMs) {
      return false;
    }

    return true;
  }

  function applyResource(resource) {
    if (!resource || typeof resource !== "object") {
      return;
    }

    const nextLight = normaliseResource(resource);
    if (!nextLight.id || (lightId && nextLight.id !== lightId) || !isNewerResource(nextLight)) {
      return;
    }

    const stateChanged =
      light.state.pattern !== nextLight.state.pattern ||
      light.updatedAt !== nextLight.updatedAt ||
      light.state.speed !== nextLight.state.speed ||
      light.state.colorTransition !== nextLight.state.colorTransition ||
      JSON.stringify(light.state.colorTransitions) !== JSON.stringify(nextLight.state.colorTransitions) ||
      light.state.colorStepMs !== nextLight.state.colorStepMs ||
      JSON.stringify(light.state.layers) !== JSON.stringify(nextLight.state.layers) ||
      light.state.patternStartedAt !== nextLight.state.patternStartedAt;
    const mediaChanged = light.state.mediaUrl !== nextLight.state.mediaUrl || light.state.mediaKind !== nextLight.state.mediaKind || light.state.mediaStartedAt !== nextLight.state.mediaStartedAt;

    const visualChanged =
      light.state.on !== nextLight.state.on ||
      light.state.brightness !== nextLight.state.brightness ||
      light.state.color !== nextLight.state.color;
    const paletteChanged = JSON.stringify(light.state.colors) !== JSON.stringify(nextLight.state.colors);
    if ((visualChanged || paletteChanged) && nextLight.state.fadeMs > 0) {
      transition = {
        from: {
          on: light.state.on,
          brightness: light.state.brightness,
          color: light.state.color,
        },
        startedAt: Date.now(),
        duration: nextLight.state.fadeMs,
      };
    } else if (visualChanged || paletteChanged) {
      transition = null;
    }

    light = nextLight;
    if (mediaChanged) setDisplayMedia(nextLight.state.mediaUrl, nextLight.state.mediaKind, nextLight.state.mediaStartedAt);
    lastRevision = nextLight.revision;
    lastUpdatedAtMs = nextLight.updatedAtMs || lastUpdatedAtMs;

    if (stateChanged) {
      effectStartedAtMs = nextLight.state.patternStartedAt || nextLight.updatedAtMs || Date.now();
    }

    updateDetails();
  }

  function setDisplayMedia(url, kind, startedAt) {
    if (mediaElement && mediaUrl === url && mediaKind === kind && mediaStartedAtMs === Number(startedAt)) return;
    if (mediaElement instanceof HTMLVideoElement) {
      mediaElement.pause();
      mediaElement.removeAttribute("src");
      mediaElement.load();
    }
    mediaElement = null;
    mediaUrl = url || "";
    mediaKind = kind || "";
    mediaStartedAtMs = Number(startedAt) || Date.now();
    if (!mediaUrl) return;
    if (mediaKind === "video") {
      const video = document.createElement("video");
      video.src = mediaUrl;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      video.addEventListener("loadedmetadata", syncVideoPlayback, { once: true });
      mediaElement = video;
      void video.play().catch(() => undefined);
    } else {
      const image = new Image();
      image.decoding = "async";
      image.src = mediaUrl;
      mediaElement = image;
    }
  }

  function syncVideoPlayback() {
    if (!(mediaElement instanceof HTMLVideoElement) || !Number.isFinite(mediaElement.duration) || mediaElement.duration <= 0) return;
    const target = ((Date.now() - mediaStartedAtMs) / 1000) % mediaElement.duration;
    if (Math.abs(mediaElement.currentTime - target) > 1) {
      try { mediaElement.currentTime = target; } catch { /* Metadata may not yet allow a seek. */ }
    }
    if (mediaElement.paused) void mediaElement.play().catch(() => undefined);
  }

  function drawMedia(element, brightness) {
    const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
    const height = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
    if (!width || !height) return false;
    if (element instanceof HTMLVideoElement) syncVideoPlayback();
    const scale = Math.max(canvasWidth / width, canvasHeight / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    context.globalAlpha = Math.max(0, Math.min(1, brightness / 100));
    context.drawImage(element, (canvasWidth - drawWidth) / 2, (canvasHeight - drawHeight) / 2, drawWidth, drawHeight);
    context.globalAlpha = 1;
    return true;
  }

  function updateDetails() {
    document.title = `${light.name} – WebGlow`;
    lightNameElement.textContent = light.name;
    leaveLightButton.hidden = !light.isGuest;
  }

  function setConnection(state, message) {
    if (connection.state === state && connection.message === message) {
      return;
    }

    connection = { state, message };
    statusElement.dataset.state = state;
    statusElement.textContent = message;
    connectionDetailElement.textContent = message;
  }

  function apiUrl(pathname) {
    return new URL(pathname, window.location.origin).toString();
  }

  async function fetchLight() {
    if (!lightId || restFetchInFlight || lightDeleted) {
      return;
    }

    restFetchInFlight = true;
    try {
      const response = await fetch(apiUrl(`${API_ROOT}/lights/${encodeURIComponent(lightId)}`), {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (response.status === 404) {
        setConnection("offline", "Your light is not ready yet. Please ask your host for help.");
        setOverlayVisible(true);
        return;
      }

      if (!response.ok) {
        throw new Error(`State request failed (${response.status})`);
      }

      applyResource(await response.json());
      if (!isSocketOpen()) {
        setConnection("fallback", "Connected");
      }
    } catch (error) {
      if (!isSocketOpen()) {
        setConnection("offline", navigator.onLine === false ? "No internet connection. Check your Wi-Fi." : "Connection interrupted. Trying again…");
      }
    } finally {
      restFetchInFlight = false;
    }
  }

  function startRestPolling() {
    if (restPollTimer || !lightId || lightDeleted) {
      return;
    }

    void fetchLight();
    restPollTimer = window.setInterval(() => {
      void fetchLight();
    }, REST_POLL_INTERVAL_MS);
  }

  function stopRestPolling() {
    if (restPollTimer) {
      window.clearInterval(restPollTimer);
      restPollTimer = null;
    }
  }

  function isSocketOpen() {
    return Boolean(socket && socket.readyState === WebSocket.OPEN);
  }

  function socketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${window.location.host}${API_ROOT}/ws`);
    url.searchParams.set("role", "display");
    url.searchParams.set("lightId", lightId);
    return url.toString();
  }

  function clearSocketConnectTimer() {
    if (socketConnectTimer) {
      window.clearTimeout(socketConnectTimer);
      socketConnectTimer = null;
    }
  }

  function connectSocket() {
    if (!lightId) {
      setConnection("error", "This light link is incomplete. Please scan the host’s QR code again.");
      return;
    }

    if (lightDeleted) {
      return;
    }

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (navigator.onLine === false) {
      setConnection("offline", "No internet connection. Check your Wi-Fi.");
      startRestPolling();
      return;
    }

    clearReconnectTimer();
    setConnection("connecting", "Connecting to your light…");

    let nextSocket;
    try {
      nextSocket = new WebSocket(socketUrl());
    } catch {
      setConnection("error", "Connection interrupted. Trying again…");
      startRestPolling();
      scheduleReconnect();
      return;
    }

    socket = nextSocket;
    socketConnectTimer = window.setTimeout(() => {
      if (socket === nextSocket && nextSocket.readyState === WebSocket.CONNECTING) {
        nextSocket.close();
      }
    }, SOCKET_CONNECT_TIMEOUT_MS);

    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket) {
        return;
      }

      clearSocketConnectTimer();
      reconnectAttempt = 0;
      stopRestPolling();
      setConnection("live", "Connected to the show");
      void fetchLight();
    });

    nextSocket.addEventListener("message", (event) => {
      if (socket !== nextSocket || typeof event.data !== "string") {
        return;
      }

      try {
        const message = JSON.parse(event.data);
        if (message && message.type === "light.deleted" && message.lightId === lightId) {
          handleLightDeleted();
          return;
        }
        if (
          message &&
          (message.type === "state.snapshot" || message.type === "state.changed") &&
          message.light
        ) {
          applyResource(message.light);
        }
      } catch {
        // Ignore malformed messages and keep the last known state on screen.
      }
    });

    nextSocket.addEventListener("error", () => {
      // Browsers do not expose a useful WebSocket error. The close handler supplies the fallback.
    });

    nextSocket.addEventListener("close", () => {
      clearSocketConnectTimer();
      if (socket !== nextSocket) {
        return;
      }

      socket = null;
      if (lightDeleted) {
        return;
      }
      startRestPolling();
      scheduleReconnect();
    });
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || !lightId || lightDeleted || navigator.onLine === false) {
      return;
    }

    const exponentialDelay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_INITIAL_DELAY_MS * 2 ** reconnectAttempt,
    );
    const jitter = Math.round(Math.random() * 350);
    const delay = exponentialDelay + jitter;
    reconnectAttempt += 1;
    setConnection("fallback", "Reconnecting to the show…");

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, delay);
  }

  function closeSocket() {
    clearSocketConnectTimer();
    if (socket) {
      const activeSocket = socket;
      socket = null;
      activeSocket.close();
    }
  }

  function handleLightDeleted() {
    if (lightDeleted) {
      return;
    }

    lightDeleted = true;
    stopRestPolling();
    clearReconnectTimer();
    closeSocket();
    light = {
      ...initialLight,
      state: { ...defaultState },
      updatedAt: null,
      updatedAtMs: 0,
    };
    lastRevision = null;
    lastUpdatedAtMs = 0;
    effectStartedAtMs = Date.now();
    updateDetails();
    setConnection("offline", "This light is no longer registered. Please ask your host for a new link.");
    setOverlayVisible(true);
  }

  function resizeCanvas() {
    const viewport = window.visualViewport;
    canvasWidth = Math.max(1, Math.floor(viewport?.width || window.innerWidth));
    canvasHeight = Math.max(1, Math.floor(viewport?.height || window.innerHeight));
    devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const backingWidth = Math.max(1, Math.floor(canvasWidth * devicePixelRatio));
    const backingHeight = Math.max(1, Math.floor(canvasHeight * devicePixelRatio));

    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }

    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  function speedToFrequency(speed) {
    return MIN_EFFECT_HZ + ((MAX_EFFECT_HZ - MIN_EFFECT_HZ) * clamp(speed, 0, 100, 0)) / 100;
  }

  function colourToRgb(value) {
    try {
      colorContext.clearRect(0, 0, 1, 1);
      colorContext.fillStyle = "#000000";
      colorContext.fillStyle = value;
      colorContext.fillRect(0, 0, 1, 1);
      const [red, green, blue] = colorContext.getImageData(0, 0, 1, 1).data;
      return { red, green, blue };
    } catch {
      return { red: 255, green: 255, blue: 255 };
    }
  }

  function scaleRgb(rgb, brightness) {
    const factor = clamp(brightness, 0, 100, 0) / 100;
    return {
      red: Math.round(rgb.red * factor),
      green: Math.round(rgb.green * factor),
      blue: Math.round(rgb.blue * factor),
    };
  }

  function mixRgb(from, to, progress) {
    return {
      red: Math.round(from.red + (to.red - from.red) * progress),
      green: Math.round(from.green + (to.green - from.green) * progress),
      blue: Math.round(from.blue + (to.blue - from.blue) * progress),
    };
  }

  function rgbCss(rgb) {
    return `rgb(${rgb.red} ${rgb.green} ${rgb.blue})`;
  }

  function rgbToHue(rgb) {
    const red = rgb.red / 255;
    const green = rgb.green / 255;
    const blue = rgb.blue / 255;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const delta = maximum - minimum;

    if (delta === 0) {
      return 0;
    }

    let hue;
    if (maximum === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (maximum === green) {
      hue = (blue - red) / delta + 2;
    } else {
      hue = (red - green) / delta + 4;
    }

    return (hue * 60 + 360) % 360;
  }

  function hueToRgb(hue) {
    const chroma = 1;
    const segment = ((hue % 360) + 360) % 360 / 60;
    const x = chroma * (1 - Math.abs((segment % 2) - 1));
    let red = 0;
    let green = 0;
    let blue = 0;

    if (segment < 1) {
      red = chroma;
      green = x;
    } else if (segment < 2) {
      red = x;
      green = chroma;
    } else if (segment < 3) {
      green = chroma;
      blue = x;
    } else if (segment < 4) {
      green = x;
      blue = chroma;
    } else if (segment < 5) {
      red = x;
      blue = chroma;
    } else {
      red = chroma;
      blue = x;
    }

    return {
      red: Math.round(red * 255),
      green: Math.round(green * 255),
      blue: Math.round(blue * 255),
    };
  }

  function fillBlack() {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, canvasWidth, canvasHeight);
  }

  function drawRainbow(baseHue, brightness, phase) {
    phase = ((phase % 1) + 1) % 1;
    const angle = phase * Math.PI * 2;
    const startX = canvasWidth / 2 + Math.cos(angle) * canvasWidth * 0.65;
    const startY = canvasHeight / 2 + Math.sin(angle) * canvasHeight * 0.65;
    const endX = canvasWidth - startX;
    const endY = canvasHeight - startY;
    const gradient = context.createLinearGradient(startX, startY, endX, endY);

    for (let stop = 0; stop <= 6; stop += 1) {
      const hue = baseHue + phase * 360 + stop * 60;
      gradient.addColorStop(stop / 6, rgbCss(scaleRgb(hueToRgb(hue), brightness)));
    }

    context.fillStyle = gradient;
    context.fillRect(0, 0, canvasWidth, canvasHeight);
  }

  function layerSeed(value) {
    let seed = 0;
    for (let index = 0; index < value.length; index += 1) seed = (seed * 31 + value.charCodeAt(index)) >>> 0;
    return seed / 0xffffffff;
  }

  function drawVisualLayer(layer, elapsedSeconds, brightness) {
    const alpha = Math.max(0, Math.min(1, layer.opacity / 100 * brightness / 100));
    if (!alpha) return;
    const frequency = speedToFrequency(layer.speed);
    const color = layer.color;
    const minDimension = Math.min(canvasWidth, canvasHeight);
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = Math.max(1, devicePixelRatio * 1.15);

    if (layer.pattern === "snowflakes") {
      const sizeBase = minDimension * (layer.size / 100) * 0.024;
      const fallRate = minDimension * (0.035 + frequency * 0.16);
      for (let index = 0; index < layer.density; index += 1) {
        const seed = layerSeed(layer.id + ":" + index);
        const drift = layerSeed(layer.id + ":drift:" + index);
        const x = ((seed * canvasWidth) + Math.sin(elapsedSeconds * 0.48 + drift * Math.PI * 2) * sizeBase * 3 + canvasWidth) % canvasWidth;
        const y = ((drift * canvasHeight + elapsedSeconds * fallRate * (0.55 + seed)) % canvasHeight);
        const radius = Math.max(1.6, sizeBase * (0.45 + seed * 0.55));
        context.beginPath();
        for (let arm = 0; arm < 6; arm += 1) {
          const angle = arm * Math.PI / 3;
          const dx = Math.cos(angle) * radius;
          const dy = Math.sin(angle) * radius;
          context.moveTo(x - dx, y - dy);
          context.lineTo(x + dx, y + dy);
        }
        context.stroke();
      }
    } else if (layer.pattern === "squares") {
      const columns = Math.max(2, Math.ceil(Math.sqrt(layer.density * canvasWidth / canvasHeight)));
      const rows = Math.max(1, Math.ceil(layer.density / columns));
      const cellWidth = canvasWidth / columns;
      const cellHeight = canvasHeight / rows;
      const side = Math.min(cellWidth, cellHeight) * (0.12 + layer.size / 100 * 0.48);
      for (let index = 0; index < layer.density; index += 1) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(elapsedSeconds * frequency * Math.PI * 2 + index * 2.399));
        context.globalAlpha = alpha * pulse;
        const inset = side * (0.12 + 0.08 * Math.sin(elapsedSeconds * frequency + index));
        context.strokeRect(column * cellWidth + (cellWidth - side) / 2 + inset, row * cellHeight + (cellHeight - side) / 2 + inset, Math.max(1, side - inset * 2), Math.max(1, side - inset * 2));
      }
    } else if (layer.pattern === "orbit") {
      const centerX = canvasWidth / 2;
      const centerY = canvasHeight / 2;
      const maxRadius = minDimension * (layer.size / 100) * 0.46;
      for (let ring = 1; ring <= 3; ring += 1) {
        context.globalAlpha = alpha * (0.3 + ring * 0.12);
        context.beginPath();
        context.arc(centerX, centerY, maxRadius * ring / 3, 0, Math.PI * 2);
        context.stroke();
      }
      const orbitCount = Math.min(layer.density, 80);
      for (let index = 0; index < orbitCount; index += 1) {
        const angle = elapsedSeconds * frequency * Math.PI * 2 + index * Math.PI * 2 / orbitCount;
        const ring = (index % 3) + 1;
        const radius = maxRadius * ring / 3;
        const dot = Math.max(2, minDimension * layer.size / 100 * 0.014);
        context.globalAlpha = alpha;
        context.beginPath();
        context.arc(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius, dot, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  function render() {
    if (!canvasWidth || !canvasHeight) {
      resizeCanvas();
    }

    const state = light.state;
    let active = state.on;
    let brightness = state.brightness;
    let rgb = colourToRgb(state.color);
    if (transition) {
      const progress = Math.min(1, Math.max(0, (Date.now() - transition.startedAt) / transition.duration));
      const fromBrightness = transition.from.on ? transition.from.brightness : 0;
      const toBrightness = state.on ? state.brightness : 0;
      brightness = fromBrightness + (toBrightness - fromBrightness) * progress;
      rgb = mixRgb(colourToRgb(transition.from.color), rgb, progress);
      active = brightness > 0;
      if (progress >= 1) {
        transition = null;
      }
    }
    if (!active || brightness <= 0) {
      fillBlack();
      window.requestAnimationFrame(render);
      return;
    }

    const elapsedSeconds = Math.max(0, (Date.now() - effectStartedAtMs) / 1_000);
    const frequency = speedToFrequency(state.speed);
    // Every effect uses the fixture's assigned phase. This lets a shared cue
    // travel across independent browser displays instead of making every
    // phone breathe, strobe, or cycle colour in lockstep.
    const phaseCycles = elapsedSeconds * frequency + state.phaseOffset;
    if (state.pattern === "multi-chase" && state.colors.length > 1) {
      const stagePosition = elapsedSeconds * 1000 / state.colorStepMs + state.phaseOffset * state.colors.length;
      const stage = Math.floor(stagePosition);
      const colorIndex = ((stage % state.colors.length) + state.colors.length) % state.colors.length;
      rgb = colourToRgb(state.colors[colorIndex]);
      const stepTransition = state.colorTransitions[colorIndex] || state.colorTransition;
      if (stepTransition !== "snap") {
        const nextColor = colourToRgb(state.colors[(colorIndex + 1) % state.colors.length]);
        const progress = stagePosition - stage;
        const eased = stepTransition === "fade"
          ? progress * progress * (3 - 2 * progress)
          : stepTransition === "ramp-up"
            ? progress * progress
            : stepTransition === "ramp-down"
              ? 1 - (1 - progress) * (1 - progress)
              : progress;
        rgb = mixRgb(rgb, nextColor, eased);
      }
    }
    if (state.pattern === "breathe" || state.pattern === "pulse") {
      const phase = phaseCycles * Math.PI * 2;
      const floor = state.pattern === "breathe" ? 0.28 : 0.08;
      const envelope = floor + (1 - floor) * (0.5 - 0.5 * Math.cos(phase));
      brightness *= envelope;
    } else if (state.pattern === "strobe") {
      const phase = phaseCycles % 1;
      if (phase >= 0.34) {
        fillBlack();
      } else {
        context.fillStyle = rgbCss(scaleRgb(rgb, brightness));
        context.fillRect(0, 0, canvasWidth, canvasHeight);
      }
    } else if (state.pattern === "rainbow") {
      drawRainbow(rgbToHue(rgb), brightness, phaseCycles);
    } else if (state.pattern === "chase") {
      const phase = phaseCycles % 1;
      const distance = Math.abs(phase - 0.5) * 2;
      brightness *= 0.08 + 0.92 * (1 - distance) ** 3;
    } else if (state.pattern === "twinkle") {
      const seed = Math.sin((elapsedSeconds * frequency + state.phaseOffset * 13.37) * 9.71);
      const sparkle = Math.max(0.12, seed > 0.72 ? 1 : 0.22 + ((seed + 1) / 2) * 0.26);
      brightness *= sparkle;
    } else if (state.pattern === "ramp-up") {
      brightness *= 0.08 + 0.92 * (((phaseCycles % 1) + 1) % 1);
    } else if (state.pattern === "ramp-down") {
      brightness *= 1 - 0.92 * (((phaseCycles % 1) + 1) % 1);
    } else if (state.pattern === "multi-chase") {
      const progress = ((phaseCycles % 1) + 1) % 1;
      brightness *= 0.1 + 0.9 * Math.max(0, 1 - Math.abs(progress - 0.5) * 2);
    }

    if (state.pattern !== "strobe" && state.pattern !== "rainbow") {
      context.fillStyle = rgbCss(scaleRgb(rgb, brightness));
      context.fillRect(0, 0, canvasWidth, canvasHeight);
    }
    if (mediaElement) drawMedia(mediaElement, brightness * state.mediaOpacity / 100);
    state.layers.forEach((layer) => drawVisualLayer(layer, elapsedSeconds, brightness));
    window.requestAnimationFrame(render);
  }

  function setOverlayVisible(visible) {
    overlay.hidden = !visible;
    overlayToggle.setAttribute("aria-expanded", String(visible));
    if (visible) {
      overlayClose.focus({ preventScroll: true });
    } else {
      overlayToggle.focus({ preventScroll: true });
    }
  }

  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function updateFullscreenButton() {
    fullscreenButton.textContent = isFullscreen() ? "Exit fullscreen" : "Enter fullscreen";
  }

  async function toggleFullscreen() {
    try {
      if (isFullscreen()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (!exit) {
          throw new Error("Fullscreen is not supported by this browser");
        }
        await exit.call(document);
      } else {
        const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
        if (!request) {
          throw new Error("Fullscreen is not supported by this browser");
        }
        await request.call(document.documentElement);
      }
    } catch (error) {
      setConnection("error", "Full screen is not available on this device.");
    } finally {
      updateFullscreenButton();
    }
  }

  function updateWakeLockStatus() {
    const active = Boolean((wakeLock && !wakeLock.released) || wakeFallbackActive);
    if (wakeLockStatus) wakeLockStatus.textContent = active
      ? "Your screen is being kept awake automatically."
      : "WebGlow is asking your device to keep the screen awake. Your device settings may override this request.";
  }

  async function startVideoWakeFallback() {
    if (!HTMLCanvasElement.prototype.captureStream) return false;
    if (!wakeFallbackVideo) {
      wakeFallbackCanvas = document.createElement("canvas");
      wakeFallbackCanvas.width = 2;
      wakeFallbackCanvas.height = 2;
      const stream = wakeFallbackCanvas.captureStream(1);
      if (!stream) return false;
      wakeFallbackStream = stream;
      wakeFallbackVideo = document.createElement("video");
      wakeFallbackVideo.muted = true;
      wakeFallbackVideo.autoplay = true;
      wakeFallbackVideo.playsInline = true;
      wakeFallbackVideo.setAttribute("playsinline", "");
      wakeFallbackVideo.setAttribute("aria-hidden", "true");
      wakeFallbackVideo.tabIndex = -1;
      wakeFallbackVideo.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:.001;pointer-events:none;z-index:-1";
      wakeFallbackVideo.srcObject = stream;
      wakeFallbackVideo.addEventListener("playing", () => {
        wakeFallbackActive = true;
        updateWakeLockStatus();
      });
      wakeFallbackVideo.addEventListener("pause", () => {
        wakeFallbackActive = false;
        updateWakeLockStatus();
      });
      document.body.append(wakeFallbackVideo);
      let frame = 0;
      const context = wakeFallbackCanvas.getContext("2d", { alpha: false });
      wakeFallbackTimer = window.setInterval(() => {
        frame = (frame + 1) % 2;
        context.fillStyle = frame ? "#010101" : "#000000";
        context.fillRect(0, 0, 2, 2);
      }, 1000);
    }
    try {
      await wakeFallbackVideo.play();
      wakeFallbackActive = !wakeFallbackVideo.paused;
      updateWakeLockStatus();
      return wakeFallbackActive;
    } catch {
      wakeFallbackActive = false;
      updateWakeLockStatus();
      return false;
    }
  }

  async function stopVideoWakeFallback() {
    if (wakeFallbackTimer) window.clearInterval(wakeFallbackTimer);
    wakeFallbackTimer = null;
    wakeFallbackActive = false;
    if (wakeFallbackVideo) {
      wakeFallbackVideo.pause();
      wakeFallbackVideo.srcObject = null;
      wakeFallbackVideo.remove();
      wakeFallbackVideo = null;
    }
    wakeFallbackStream?.getTracks().forEach((track) => track.stop());
    wakeFallbackStream = null;
    wakeFallbackCanvas = null;
    updateWakeLockStatus();
  }

  async function requestWakeLock({ quiet = false } = {}) {
    wakeLockRequested = true;
    if (wakeLockRequestPending) return Boolean((wakeLock && !wakeLock.released) || wakeFallbackActive);
    wakeLockRequestPending = true;
    try {
      if ("wakeLock" in navigator) {
        try {
          wakeLock = await navigator.wakeLock.request("screen");
          wakeLock.addEventListener("release", () => {
            wakeLock = null;
            updateWakeLockStatus();
          });
          updateWakeLockStatus();
          return true;
        } catch {}
      }
      const fallbackStarted = await startVideoWakeFallback();
      if (!fallbackStarted && wakeLockStatus) wakeLockStatus.textContent = "WebGlow cannot keep this screen awake automatically. Your device settings may turn it off.";
      updateWakeLockStatus();
      return fallbackStarted;
    } finally {
      wakeLockRequestPending = false;
    }
  }

  overlayToggle.addEventListener("click", () => setOverlayVisible(overlay.hidden));
  overlayClose.addEventListener("click", () => setOverlayVisible(false));
  fullscreenButton.addEventListener("click", () => void toggleFullscreen());
  leaveLightButton.addEventListener("click", async () => {
    if (!window.confirm("Leave the audience lights and remove this device from the host’s fixture list?")) return;
    let token = "";
    try { token = window.localStorage.getItem("webglow.guest-session") || ""; } catch {}
    if (!token) {
      leaveLightMessage.textContent = "This device does not have a saved leave code. Please ask the host to remove it.";
      return;
    }
    leaveLightButton.disabled = true;
    leaveLightMessage.textContent = "Removing this device…";
    try {
      const response = await fetch(apiUrl(`${API_ROOT}/guest-registration/leave`), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ resumeToken: token }),
      });
      if (!response.ok) throw new Error("Could not remove this device right now.");
      try {
        window.localStorage.removeItem("webglow.guest-session");
        window.localStorage.removeItem("webglow.guest-profile");
      } catch {}
      window.location.replace("/join");
    } catch (error) {
      leaveLightMessage.textContent = error instanceof Error ? error.message : "Could not remove this device right now.";
      leaveLightButton.disabled = false;
    }
  });

  document.addEventListener("fullscreenchange", updateFullscreenButton);
  document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) {
      setOverlayVisible(false);
      return;
    }

    if (event.key.toLowerCase() === "h" || event.key === "?") {
      event.preventDefault();
      setOverlayVisible(overlay.hidden);
    }
  });

  window.addEventListener("resize", resizeCanvas, { passive: true });
  window.visualViewport?.addEventListener("resize", resizeCanvas, { passive: true });
  window.addEventListener("online", () => {
    void fetchLight();
    connectSocket();
  });
  window.addEventListener("offline", () => {
    closeSocket();
    setConnection("offline", "No internet connection. Check your Wi-Fi.");
    startRestPolling();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wakeLockRequested && !wakeLock) {
      void requestWakeLock({ quiet: true });
    }
  });
  document.addEventListener("pointerdown", () => {
    if (wakeLockRequested && !wakeLock) void requestWakeLock({ quiet: true });
  }, { passive: true });
  window.addEventListener("pagehide", () => {
    clearReconnectTimer();
    closeSocket();
    void stopVideoWakeFallback();
  });

  resizeCanvas();
  updateDetails();
  updateFullscreenButton();
  updateWakeLockStatus();
  void requestWakeLock({ quiet: true });

  if (!lightId) {
    setConnection("error", "This light link is incomplete. Please scan the host’s QR code again.");
    setOverlayVisible(true);
  } else {
    void fetchLight();
    connectSocket();
  }

  window.requestAnimationFrame(render);
})();
