(() => {
  "use strict";

  const API = "/api/v1";
  const VIEWS = { "/": "console", "/setup": "setup", "/settings": "settings" };
  const state = {
    lights: [],
    scenes: [],
    settings: {},
    status: null,
    selected: new Set(),
    deferredInstall: null,
    metricsTimer: null,
    metrics: null,
    masterLayout: "standard",
    programmer: { on: true, brightness: 80, color: "#2EA8FF", pattern: "solid", speed: 50, fadeMs: 1000 },
  };
  const $ = (selector) => document.querySelector(selector);
  const toast = $("#toast");
  const statusElement = $("#portal-status");
  let toastTimer = null;

  function setStatus(message, tone = "") {
    statusElement.textContent = message;
    statusElement.dataset.tone = tone;
  }
  function notify(message, tone = "") {
    if (toastTimer) window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4200);
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
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className) {
    const node = element("button", className || "console-button subtle-button", text);
    node.type = "button";
    return node;
  }
  function handleError(error, inline) {
    const message = error instanceof Error ? error.message : "The request could not be completed.";
    if (inline) {
      inline.textContent = message;
      return;
    }
    setStatus(message, "error");
    notify(message, "error");
    if (error?.status === 401) showAuth();
  }
  function displayUrl(id) {
    const base = state.settings.publicBaseUrl || window.location.origin;
    return new URL("display/" + encodeURIComponent(id), base.replace(/\/$/, "") + "/").toString();
  }
  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.append(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }
  }
  function targetIds() {
    return state.selected.size ? [...state.selected] : "all";
  }
  function selectedLights() {
    return state.selected.size ? state.lights.filter((light) => state.selected.has(light.id)) : state.lights;
  }
  function effectiveProgrammer() {
    const grand = Number($("#grand-master").value) / 100;
    const rate = Number($("#rate-master").value) / 100;
    const fade = Number($("#fade-master").value) / 100;
    return {
      ...state.programmer,
      on: true,
      brightness: Math.round(state.programmer.brightness * grand),
      speed: Math.min(100, Math.round(state.programmer.speed * rate)),
      fadeMs: Math.round(state.programmer.fadeMs * fade),
    };
  }
  function syncProgrammerFromInputs() {
    state.programmer = {
      on: true,
      brightness: Number($("#program-brightness").value),
      color: $("#program-colour").value,
      pattern: $("#program-pattern").value,
      speed: Number($("#program-speed").value),
      fadeMs: Number($("#program-fade").value),
    };
  }
  function updateFaderOutput(input, output, suffix) {
    output.textContent = input.value + suffix;
  }
  function setMasterLayout(layout) {
    const supported = ["compact", "standard", "large"];
    state.masterLayout = supported.includes(layout) ? layout : "standard";
    $("#master-layout").value = state.masterLayout;
    $("#master-deck").dataset.layout = state.masterLayout;
    try { window.localStorage.setItem("webglow.master-layout", state.masterLayout); } catch {}
  }
  function syncMasters() {
    updateFaderOutput($("#grand-master"), $("#grand-master-output"), "%");
    updateFaderOutput($("#rate-master"), $("#rate-master-output"), "%");
    updateFaderOutput($("#fade-master"), $("#fade-master-output"), "%");
    updateCommandLine();
  }
  function setMasterValues(values) {
    Object.entries(values).forEach(([id, value]) => { $("#" + id).value = String(value); });
    syncMasters();
  }
  function restoreMasterPreferences() {
    try { setMasterLayout(window.localStorage.getItem("webglow.master-layout") || "standard"); } catch { setMasterLayout("standard"); }
    syncMasters();
  }
  function updateCommandLine() {
    const target = selectedLights();
    const fixtureText = state.selected.size
      ? target.map((light) => String(state.lights.indexOf(light) + 1)).join(" + ")
      : "All";
    $("#command-line").textContent =
      "Fixture " + fixtureText + "  @ " + state.programmer.brightness + "  " +
      state.programmer.color + "  " + state.programmer.pattern + "  Fade " + (effectiveProgrammer().fadeMs / 1000) + "s";
    $("#programmer-target").textContent = state.selected.size ? state.selected.size + " selected" : "All fixtures";
  }
  function renderFixtureGrid() {
    const grid = $("#fixture-grid");
    grid.replaceChildren();
    $("#fixture-empty").hidden = state.lights.length > 0;
    $("#fixture-count").textContent = state.lights.length + " fixture" + (state.lights.length === 1 ? "" : "s");
    state.lights.forEach((light, index) => {
      const fixture = button("", "fixture-button" + (state.selected.has(light.id) ? " selected" : ""));
      fixture.style.setProperty("--fixture-colour", light.state.color);
      fixture.dataset.fixtureKind = light.kind || "display";
      fixture.setAttribute("aria-pressed", String(state.selected.has(light.id)));
      const number = element("strong", "", String(index + 1));
      const label = element("span", "", light.name);
      const id = element("small", "", light.kind === "wled" ? "WLED · " + light.wled?.url : light.id);
      fixture.append(number, label, id);
      fixture.addEventListener("click", () => {
        if (state.selected.has(light.id)) state.selected.delete(light.id);
        else state.selected.add(light.id);
        renderFixtureGrid();
        updateCommandLine();
      });
      grid.append(fixture);
    });
    updateCommandLine();
  }
  function renderSetupLights() {
    const list = $("#setup-lights");
    list.replaceChildren();
    $("#setup-empty").hidden = state.lights.length > 0;
    state.lights.forEach((light, index) => {
      const row = element("article", "setup-row console-setup-row");
      const number = element("span", "setup-fixture-number", String(index + 1));
      const name = element("label");
      name.append(element("span", "", "Fixture name"));
      const nameInput = document.createElement("input");
      nameInput.value = light.name;
      nameInput.maxLength = 80;
      name.append(nameInput);
      const id = element("label");
      const isWled = light.kind === "wled";
      id.append(element("span", "", isWled ? "WLED connection" : "Fixture ID"));
      const idInput = document.createElement("input");
      idInput.value = isWled ? light.wled?.url + " · Segment " + light.wled?.segment : light.id;
      idInput.readOnly = true;
      id.append(idInput);
      const actions = element("div", "row-actions");
      const save = button("Save", "console-button subtle-button");
      const destroy = button("Delete", "console-button danger-button");
      save.addEventListener("click", async () => {
        try {
          const updated = await api("/lights/" + encodeURIComponent(light.id), { method: "PATCH", body: { name: nameInput.value } });
          state.lights[state.lights.findIndex((candidate) => candidate.id === light.id)] = updated;
          renderFixtureGrid();
          renderSetupLights();
          notify("Fixture name saved.", "success");
        } catch (error) { handleError(error); }
      });
      destroy.addEventListener("click", async () => {
        if (!window.confirm("Delete “" + light.name + "”? This only removes it from WebGlow.")) return;
        try {
          await api("/lights/" + encodeURIComponent(light.id), { method: "DELETE" });
          state.lights = state.lights.filter((candidate) => candidate.id !== light.id);
          state.selected.delete(light.id);
          renderFixtureGrid();
          renderSetupLights();
          notify("Fixture deleted.", "success");
        } catch (error) { handleError(error); }
      });
      actions.append(save);
      if (isWled) {
        const refresh = button("Refresh WLED", "console-button go-button");
        refresh.addEventListener("click", async () => {
          try {
            const result = await api("/lights/" + encodeURIComponent(light.id) + "/wled/refresh", { method: "POST" });
            state.lights[state.lights.findIndex((candidate) => candidate.id === light.id)] = result.light;
            renderFixtureGrid();
            renderSetupLights();
            notify("WLED state refreshed.", "success");
          } catch (error) { handleError(error); }
        });
        actions.append(refresh);
      } else {
        const copy = button("Copy URL", "console-button go-button");
        const show = button("Show URL", "console-button subtle-button");
        const url = element("div", "display-url");
        const code = element("code", "", displayUrl(light.id));
        code.hidden = true;
        copy.addEventListener("click", async () => { await copyText(displayUrl(light.id)); notify("Display URL copied.", "success"); });
        show.addEventListener("click", () => { code.hidden = !code.hidden; show.textContent = code.hidden ? "Show URL" : "Hide URL"; });
        actions.append(copy, show);
        row.append(number, name, id, actions, url);
        url.append(code);
      }
      actions.append(destroy);
      if (isWled) row.append(number, name, id, actions);
      list.append(row);
    });
  }
  function renderCueList() {
    const list = $("#cue-list");
    list.replaceChildren();
    $("#cue-empty").hidden = state.scenes.length > 0;
    state.scenes.forEach((scene) => {
      const row = element("article", "cue-row");
      row.append(
        element("strong", "cue-number", scene.id),
        element("span", "cue-name", scene.name),
        element("span", "cue-targets", scene.ids === "all" ? "All" : scene.ids.length + " selected"),
        element("span", "cue-fade", (Number(scene.state.fadeMs || 0) / 1000) + " s"),
      );
      const actions = element("div", "cue-actions");
      const go = button("Go", "console-button go-button");
      const deleteCue = button("Delete", "console-button subtle-button");
      go.addEventListener("click", () => runCue(scene));
      deleteCue.addEventListener("click", () => deleteCueById(scene.id));
      actions.append(go, deleteCue);
      row.append(actions);
      list.append(row);
    });
  }
  function renderServerDetails(metrics) {
    const details = $("#server-details");
    details.replaceChildren();
    const add = (key, value) => {
      const row = element("div");
      row.append(element("dt", "", key), element("dd", "", value));
      details.append(row);
    };
    add("Portal address", window.location.origin);
    add("Display address", state.settings.publicBaseUrl || "Current portal address");
    add("Portal access", "Username and password");
    add("Automation token", state.settings.controllerBearerTokenConfigured ? "Configured" : "Not configured");
    add("Recovery token", state.settings.passwordResetConfigured ? "Configured" : "Not configured");
    if (state.settings.server) {
      add("Container port", String(state.settings.server.port));
      add("CORS policy", state.settings.server.corsOrigin);
      add("Persistent storage", state.settings.server.persistence);
    }
    if (metrics) {
      add("Runtime", metrics.host.platform + " · " + metrics.host.architecture);
      add("Container process", formatBytes(metrics.process.rssBytes) + " memory · " + metrics.process.cpuPercent.toFixed(1) + "% CPU");
      add("Display sockets", String(metrics.traffic.activeDisplaySockets));
    }
  }
  function renderConsoleMetrics(metrics) {
    const root = $("#metrics-list");
    root.replaceChildren();
    if (!metrics) return;
    const add = (label, value) => {
      const row = element("div");
      row.append(element("span", "", label), element("b", "", value));
      root.append(row);
    };
    add("CPU", metrics.process.cpuPercent.toFixed(1) + "%");
    add("Memory", formatBytes(metrics.process.rssBytes));
    add("Sockets", String(metrics.traffic.activeDisplaySockets));
  }
  function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let value = Number(bytes) || 0;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return (value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
  }
  async function loadLights() {
    const result = await api("/lights");
    state.lights = (result.lights || []).sort((left, right) => left.id.localeCompare(right.id));
    const existing = new Set(state.lights.map((light) => light.id));
    state.selected = new Set([...state.selected].filter((id) => existing.has(id)));
    renderFixtureGrid();
    renderSetupLights();
  }
  async function loadScenes() {
    const result = await api("/scenes");
    state.scenes = result.scenes || [];
    renderCueList();
  }
  async function loadSettings() {
    state.settings = await api("/settings");
    $("#public-base-url").value = state.settings.publicBaseUrl || "";
    renderServerDetails(state.metrics);
  }
  async function loadMetrics() {
    try {
      const metrics = await api("/metrics");
      state.metrics = metrics;
      renderConsoleMetrics(metrics);
      renderServerDetails(metrics);
    } catch (error) {
      handleError(error);
    }
  }
  async function applyProgrammer() {
    syncProgrammerFromInputs();
    try {
      const result = await api("/lights/batch", { method: "POST", body: { ids: targetIds(), state: effectiveProgrammer() } });
      state.lights = result.lights || state.lights;
      renderFixtureGrid();
      renderSetupLights();
      setStatus("Live programmer applied to " + result.count + " fixture" + (result.count === 1 ? "" : "s"), "success");
      notify("Live output applied.", "success");
    } catch (error) { handleError(error); }
  }
  async function makeChase() {
    syncProgrammerFromInputs();
    try {
      const program = effectiveProgrammer();
      const result = await api("/lights/chase", { method: "POST", body: { ids: targetIds(), color: program.color, speed: program.speed, fadeMs: program.fadeMs, on: true } });
      state.lights = result.lights || state.lights;
      renderFixtureGrid();
      renderSetupLights();
      notify("Chase created.", "success");
    } catch (error) { handleError(error); }
  }
  async function flashFixtures() {
    const before = selectedLights().map((light) => ({ id: light.id, state: { ...light.state } }));
    if (!before.length) return;
    try {
      await api("/lights/batch", { method: "POST", body: { ids: targetIds(), state: { on: true, brightness: 100, fadeMs: 0 } } });
      window.setTimeout(() => {
        void Promise.all(before.map((light) => api("/lights/" + encodeURIComponent(light.id), {
          method: "PATCH",
          body: { on: light.state.on, brightness: light.state.brightness, fadeMs: 0 },
        }))).then(loadLights).catch(handleError);
      }, 350);
    } catch (error) { handleError(error); }
  }
  async function blackout() {
    try {
      await api("/lights/batch", { method: "POST", body: { ids: "all", state: { on: false, fadeMs: 0 } } });
      await loadLights();
      notify("Blackout active.", "success");
    } catch (error) { handleError(error); }
  }
  async function restoreOutput() {
    try {
      await api("/lights/batch", { method: "POST", body: { ids: "all", state: { on: true, fadeMs: effectiveProgrammer().fadeMs } } });
      await loadLights();
      notify("Output restored.", "success");
    } catch (error) { handleError(error); }
  }
  async function recordCue() {
    syncProgrammerFromInputs();
    try {
      const id = $("#cue-number").value.trim();
      const name = $("#cue-name").value.trim();
      const result = await api("/scenes", {
        method: "POST",
        body: { id, ...(name ? { name } : {}), ids: targetIds(), state: effectiveProgrammer() },
      });
      state.scenes.push(result.scene);
      state.scenes.sort((left, right) => Number(left.id) - Number(right.id));
      renderCueList();
      const next = Number(id) + 1;
      if (Number.isFinite(next)) $("#cue-number").value = String(next);
      $("#cue-name").value = "";
      notify("Cue " + id + " recorded.", "success");
    } catch (error) { handleError(error); }
  }
  async function runCue(scene) {
    try {
      const result = await api("/scenes/" + encodeURIComponent(scene.id) + "/go", { method: "POST" });
      state.lights = result.lights || state.lights;
      renderFixtureGrid();
      renderSetupLights();
      setStatus("Cue " + scene.id + " live", "success");
      notify("Cue " + scene.id + " is live.", "success");
    } catch (error) { handleError(error); }
  }
  async function deleteCueById(id) {
    if (!window.confirm("Delete Cue " + id + "?")) return;
    try {
      await api("/scenes/" + encodeURIComponent(id), { method: "DELETE" });
      state.scenes = state.scenes.filter((scene) => scene.id !== id);
      renderCueList();
      notify("Cue " + id + " deleted.", "success");
    } catch (error) { handleError(error); }
  }
  function switchView(path, replace) {
    const normalized = VIEWS[path] ? path : "/";
    const view = VIEWS[normalized];
    document.querySelectorAll(".app-view").forEach((section) => { section.hidden = section.id !== "view-" + view; });
    document.querySelectorAll("[data-view-link]").forEach((link) => {
      link.classList.toggle("active", link.dataset.viewLink === view);
    });
    document.title = "WebGlow " + (view === "console" ? "Console" : view[0].toUpperCase() + view.slice(1));
    if (!replace && window.location.pathname !== normalized) window.history.pushState({}, "", normalized);
  }
  function showAuth() {
    $("#auth-dialog").hidden = false;
    $("#auth-title").textContent = state.status?.setupRequired ? "Create your portal owner" : "Sign in to WebGlow";
    $("#auth-copy").textContent = state.status?.setupRequired
      ? "This first account protects the Control, Setup, and Settings areas. Use at least 12 characters for the password."
      : "Use your portal username and password to continue.";
    $("#auth-submit").textContent = state.status?.setupRequired ? "Create account" : "Sign in";
    $("#show-reset").hidden = state.status?.setupRequired || !state.status?.passwordResetConfigured;
    $("#auth-username").focus();
  }
  async function submitAuth(event) {
    event.preventDefault();
    const error = $("#auth-error");
    error.textContent = "";
    try {
      await api(state.status.setupRequired ? "/auth/setup" : "/auth/login", {
        method: "POST",
        body: { username: $("#auth-username").value, password: $("#auth-password").value },
      });
      $("#auth-dialog").hidden = true;
      $("#auth-password").value = "";
      await bootstrap();
      notify("Portal access granted.", "success");
    } catch (failure) { error.textContent = failure instanceof Error ? failure.message : "Unable to sign in."; }
  }
  async function submitReset(event) {
    event.preventDefault();
    const error = $("#reset-error");
    error.textContent = "";
    try {
      await api("/auth/reset-password", {
        method: "POST",
        body: { username: $("#reset-username").value, resetToken: $("#reset-token").value, newPassword: $("#reset-password").value },
      });
      $("#reset-dialog").hidden = true;
      $("#auth-dialog").hidden = false;
      $("#auth-error").textContent = "Password reset. Sign in with your new password.";
    } catch (failure) { error.textContent = failure instanceof Error ? failure.message : "Unable to reset the password."; }
  }
  async function bootstrap() {
    try {
      state.status = await api("/auth/status");
      if (!state.status.authenticated) { showAuth(); return; }
      $("#auth-dialog").hidden = true;
      await Promise.all([loadLights(), loadScenes(), loadSettings(), loadMetrics()]);
      switchView(window.location.pathname, true);
      if (state.metricsTimer) window.clearInterval(state.metricsTimer);
      state.metricsTimer = window.setInterval(loadMetrics, 15000);
    } catch (error) { handleError(error); }
  }
  function registerPwa() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.deferredInstall = event;
      $("#install-app").hidden = false;
    });
    $("#install-app").addEventListener("click", async () => {
      if (!state.deferredInstall) return;
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      $("#install-app").hidden = true;
    });
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-route]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    switchView(new URL(link.href).pathname);
  });
  window.addEventListener("popstate", () => switchView(window.location.pathname, true));
  $("#program-brightness").addEventListener("input", (event) => {
    updateFaderOutput(event.currentTarget, $("#program-brightness-output"), "%");
    syncProgrammerFromInputs(); updateCommandLine();
  });
  $("#program-speed").addEventListener("input", (event) => {
    updateFaderOutput(event.currentTarget, $("#program-speed-output"), "%");
    syncProgrammerFromInputs(); updateCommandLine();
  });
  ["#grand-master", "#rate-master", "#fade-master"].forEach((selector) => {
    $(selector).addEventListener("input", syncMasters);
  });
  $("#master-layout").addEventListener("change", (event) => setMasterLayout(event.currentTarget.value));
  $("#reset-masters").addEventListener("click", () => {
    setMasterValues({ "grand-master": 100, "rate-master": 100, "fade-master": 100 });
    notify("Masters reset to full output.", "success");
  });
  document.querySelectorAll("[data-master-preset]").forEach((preset) => preset.addEventListener("click", () => {
    const values = {
      full: { "grand-master": 100, "rate-master": 100, "fade-master": 100 },
      half: { "grand-master": 50, "rate-master": 100, "fade-master": 100 },
      snap: { "grand-master": 100, "rate-master": 100, "fade-master": 0 },
    };
    setMasterValues(values[preset.dataset.masterPreset] || values.full);
    notify(preset.textContent + " master preset selected.", "success");
  }));
  ["#program-colour", "#program-pattern", "#program-fade"].forEach((selector) => {
    $(selector).addEventListener("change", () => { syncProgrammerFromInputs(); updateCommandLine(); });
  });
  document.querySelectorAll("[data-attribute]").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll("[data-attribute]").forEach((candidate) => candidate.classList.toggle("active", candidate === tab));
    document.body.dataset.attribute = tab.dataset.attribute;
  }));
  $("#apply-live").addEventListener("click", applyProgrammer);
  $("#make-chase").addEventListener("click", makeChase);
  $("#flash-fixtures").addEventListener("click", flashFixtures);
  $("#blackout").addEventListener("click", blackout);
  $("#master-blackout").addEventListener("click", blackout);
  $("#restore-output").addEventListener("click", restoreOutput);
  $("#clear-programmer").addEventListener("click", () => {
    state.selected.clear();
    state.programmer = { on: true, brightness: 80, color: "#2EA8FF", pattern: "solid", speed: 50, fadeMs: 1000 };
    $("#program-brightness").value = "80"; $("#program-speed").value = "50"; $("#program-colour").value = "#2EA8FF"; $("#program-pattern").value = "solid"; $("#program-fade").value = "1000";
    $("#program-brightness-output").textContent = "80%"; $("#program-speed-output").textContent = "50%";
    renderFixtureGrid();
    notify("Programmer cleared.", "success");
  });
  $("#all-fixtures").addEventListener("click", () => {
    state.selected = new Set(state.lights.map((light) => light.id));
    renderFixtureGrid();
    notify("All fixtures selected.", "success");
  });
  $("#record-cue").addEventListener("click", recordCue);
  $("#refresh-lights").addEventListener("click", () => { void loadLights().catch(handleError); });
  function syncFixtureTypeForm() {
    const isWled = $("#new-light-kind").value === "wled";
    $("#new-wled-url-field").hidden = !isWled;
    $("#new-wled-segment-field").hidden = !isWled;
    $("#new-wled-url").required = isWled;
    $("#create-fixture-button").textContent = isWled ? "Connect WLED fixture" : "Create web display";
  }
  $("#new-light-kind").addEventListener("change", syncFixtureTypeForm);
  $("#create-light-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("#new-light-id").value.trim();
    const name = $("#new-light-name").value.trim();
    const kind = $("#new-light-kind").value;
    try {
      const result = await api("/lights", {
        method: "POST",
        body: {
          ...(id ? { id } : {}),
          ...(name ? { name } : {}),
          kind,
          ...(kind === "wled"
            ? { wled: { url: $("#new-wled-url").value.trim(), segment: Number($("#new-wled-segment").value) } }
            : {}),
        },
      });
      state.lights.push(result.light);
      $("#new-light-id").value = ""; $("#new-light-name").value = "";
      if (kind === "wled") $("#new-wled-url").value = "";
      renderFixtureGrid(); renderSetupLights();
      notify(kind === "wled" ? "WLED fixture connected." : "Fixture created. Copy its display URL.", "success");
    } catch (error) { handleError(error); }
  });
  $("#public-url-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/settings", { method: "PATCH", body: { publicBaseUrl: $("#public-base-url").value.trim() } });
      state.settings = { ...state.settings, ...result };
      $("#public-base-url").value = result.publicBaseUrl || "";
      renderSetupLights();
      notify("Display address saved.", "success");
    } catch (error) { handleError(error); }
  });
  $("#use-current-url").addEventListener("click", () => { $("#public-base-url").value = window.location.origin; });
  $("#refresh-metrics").addEventListener("click", loadMetrics);
  $("#password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/auth/change-password", { method: "POST", body: { currentPassword: $("#current-password").value, newPassword: $("#new-password").value } });
      $("#password-form").reset();
      state.status = await api("/auth/status");
      showAuth();
      notify("Password changed. Sign in again.", "success");
    } catch (error) { handleError(error); }
  });
  $("#logout").addEventListener("click", async () => {
    try {
      await api("/auth/logout", { method: "POST" });
      state.status = await api("/auth/status");
      showAuth();
      notify("Signed out.", "success");
    } catch (error) { handleError(error); }
  });
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#show-reset").addEventListener("click", () => {
    $("#auth-dialog").hidden = true;
    $("#reset-dialog").hidden = false;
    $("#reset-username").value = $("#auth-username").value;
    $("#reset-username").focus();
  });
  $("#cancel-reset").addEventListener("click", () => { $("#reset-dialog").hidden = true; $("#auth-dialog").hidden = false; });
  $("#reset-form").addEventListener("submit", submitReset);

  restoreMasterPreferences();
  syncFixtureTypeForm();
  registerPwa();
  bootstrap();
})();
