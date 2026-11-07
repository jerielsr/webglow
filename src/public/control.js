(() => {
  "use strict";

  const API = "/api/v1";
  const PATTERNS = ["solid", "breathe", "pulse", "strobe", "rainbow", "chase", "twinkle"];
  const state = { lights: [], selected: new Set(), status: null, metricsTimer: null };
  const $ = (selector) => document.querySelector(selector);
  const status = $("#portal-status");
  const toast = $("#toast");
  let toastTimer = null;

  function setStatus(message, tone = "") {
    status.textContent = message;
    status.dataset.tone = tone;
  }
  function notify(message, tone = "") {
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
  }
  async function api(path, options = {}) {
    const response = await fetch(API + path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: options.body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
    });
    if (response.status === 204) return undefined;
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = new Error(body?.error?.message || "Request failed (" + response.status + ").");
      error.status = response.status;
      throw error;
    }
    return body;
  }
  function title(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
  function targetIds() {
    if ($("#target-all").checked) return "all";
    const ids = [...state.selected];
    if (!ids.length) throw new Error("Choose at least one light, or switch to All lights.");
    return ids;
  }
  function syncRange(input, output) { output.textContent = input.value + "%"; }
  function updateSelectionUi() {
    $("#selected-count").textContent = String(state.selected.size);
    if (!state.selected.size && $("#target-selected").checked) $("#target-all").checked = true;
  }
  function setLights(lights) {
    state.lights = lights.sort((a, b) => a.id.localeCompare(b.id));
    const known = new Set(state.lights.map((light) => light.id));
    state.selected = new Set([...state.selected].filter((id) => known.has(id)));
    renderLights();
  }
  async function loadLights() {
    $("#refresh-lights").disabled = true;
    try {
      const result = await api("/lights");
      setLights(Array.isArray(result.lights) ? result.lights : []);
      setStatus(String(state.lights.length) + " light" + (state.lights.length === 1 ? "" : "s") + " ready", "success");
    } catch (error) {
      handleApiError(error);
    } finally {
      $("#refresh-lights").disabled = false;
    }
  }
  function handleApiError(error) {
    const message = error instanceof Error ? error.message : "The request could not be completed.";
    setStatus(message, "error");
    notify(message, "error");
    if (error?.status === 401) showAuth();
  }
  async function patchLight(id, patch) {
    try {
      const light = await api("/lights/" + encodeURIComponent(id), { method: "PATCH", body: patch });
      const index = state.lights.findIndex((candidate) => candidate.id === id);
      if (index >= 0) state.lights[index] = light;
      renderLights();
      setStatus("Updated " + light.name, "success");
    } catch (error) {
      handleApiError(error);
      await loadLights();
    }
  }
  async function applyBatch(scene) {
    try {
      const result = await api("/lights/batch", { method: "POST", body: { ids: targetIds(), state: scene } });
      setLights(result.lights || []);
      setStatus("Applied look to " + result.count + " light" + (result.count === 1 ? "" : "s"), "success");
      notify("Look applied.", "success");
    } catch (error) {
      handleApiError(error);
    }
  }
  function sceneValues() {
    return {
      color: $("#group-color").value,
      pattern: $("#group-pattern").value,
      brightness: Number($("#group-brightness").value),
      speed: Number($("#group-speed").value),
      fadeMs: Number($("#group-fade").value),
    };
  }
  async function startChase() {
    try {
      const scene = sceneValues();
      const result = await api("/lights/chase", {
        method: "POST",
        body: { ids: targetIds(), color: scene.color, speed: scene.speed, fadeMs: scene.fadeMs, on: true },
      });
      setLights(result.lights || []);
      setStatus("Chase running on " + result.count + " light" + (result.count === 1 ? "" : "s"), "success");
      notify("Chase created.", "success");
    } catch (error) {
      handleApiError(error);
    }
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function rangeField(label, value, suffix, onChange) {
    const field = element("label");
    field.append(element("span", "", label));
    const row = element("span", "range-row");
    const input = document.createElement("input");
    input.type = "range"; input.min = "0"; input.max = "100"; input.value = String(Math.round(value));
    const out = element("output", "", String(Math.round(value)) + suffix);
    input.addEventListener("input", () => { out.textContent = input.value + suffix; });
    input.addEventListener("change", () => onChange(Number(input.value)));
    row.append(input, out); field.append(row);
    return field;
  }
  function selectField(label, value, options, onChange) {
    const field = element("label");
    field.append(element("span", "", label));
    const select = document.createElement("select");
    options.forEach(([id, name]) => {
      const option = document.createElement("option");
      option.value = id; option.textContent = name; option.selected = id === String(value);
      select.append(option);
    });
    select.addEventListener("change", () => onChange(select.value));
    field.append(select);
    return field;
  }
  function renderLights() {
    const grid = $("#lights-grid");
    grid.replaceChildren();
    $("#empty-lights").hidden = state.lights.length > 0;
    state.lights.forEach((light) => {
      const card = element("article", "light-card" + (state.selected.has(light.id) ? " selected" : ""));
      card.style.setProperty("--light-color", light.state.color);
      card.style.setProperty("--light-opacity", light.state.on ? String(Math.max(.15, light.state.brightness / 100)) : ".12");
      const head = element("div", "card-head");
      const titleGroup = element("div", "card-title");
      titleGroup.append(element("h3", "", light.name), element("p", "", light.id));
      const selected = document.createElement("label");
      selected.className = "select-light";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox"; checkbox.checked = state.selected.has(light.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(light.id); else state.selected.delete(light.id);
        updateSelectionUi(); renderLights();
      });
      selected.append(checkbox, document.createTextNode("Select"));
      head.append(titleGroup, selected); card.append(head);

      const power = element("div", "power-row");
      power.append(element("span", "", "Power"));
      const toggleLabel = element("label", "toggle");
      const toggle = document.createElement("input");
      toggle.type = "checkbox"; toggle.checked = Boolean(light.state.on);
      const track = element("span", "toggle-track");
      const toggleText = element("span", "", light.state.on ? "On" : "Off");
      toggle.addEventListener("change", () => patchLight(light.id, { on: toggle.checked }));
      toggleLabel.append(toggle, track, toggleText); power.append(toggleLabel); card.append(power);

      const controls = element("div", "card-controls");
      const colour = element("label"); colour.append(element("span", "", "Colour"));
      const picker = document.createElement("input"); picker.type = "color"; picker.value = light.state.color;
      picker.addEventListener("change", () => patchLight(light.id, { color: picker.value }));
      colour.append(picker); controls.append(colour);
      controls.append(selectField("Effect", light.state.pattern, PATTERNS.map((pattern) => [pattern, title(pattern)]), (pattern) => patchLight(light.id, { pattern })));
      controls.append(rangeField("Brightness", light.state.brightness, "%", (brightness) => patchLight(light.id, { brightness })));
      controls.append(rangeField("Speed", light.state.speed, "%", (speed) => patchLight(light.id, { speed })));
      controls.append(selectField("Fade", light.state.fadeMs ?? 0, [["0", "Instant"], ["250", "250 ms"], ["500", "500 ms"], ["1000", "1 second"], ["2000", "2 seconds"], ["5000", "5 seconds"], ["10000", "10 seconds"]], (fadeMs) => patchLight(light.id, { fadeMs: Number(fadeMs) })));
      card.append(controls); grid.append(card);
    });
    updateSelectionUi();
  }
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let amount = bytes; let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    return (amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)) + " " + units[unit];
  }
  function metricRow(label, value) {
    const row = element("div"); row.append(element("dt", "", label), element("dd", "", value)); return row;
  }
  async function loadMetrics() {
    try {
      const metrics = await api("/metrics");
      const list = $("#metrics-list"); list.replaceChildren(
        metricRow("Process CPU", metrics.process.cpuPercent.toFixed(1) + "%"),
        metricRow("Process memory", formatBytes(metrics.process.rssBytes)),
        metricRow("Requests", String(metrics.traffic.requests)),
        metricRow("Traffic", formatBytes(metrics.traffic.sentBytes) + " sent · " + formatBytes(metrics.traffic.receivedBytes) + " received"),
        metricRow("Display sockets", String(metrics.traffic.activeDisplaySockets)),
        metricRow("Host", metrics.host.cpus + " CPU · " + formatBytes(metrics.host.freeMemoryBytes) + " free"),
      );
    } catch (error) {
      handleApiError(error);
    }
  }
  function showAuth() {
    const dialog = $("#auth-dialog"); dialog.hidden = false;
    $("#auth-title").textContent = state.status?.setupRequired ? "Create your portal owner" : "Sign in to control WebGlow";
    $("#auth-copy").textContent = state.status?.setupRequired ? "This first account protects the Control and Setup areas. Use at least 12 characters for the password." : "Use your portal account to manage displays.";
    $("#auth-submit").textContent = state.status?.setupRequired ? "Create account" : "Sign in";
    $("#auth-username").focus();
  }
  async function submitAuth(event) {
    event.preventDefault();
    const error = $("#auth-error"); error.textContent = "";
    try {
      await api(state.status.setupRequired ? "/auth/setup" : "/auth/login", {
        method: "POST",
        body: { username: $("#auth-username").value, password: $("#auth-password").value },
      });
      $("#auth-dialog").hidden = true; $("#auth-password").value = "";
      await bootstrap();
      notify("Portal access granted.", "success");
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : "Unable to sign in.";
    }
  }
  async function bootstrap() {
    try {
      state.status = await api("/auth/status");
      if (!state.status.authenticated) { showAuth(); return; }
      $("#auth-dialog").hidden = true;
      await Promise.all([loadLights(), loadMetrics()]);
      if (state.metricsTimer) clearInterval(state.metricsTimer);
      state.metricsTimer = setInterval(loadMetrics, 15000);
    } catch (error) { handleApiError(error); }
  }

  $("#group-brightness").addEventListener("input", (event) => syncRange(event.currentTarget, $("#group-brightness-output")));
  $("#group-speed").addEventListener("input", (event) => syncRange(event.currentTarget, $("#group-speed-output")));
  $("#apply-scene").addEventListener("click", () => applyBatch(sceneValues()));
  $("#start-chase").addEventListener("click", startChase);
  $("#all-on").addEventListener("click", () => applyBatch({ on: true, fadeMs: Number($("#group-fade").value) }));
  $("#all-off").addEventListener("click", () => applyBatch({ on: false, fadeMs: Number($("#group-fade").value) }));
  $("#refresh-lights").addEventListener("click", loadLights);
  $("#refresh-metrics").addEventListener("click", loadMetrics);
  $("#select-none").addEventListener("click", () => { state.selected.clear(); updateSelectionUi(); renderLights(); });
  $("#auth-form").addEventListener("submit", submitAuth);
  bootstrap();
})();
