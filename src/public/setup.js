(() => {
  "use strict";

  const API = "/api/v1";
  const state = { lights: [], settings: {}, status: null };
  const $ = (selector) => document.querySelector(selector);
  const toast = $("#toast");
  const statusElement = $("#portal-status");
  let toastTimer = null;

  function setStatus(message, tone = "") {
    statusElement.textContent = message;
    statusElement.dataset.tone = tone;
  }
  function notify(message, tone = "") {
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = message; toast.dataset.tone = tone; toast.hidden = false;
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
  function handleError(error, element) {
    const message = error instanceof Error ? error.message : "The request could not be completed.";
    if (element) { element.textContent = message; return; }
    setStatus(message, "error"); notify(message, "error");
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
      helper.value = value; helper.setAttribute("readonly", ""); helper.style.position = "fixed"; helper.style.opacity = "0";
      document.body.append(helper); helper.select(); document.execCommand("copy"); helper.remove();
    }
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className) {
    const result = element("button", className || "button button-secondary", text);
    result.type = "button"; return result;
  }
  async function loadSettings() {
    const result = await api("/settings");
    state.settings = result;
    $("#public-base-url").value = result.publicBaseUrl || "";
    renderServerDetails();
  }
  function renderServerDetails() {
    const details = $("#server-details"); details.replaceChildren();
    const add = (key, value) => {
      const row = element("div"); row.append(element("dt", "", key), element("dd", "", value)); details.append(row);
    };
    add("Portal", window.location.origin);
    add("Display address", state.settings.publicBaseUrl || "Current portal address");
    add("Portal login", "Username and password");
    add("Automation token", state.settings.controllerBearerTokenConfigured ? "Configured" : "Not configured");
    add("Password recovery", state.settings.passwordResetConfigured ? "Recovery token enabled" : "Not configured");
  }
  async function loadLights() {
    $("#refresh-lights").disabled = true;
    try {
      const result = await api("/lights");
      state.lights = (result.lights || []).sort((left, right) => left.id.localeCompare(right.id));
      renderLights();
      setStatus(String(state.lights.length) + " light" + (state.lights.length === 1 ? "" : "s") + " ready", "success");
    } catch (error) {
      handleError(error);
    } finally {
      $("#refresh-lights").disabled = false;
    }
  }
  function renderLights() {
    const list = $("#setup-lights"); list.replaceChildren();
    $("#empty-lights").hidden = state.lights.length > 0;
    state.lights.forEach((light) => {
      const row = element("article", "setup-row");
      const nameLabel = element("label"); nameLabel.append(element("span", "", "Name"));
      const nameInput = document.createElement("input"); nameInput.value = light.name; nameInput.maxLength = 80;
      nameLabel.append(nameInput);
      const identity = element("label"); identity.append(element("span", "", "Display ID"));
      const idInput = document.createElement("input"); idInput.value = light.id; idInput.readOnly = true;
      identity.append(idInput);
      const actions = element("div", "row-actions");
      const save = button("Save name");
      save.addEventListener("click", async () => {
        try {
          const updated = await api("/lights/" + encodeURIComponent(light.id), { method: "PATCH", body: { name: nameInput.value } });
          const index = state.lights.findIndex((candidate) => candidate.id === light.id);
          state.lights[index] = updated; renderLights(); notify("Name saved.", "success");
        } catch (error) { handleError(error); }
      });
      const copy = button("Copy URL", "button button-primary");
      copy.addEventListener("click", async () => {
        await copyText(displayUrl(light.id)); notify("Display URL copied.", "success");
      });
      const show = button("Show URL");
      const destroy = button("Delete", "button button-secondary");
      destroy.addEventListener("click", async () => {
        if (!window.confirm("Delete “" + light.name + "”? Connected displays will turn black.")) return;
        try {
          await api("/lights/" + encodeURIComponent(light.id), { method: "DELETE" });
          state.lights = state.lights.filter((candidate) => candidate.id !== light.id);
          renderLights(); notify("Light deleted.", "success");
        } catch (error) { handleError(error); }
      });
      actions.append(save, copy, show, destroy);
      const url = element("div", "display-url");
      const code = element("code", "", displayUrl(light.id)); code.hidden = true;
      show.addEventListener("click", () => {
        code.hidden = !code.hidden; show.textContent = code.hidden ? "Show URL" : "Hide URL";
      });
      url.append(code);
      row.append(nameLabel, identity, actions, url); list.append(row);
    });
  }
  function showAuth() {
    const dialog = $("#auth-dialog"); dialog.hidden = false;
    $("#auth-title").textContent = state.status?.setupRequired ? "Create your portal owner" : "Sign in to WebGlow";
    $("#auth-copy").textContent = state.status?.setupRequired ? "This first account protects your Control and Setup pages. Use at least 12 characters for the password." : "Use your portal username and password to continue.";
    $("#auth-submit").textContent = state.status?.setupRequired ? "Create account" : "Sign in";
    $("#show-reset").hidden = state.status?.setupRequired || !state.status?.passwordResetConfigured;
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
      await bootstrap(); notify("Portal access granted.", "success");
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : "Unable to sign in.";
    }
  }
  async function submitReset(event) {
    event.preventDefault();
    const error = $("#reset-error"); error.textContent = "";
    try {
      await api("/auth/reset-password", {
        method: "POST",
        body: {
          username: $("#reset-username").value,
          resetToken: $("#reset-token").value,
          newPassword: $("#reset-password").value,
        },
      });
      $("#reset-dialog").hidden = true; $("#auth-dialog").hidden = false;
      $("#auth-password").value = ""; $("#auth-error").textContent = "Password reset. Sign in with your new password.";
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : "Unable to reset the password.";
    }
  }
  async function bootstrap() {
    try {
      state.status = await api("/auth/status");
      if (!state.status.authenticated) { showAuth(); return; }
      $("#auth-dialog").hidden = true;
      await Promise.all([loadSettings(), loadLights()]);
    } catch (error) { handleError(error); }
  }

  $("#auth-form").addEventListener("submit", submitAuth);
  $("#show-reset").addEventListener("click", () => { $("#auth-dialog").hidden = true; $("#reset-dialog").hidden = false; $("#reset-username").value = $("#auth-username").value; $("#reset-username").focus(); });
  $("#cancel-reset").addEventListener("click", () => { $("#reset-dialog").hidden = true; $("#auth-dialog").hidden = false; });
  $("#reset-form").addEventListener("submit", submitReset);
  $("#refresh-lights").addEventListener("click", loadLights);
  $("#use-current-url").addEventListener("click", () => { $("#public-base-url").value = window.location.origin; });
  $("#public-url-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/settings", { method: "PATCH", body: { publicBaseUrl: $("#public-base-url").value.trim() } });
      state.settings = { ...state.settings, ...result };
      $("#public-base-url").value = result.publicBaseUrl || "";
      renderLights(); renderServerDetails(); notify("Display address saved.", "success");
    } catch (error) { handleError(error); }
  });
  $("#create-light-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("#new-light-id").value.trim();
    const name = $("#new-light-name").value.trim();
    try {
      const result = await api("/lights", { method: "POST", body: { ...(id ? { id } : {}), ...(name ? { name } : {}) } });
      state.lights.push(result.light); $("#new-light-id").value = ""; $("#new-light-name").value = "";
      renderLights(); notify("Light created. Copy its display URL below.", "success");
    } catch (error) { handleError(error); }
  });
  $("#password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: { currentPassword: $("#current-password").value, newPassword: $("#new-password").value },
      });
      $("#password-form").reset(); notify("Password changed. Sign in again.", "success");
      state.status = await api("/auth/status"); showAuth();
    } catch (error) { handleError(error); }
  });
  $("#logout").addEventListener("click", async () => {
    try {
      await api("/auth/logout", { method: "POST" }); state.status = await api("/auth/status"); showAuth(); notify("Signed out.", "success");
    } catch (error) { handleError(error); }
  });
  bootstrap();
})();
