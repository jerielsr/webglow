(() => {
  "use strict";

  const API_ROOT = "/api/v1";
  const REST_POLL_INTERVAL_MS = 5_000;
  const RECONNECT_INITIAL_DELAY_MS = 1_000;
  const RECONNECT_MAX_DELAY_MS = 30_000;
  const SOCKET_CONNECT_TIMEOUT_MS = 8_000;
  const MIN_EFFECT_HZ = 0.5;
  const MAX_EFFECT_HZ = 3;
  const ALLOWED_PATTERNS = new Set(["solid", "breathe", "pulse", "strobe", "rainbow", "chase", "twinkle"]);

  const canvas = document.querySelector("#light-canvas");
  const context = canvas.getContext("2d", { alpha: false });
  const overlay = document.querySelector("#display-overlay");
  const overlayToggle = document.querySelector("#overlay-toggle");
  const overlayClose = document.querySelector("#overlay-close");
  const statusElement = document.querySelector("#connection-status");
  const lightNameElement = document.querySelector("#light-name");
  const lightIdElement = document.querySelector("#light-id");
  const connectionDetailElement = document.querySelector("#connection-detail");
  const stateDetailElement = document.querySelector("#state-detail");
  const patternDetailElement = document.querySelector("#pattern-detail");
  const updatedDetailElement = document.querySelector("#updated-detail");
  const fullscreenButton = document.querySelector("#fullscreen-button");
  const wakeLockButton = document.querySelector("#wake-lock-button");

  const defaultState = Object.freeze({
    on: false,
    brightness: 0,
    color: "#ffffff",
    pattern: "solid",
    speed: 0,
    fadeMs: 0,
    phaseOffset: 0,
  });

  const lightId = getLightIdFromPath();
  const initialLight = {
    id: lightId || "",
    name: lightId ? `Light ${lightId}` : "No light selected",
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
  let wakeLockRequested = false;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let devicePixelRatio = 1;
  let connection = { state: "initial", message: "" };
  let transition = null;

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

  function normaliseResource(resource) {
    const rawState = resource && typeof resource.state === "object" && resource.state ? resource.state : {};
    const updatedAt = typeof resource?.updatedAt === "string" ? resource.updatedAt : null;
    const parsedUpdatedAt = updatedAt ? Date.parse(updatedAt) : NaN;
    const patternStartedAt = Number(rawState.patternStartedAt);

    return {
      id: resource?.id === undefined || resource?.id === null ? lightId : String(resource.id),
      name: typeof resource?.name === "string" && resource.name.trim() ? resource.name.trim() : `Light ${lightId}`,
      state: {
        on: booleanValue(rawState.on, defaultState.on),
        brightness: clamp(rawState.brightness, 0, 100, defaultState.brightness),
        color: normaliseColor(rawState.color, defaultState.color),
        pattern: normalisePattern(rawState.pattern),
        speed: clamp(rawState.speed, 0, 100, defaultState.speed),
        fadeMs: clamp(rawState.fadeMs, 0, 60000, defaultState.fadeMs),
        phaseOffset: clamp(rawState.phaseOffset, 0, 1, defaultState.phaseOffset),
        // Optional: newer servers provide this to keep many displays in phase.
        patternStartedAt: Number.isFinite(patternStartedAt) && patternStartedAt > 0 ? patternStartedAt : 0,
      },
      revision: resource?.revision ?? null,
      updatedAt,
      updatedAtMs: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0,
    };
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
      light.state.patternStartedAt !== nextLight.state.patternStartedAt;

    const visualChanged =
      light.state.on !== nextLight.state.on ||
      light.state.brightness !== nextLight.state.brightness ||
      light.state.color !== nextLight.state.color;
    if (visualChanged && nextLight.state.fadeMs > 0) {
      transition = {
        from: {
          on: light.state.on,
          brightness: light.state.brightness,
          color: light.state.color,
        },
        startedAt: Date.now(),
        duration: nextLight.state.fadeMs,
      };
    } else if (visualChanged) {
      transition = null;
    }

    light = nextLight;
    lastRevision = nextLight.revision;
    lastUpdatedAtMs = nextLight.updatedAtMs || lastUpdatedAtMs;

    if (stateChanged) {
      effectStartedAtMs = nextLight.state.patternStartedAt || nextLight.updatedAtMs || Date.now();
    }

    updateDetails();
  }

  function updateDetails() {
    const state = light.state;
    const prettyPattern = state.pattern.charAt(0).toUpperCase() + state.pattern.slice(1);
    const roundedBrightness = Math.round(state.brightness);
    const roundedSpeed = Math.round(state.speed);

    document.title = `${light.name} – WebGlow`;
    lightNameElement.textContent = light.name;
    lightIdElement.textContent = light.id ? `ID: ${light.id}` : "No light ID in this address";
    stateDetailElement.textContent = state.on ? `On · ${roundedBrightness}%` : "Off";
    patternDetailElement.textContent = `${prettyPattern} · speed ${roundedSpeed}%`;
    updatedDetailElement.textContent = formatTimestamp(light.updatedAt);
  }

  function formatTimestamp(value) {
    if (!value) {
      return "Waiting for state…";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Received";
    }

    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
        setConnection("offline", "This light has not been created. Use the WebGlow portal first.");
        setOverlayVisible(true);
        return;
      }

      if (!response.ok) {
        throw new Error(`State request failed (${response.status})`);
      }

      applyResource(await response.json());
      if (!isSocketOpen()) {
        setConnection("fallback", "Using REST fallback");
      }
    } catch (error) {
      if (!isSocketOpen()) {
        const detail = error instanceof Error ? error.message : "Unable to reach the light";
        setConnection("offline", detail);
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
      setConnection("error", "No light ID in this address");
      return;
    }

    if (lightDeleted) {
      return;
    }

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (navigator.onLine === false) {
      setConnection("offline", "Device is offline");
      startRestPolling();
      return;
    }

    clearReconnectTimer();
    setConnection("connecting", "Connecting…");

    let nextSocket;
    try {
      nextSocket = new WebSocket(socketUrl());
    } catch (error) {
      const detail = error instanceof Error ? error.message : "WebSocket is unavailable";
      setConnection("error", detail);
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
      setConnection("live", "Live updates connected");
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
    setConnection("fallback", `Reconnecting in ${Math.ceil(delay / 1_000)}s (REST fallback active)`);

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
    stateDetailElement.textContent = "Deleted";
    setConnection("offline", "This light was deleted in the WebGlow portal.");
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

  function drawRainbow(baseHue, brightness, elapsedSeconds, frequency) {
    const phase = (elapsedSeconds * frequency) % 1;
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
    if (state.pattern === "breathe" || state.pattern === "pulse") {
      const phase = elapsedSeconds * frequency * Math.PI * 2;
      const floor = state.pattern === "breathe" ? 0.28 : 0.08;
      const envelope = floor + (1 - floor) * (0.5 - 0.5 * Math.cos(phase));
      brightness *= envelope;
    } else if (state.pattern === "strobe") {
      const phase = (elapsedSeconds * frequency) % 1;
      if (phase >= 0.34) {
        fillBlack();
        window.requestAnimationFrame(render);
        return;
      }
    } else if (state.pattern === "rainbow") {
      drawRainbow(rgbToHue(rgb), brightness, elapsedSeconds, frequency);
      window.requestAnimationFrame(render);
      return;
    } else if (state.pattern === "chase") {
      const phase = (elapsedSeconds * frequency + state.phaseOffset) % 1;
      const distance = Math.abs(phase - 0.5) * 2;
      brightness *= 0.08 + 0.92 * (1 - distance) ** 3;
    } else if (state.pattern === "twinkle") {
      const seed = Math.sin((elapsedSeconds * frequency + state.phaseOffset * 13.37) * 9.71);
      const sparkle = Math.max(0.12, seed > 0.72 ? 1 : 0.22 + ((seed + 1) / 2) * 0.26);
      brightness *= sparkle;
    }

    context.fillStyle = rgbCss(scaleRgb(rgb, brightness));
    context.fillRect(0, 0, canvasWidth, canvasHeight);
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
      const detail = error instanceof Error ? error.message : "Could not change fullscreen mode";
      setConnection("error", detail);
    } finally {
      updateFullscreenButton();
    }
  }

  function updateWakeLockButton() {
    const active = Boolean(wakeLock && !wakeLock.released);
    wakeLockButton.setAttribute("aria-pressed", String(active));
    wakeLockButton.textContent = active ? "Screen awake" : "Keep screen awake";
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) {
      setConnection("error", "Wake Lock is not supported by this browser");
      return;
    }

    try {
      wakeLockRequested = true;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
        updateWakeLockButton();
      });
      updateWakeLockButton();
    } catch (error) {
      wakeLockRequested = false;
      const detail = error instanceof Error ? error.message : "Could not keep the screen awake";
      setConnection("error", detail);
      updateWakeLockButton();
    }
  }

  async function toggleWakeLock() {
    if (wakeLock && !wakeLock.released) {
      wakeLockRequested = false;
      await wakeLock.release();
      wakeLock = null;
      updateWakeLockButton();
      return;
    }

    await requestWakeLock();
  }

  overlayToggle.addEventListener("click", () => setOverlayVisible(overlay.hidden));
  overlayClose.addEventListener("click", () => setOverlayVisible(false));
  fullscreenButton.addEventListener("click", () => void toggleFullscreen());
  wakeLockButton.addEventListener("click", () => void toggleWakeLock());

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
    setConnection("offline", "Device is offline");
    startRestPolling();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wakeLockRequested && !wakeLock) {
      void requestWakeLock();
    }
  });
  window.addEventListener("pagehide", () => {
    clearReconnectTimer();
    closeSocket();
  });

  resizeCanvas();
  updateDetails();
  updateFullscreenButton();
  updateWakeLockButton();

  if (!lightId) {
    setConnection("error", "No light ID in this address");
    setOverlayVisible(true);
  } else {
    void fetchLight();
    connectSocket();
  }

  window.requestAnimationFrame(render);
})();
