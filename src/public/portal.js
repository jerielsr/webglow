(() => {
  "use strict";

  const API_ROOT = "/api/v1";
  const TOKEN_STORAGE_KEY = "webglow.portal.api-token";
  const PATTERNS = ["solid", "pulse", "strobe", "rainbow"];

  const statusElement = document.querySelector("#portal-status");
  const createForm = document.querySelector("#create-light-form");
  const idInput = document.querySelector("#new-light-id");
  const nameInput = document.querySelector("#new-light-name");
  const refreshButton = document.querySelector("#refresh-lights");
  const lightsGrid = document.querySelector("#lights-grid");
  const emptyLights = document.querySelector("#empty-lights");
  const tokenForm = document.querySelector("#token-form");
  const tokenInput = document.querySelector("#api-token");
  const clearTokenButton = document.querySelector("#clear-token");
  const authStatus = document.querySelector("#auth-status");
  const portalAddress = document.querySelector("#portal-address");
  const apiAddress = document.querySelector("#api-address");
  const serverAuth = document.querySelector("#server-auth");
  const serverEffects = document.querySelector("#server-effects");
  const apiExample = document.querySelector("#api-example");
  const toast = document.querySelector("#toast");

  const state = {
    lights: [],
    token: readStoredToken(),
    info: null,
  };
  let toastTimer = null;

  function readStoredToken() {
    try {
      return window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function storeToken(token) {
    try {
      if (token) {
        window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
      } else {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
    } catch {
      // The portal still works for this tab when browser storage is unavailable.
    }
  }

  function apiUrl(path) {
    return new URL(`${API_ROOT}${path}`, window.location.origin).toString();
  }

  function displayUrl(id) {
    return new URL(`/display/${encodeURIComponent(id)}`, window.location.origin).toString();
  }

  function setStatus(message, tone = "") {
    statusElement.textContent = message;
    statusElement.dataset.tone = tone;
  }

  function notify(message, tone = "") {
    if (toastTimer) {
      window.clearTimeout(toastTimer);
    }
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 5_000);
  }

  function apiHeaders(hasBody = false) {
    const headers = { Accept: "application/json" };
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }
    return headers;
  }

  async function api(path, options = {}) {
    const hasBody = options.body !== undefined;
    const response = await fetch(apiUrl(path), {
      method: options.method || "GET",
      headers: apiHeaders(hasBody),
      body: hasBody ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });

    if (response.status === 204) {
      return undefined;
    }

    const responseBody = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = responseBody?.error?.message || `Request failed (${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    return responseBody;
  }

  function isAuthRequired() {
    return Boolean(state.info?.controllerAuthenticationRequired);
  }

  function updateSettingsUi() {
    tokenInput.value = state.token;
    if (isAuthRequired()) {
      authStatus.textContent = state.token ? "Token saved in this browser." : "A controller token is required to make changes.";
      return;
    }
    authStatus.textContent = state.token ? "A token is saved, but this server currently does not require one." : "This server currently accepts controller requests without a token.";
  }

  function updateServerUi() {
    portalAddress.textContent = window.location.origin;
    apiAddress.textContent = `${window.location.origin}${API_ROOT}`;
    serverAuth.textContent = isAuthRequired() ? "Bearer token required" : "No token required";
    const patterns = state.info?.capabilities?.patterns;
    serverEffects.textContent = Array.isArray(patterns) ? patterns.join(", ") : "—";
    apiExample.textContent = [
      `curl --request PATCH ${apiUrl("/lights/kitchen-tablet")}`,
      state.token || isAuthRequired() ? "  --header 'Authorization: Bearer <token>'" : "",
      "  --header 'Content-Type: application/json'",
      "  --data '{\"on\":true,\"brightness\":75,\"color\":\"#00D9FF\"}'",
    ]
      .filter(Boolean)
      .join(" \\\n");
  }

  async function loadInfo() {
    try {
      state.info = await api("/info");
      updateSettingsUi();
      updateServerUi();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load server information.";
      setStatus(message, "error");
    }
  }

  async function loadLights() {
    refreshButton.disabled = true;
    try {
      const result = await api("/lights");
      state.lights = Array.isArray(result?.lights) ? result.lights : [];
      renderLights();
      setStatus(`${state.lights.length} ${state.lights.length === 1 ? "light" : "lights"} loaded`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load lights.";
      setStatus(message, "error");
      notify(message, "error");
    } finally {
      refreshButton.disabled = false;
    }
  }

  function setLight(resource) {
    const index = state.lights.findIndex((light) => light.id === resource.id);
    if (index === -1) {
      state.lights.push(resource);
    } else {
      state.lights[index] = resource;
    }
    state.lights.sort((left, right) => left.id.localeCompare(right.id));
  }

  async function updateLight(id, patch) {
    try {
      const light = await api(`/lights/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
      setLight(light);
      renderLights();
      setStatus(`Updated ${light.name}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update light.";
      notify(message, "error");
      await loadLights();
    }
  }

  async function deleteLight(light) {
    if (!window.confirm(`Delete “${light.name}” (${light.id})? Connected displays will turn black.`)) {
      return;
    }

    try {
      await api(`/lights/${encodeURIComponent(light.id)}`, { method: "DELETE" });
      state.lights = state.lights.filter((candidate) => candidate.id !== light.id);
      renderLights();
      setStatus(`Deleted ${light.name}`, "success");
      notify(`Deleted ${light.name}.`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete light.";
      notify(message, "error");
    }
  }

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function makeButton(text, className = "button button-secondary") {
    const button = element("button", className, text);
    button.type = "button";
    return button;
  }

  function makeRangeControl(labelText, value, onCommit) {
    const label = document.createElement("label");
    const labelTextNode = element("span", "", labelText);
    const control = element("div", "range-control");
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.step = "1";
    range.value = String(Math.round(value));
    const output = element("output", "control-output", `${Math.round(value)}%`);
    range.addEventListener("input", () => {
      output.textContent = `${range.value}%`;
    });
    range.addEventListener("change", () => onCommit(Number(range.value)));
    control.append(range, output);
    label.append(labelTextNode, control);
    return label;
  }

  function makeLightCard(light) {
    const card = element("article", "light-card");
    const opacity = light.state.on ? Math.max(0.15, Number(light.state.brightness) / 100) : 0.12;
    card.style.setProperty("--light-color", light.state.color);
    card.style.setProperty("--light-opacity", String(opacity));
    card.append(element("div", "light-preview"));

    const content = element("div", "light-content");
    const head = element("div", "light-head");
    const nameGroup = element("div", "light-name");
    const nameField = document.createElement("input");
    nameField.type = "text";
    nameField.value = light.name;
    nameField.maxLength = 80;
    nameField.setAttribute("aria-label", `Name for ${light.id}`);
    const idText = element("p", "light-id", light.id);
    nameGroup.append(nameField, idText);
    const saveName = makeButton("Save", "button button-secondary save-name");
    saveName.addEventListener("click", () => {
      const name = nameField.value.trim();
      if (!name) {
        notify("A light name cannot be empty.", "error");
        return;
      }
      void updateLight(light.id, { name });
    });
    head.append(nameGroup, saveName);

    const links = element("div", "display-links");
    const displayLink = element("a", "text-link", "Open display");
    displayLink.href = displayUrl(light.id);
    displayLink.target = "_blank";
    displayLink.rel = "noreferrer";
    const copyButton = makeButton("Copy display URL", "copy-link");
    copyButton.addEventListener("click", () => void copyDisplayUrl(light.id));
    links.append(displayLink, copyButton);

    const controls = element("div", "controls");
    const powerRow = element("div", "power-row");
    powerRow.append(element("span", "", "Power"));
    const toggleLabel = element("label", "toggle");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(light.state.on);
    const track = element("span", "toggle-track");
    const toggleText = element("span", "", light.state.on ? "On" : "Off");
    toggle.addEventListener("change", () => void updateLight(light.id, { on: toggle.checked }));
    toggleLabel.append(toggle, track, toggleText);
    powerRow.append(toggleLabel);
    controls.append(powerRow);

    const controlGrid = element("div", "control-grid");
    const colorLabel = document.createElement("label");
    colorLabel.append(element("span", "", "Colour"));
    const colorPicker = document.createElement("input");
    colorPicker.type = "color";
    colorPicker.value = light.state.color;
    colorPicker.setAttribute("aria-label", `Colour for ${light.name}`);
    colorPicker.addEventListener("change", () => void updateLight(light.id, { color: colorPicker.value }));
    colorLabel.append(colorPicker);
    controlGrid.append(colorLabel);
    controlGrid.append(makeRangeControl("Brightness", light.state.brightness, (brightness) => void updateLight(light.id, { brightness })));

    const patternLabel = document.createElement("label");
    patternLabel.append(element("span", "", "Effect"));
    const patternSelect = document.createElement("select");
    patternSelect.setAttribute("aria-label", `Effect for ${light.name}`);
    for (const pattern of PATTERNS) {
      const option = document.createElement("option");
      option.value = pattern;
      option.textContent = pattern[0].toUpperCase() + pattern.slice(1);
      option.selected = pattern === light.state.pattern;
      patternSelect.append(option);
    }
    patternSelect.addEventListener("change", () => void updateLight(light.id, { pattern: patternSelect.value }));
    patternLabel.append(patternSelect);
    controlGrid.append(patternLabel);
    controlGrid.append(makeRangeControl("Speed", light.state.speed, (speed) => void updateLight(light.id, { speed })));
    controls.append(controlGrid);

    const actions = element("div", "card-actions");
    const deleteButton = makeButton("Delete light", "button button-danger");
    deleteButton.addEventListener("click", () => void deleteLight(light));
    actions.append(deleteButton);

    content.append(head, links, controls, actions);
    card.append(content);
    return card;
  }

  function renderLights() {
    lightsGrid.replaceChildren();
    emptyLights.hidden = state.lights.length > 0;
    for (const light of state.lights) {
      lightsGrid.append(makeLightCard(light));
    }
  }

  async function copyDisplayUrl(id) {
    const url = displayUrl(id);
    try {
      await navigator.clipboard.writeText(url);
      notify("Display URL copied.", "success");
    } catch {
      notify(`Copy this display URL: ${url}`);
    }
  }

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = idInput.value.trim();
    const name = nameInput.value.trim();
    const body = {};
    if (id) {
      body.id = id;
    }
    if (name) {
      body.name = name;
    }

    const submitButton = createForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const result = await api("/lights", { method: "POST", body });
      setLight(result.light);
      renderLights();
      createForm.reset();
      setStatus(`Created ${result.light.name}`, "success");
      notify(`Created ${result.light.name}. Open its display URL on the chosen device.`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create light.";
      notify(message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  refreshButton.addEventListener("click", () => void loadLights());
  tokenForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.token = tokenInput.value.trim();
    storeToken(state.token);
    updateSettingsUi();
    notify(state.token ? "Portal token saved for this browser." : "Portal token cleared.", "success");
  });
  clearTokenButton.addEventListener("click", () => {
    state.token = "";
    storeToken("");
    updateSettingsUi();
    notify("Portal token cleared.", "success");
  });

  void (async () => {
    await loadInfo();
    await loadLights();
  })();
})();
