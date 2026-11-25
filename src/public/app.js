(() => {
  "use strict";

  const API = "/api/v1";
  const VIEWS = { "/": "console", "/playback": "playback", "/timelines": "playback", "/setup": "setup", "/monitor": "monitor", "/settings": "settings" };
  const state = {
    lights: [],
    dmxProfiles: [],
    dmxStatus: null,
    dmxPatchSignature: "",
    editingDmxProfile: null,
    dmxPatchFixtureId: "",
    scenes: [],
    stacks: [],
    activeCueStackId: "main",
    draggingCueId: null,
    draggingCueStackId: null,
    settings: {},
    status: null,
    selected: new Set(),
    deferredInstall: null,
    metricsTimer: null,
    cloudflaredTimer: null,
    rosterTimer: null,
    metrics: null,
    guests: null,
    history: null,
    mediaAssets: [],
    selectedMediaId: null,
    timecodeConsole: null,
    masterLayout: "standard",
    masterWheelControl: false,
    blackoutActive: false,
    blackoutRestoreIds: [],
    liveApplyTimer: null,
    liveApplyInFlight: false,
    liveApplyQueued: false,
    activeCueId: null,
    clearTimer: null,
    clearArmed: false,
    programmerAttributes: new Set(["intensity", "colour", "effect"]),
    draggingFixtureId: null,
    tapTimes: [],
    currentBpm: null,
    programmer: { on: true, brightness: 80, color: "#2EA8FF", colors: ["#2EA8FF", "#FF3D81", "#FFD447"], colorTransition: "snap", colorTransitions: ["snap", "snap", "snap"], colorStepMs: 750, pattern: "solid", speed: 50, fadeMs: 1000, layers: [], mediaOpacity: 100, mediaTouched: false },
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
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = new Error(body?.error?.message || "Request failed (" + response.status + ").");
      error.status = response.status;
      throw error;
    }
    if ((options.method || "GET").toUpperCase() !== "GET" && state.history) {
      window.setTimeout(() => { void loadHistory(!$("#command-history-panel").hidden).catch(() => undefined); }, 0);
    }
    if (response.status === 204) return undefined;
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
  function guestJoinUrl() {
    const base = state.settings.publicBaseUrl || window.location.origin;
    return new URL("join", base.replace(/\/$/, "") + "/").toString();
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
    const { mediaTouched: _mediaTouched, ...programmer } = state.programmer;
    return {
      ...programmer,
      on: true,
      brightness: Math.round(state.programmer.brightness * grand),
      speed: Math.min(100, Math.round(state.programmer.speed * rate)),
      fadeMs: Math.round(state.programmer.fadeMs * fade),
    };
  }
  function syncProgrammerFromInputs() {
    const basePattern = $("#program-pattern").value;
    const colors = [...document.querySelectorAll("#program-color-palette input[type=\"color\"]")].map((input) => input.value.toUpperCase());
    const multiChaseEnabled = basePattern === "chase" && state.programmer.pattern === "multi-chase";
    state.programmer = {
      ...state.programmer,
      on: true,
      brightness: Number($("#program-brightness").value),
      color: $("#program-colour").value,
      colors: colors.length >= 2 ? colors : ["#2EA8FF", "#FF3D81"],
      colorTransitions: [...document.querySelectorAll("#program-color-palette [data-color-transition]")].map((select) => select.value),
      colorStepMs: Math.round(Math.max(0.1, Math.min(60, Number($("#program-color-step").value) || 0.75)) * 1000),
      pattern: multiChaseEnabled ? "multi-chase" : basePattern,
      speed: Number($("#program-speed").value),
      fadeMs: Number($("#program-fade").value),
      layers: readVisualLayers(),
      ...(state.programmer.mediaTouched ? { mediaUrl: state.programmer.mediaUrl || null, mediaKind: state.programmer.mediaKind || null, mediaOpacity: Number($("#program-media-opacity").value) } : {}),
    };
  }
  const QUICK_EFFECT_PRESETS = {
    chase: { pattern: "chase", speed: 55, fadeMs: 450 },
    "color-chase": {
      pattern: "multi-chase", speed: 42, fadeMs: 450,
      colors: ["#38BDF8", "#A78BFA", "#FB7185", "#FBBF24"],
      colorTransitions: ["fade", "ramp-up", "snap", "ramp-down"], colorStepMs: 700,
    },
    rainbow: { pattern: "rainbow", speed: 34, fadeMs: 500 },
    breathe: { pattern: "breathe", speed: 24, fadeMs: 900 },
    sparkle: { pattern: "twinkle", speed: 64, fadeMs: 250 },
    strobe: { pattern: "strobe", speed: 72, fadeMs: 0 },
    "ramp-up": { pattern: "ramp-up", speed: 30, fadeMs: 650 },
    "ramp-down": { pattern: "ramp-down", speed: 30, fadeMs: 650 },
  };
  function applyQuickEffectPreset(name) {
    const preset = QUICK_EFFECT_PRESETS[name];
    if (!preset) return;
    const multiChase = preset.pattern === "multi-chase";
    $("#program-pattern").value = multiChase ? "chase" : preset.pattern;
    $("#program-speed").value = String(preset.speed);
    $("#program-speed-output").textContent = preset.speed + "%";
    $("#program-fade").value = String(preset.fadeMs);
    if (preset.colors) {
      state.programmer.colors = [...preset.colors];
      state.programmer.colorTransitions = [...preset.colorTransitions];
      state.programmer.colorStepMs = preset.colorStepMs;
      $("#program-colour").value = preset.colors[0];
      $("#program-color-step").value = String(preset.colorStepMs / 1000);
      renderPalettePickers(preset.colors, preset.colorTransitions);
    }
    state.programmer.pattern = preset.pattern;
    updateMultiChaseControls();
    syncProgrammerFromInputs();
    document.querySelectorAll("[data-effect-preset]").forEach((button) => {
      button.classList.toggle("active", button.dataset.effectPreset === name);
      button.setAttribute("aria-pressed", String(button.dataset.effectPreset === name));
    });
    updateCommandLine();
    scheduleProgrammerApply();
  }
  function updateMultiChaseControls() {
    const enabled = $("#program-pattern").value === "chase" && state.programmer.pattern === "multi-chase";
    const trigger = $("#multi-chase-toggle");
    trigger.setAttribute("aria-pressed", String(enabled));
    trigger.classList.toggle("active", enabled);
    trigger.innerHTML = enabled ? '<span aria-hidden="true">✓</span><span>Multi-colour on</span>' : '<span aria-hidden="true">＋</span><span>Add colours</span>';
    trigger.title = enabled ? "Turn off the multi-colour chase" : "Add colours and automatically select a multi-colour chase";
    $("#multi-chase-options").hidden = !enabled;
  }
  function renderPalettePickers(colors, transitions) {
    const root = $("#program-color-palette");
    root.replaceChildren();
    const palette = Array.isArray(colors) && colors.length >= 2 ? colors.slice(0, 8) : ["#2EA8FF", "#FF3D81", "#FFD447"];
    const transitionValues = Array.isArray(transitions) ? transitions : [];
    palette.forEach((color, index) => {
      const row = element("div", "color-picker-row");
      const input = document.createElement("input");
      input.type = "color";
      input.value = /^#[0-9A-F]{6}$/i.test(color) ? color : "#2EA8FF";
      input.setAttribute("aria-label", `Chase colour ${index + 1}`);
      const name = element("span", "color-picker-name", `Colour ${index + 1}`);
      const value = element("code", "color-picker-value", input.value.toUpperCase());
      const transition = document.createElement("select");
      transition.dataset.colorTransition = "";
      transition.setAttribute("aria-label", `Transition from colour ${index + 1} to the next colour`);
      [["snap", "Snap"], ["fade", "Fade"], ["ramp-up", "Ramp up"], ["ramp-down", "Ramp down"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        transition.append(option);
      });
      const savedTransition = transitionValues[index];
      transition.value = ["snap", "fade", "ramp-up", "ramp-down"].includes(savedTransition) ? savedTransition : "snap";
      transition.addEventListener("change", () => { syncProgrammerFromInputs(); scheduleProgrammerApply(); });
      input.addEventListener("input", () => {
        value.textContent = input.value.toUpperCase();
        if (index === 0) $("#program-colour").value = input.value;
        syncProgrammerFromInputs();
        scheduleProgrammerApply();
      });
      const remove = button("×", "console-button subtle-button color-remove");
      remove.title = `Remove colour ${index + 1}`;
      remove.setAttribute("aria-label", `Remove chase colour ${index + 1}`);
      remove.disabled = palette.length <= 2;
      remove.addEventListener("click", () => {
        if (palette.length <= 2) return;
        const next = [...document.querySelectorAll("#program-color-palette input[type=\"color\"]")].map((item) => item.value);
        next.splice(index, 1);
        const nextTransitions = [...document.querySelectorAll("#program-color-palette [data-color-transition]")].map((item) => item.value);
        nextTransitions.splice(index, 1);
        renderPalettePickers(next, nextTransitions);
        syncProgrammerFromInputs();
        scheduleProgrammerApply();
      });
      row.append(input, name, value, transition, remove);
      root.append(row);
    });
    $("#program-add-color").disabled = palette.length >= 8;
  }
  function addPaletteColor() {
    const palette = [...document.querySelectorAll("#program-color-palette input[type=\"color\"]")].map((input) => input.value);
    if (palette.length >= 8) return;
    const transitions = [...document.querySelectorAll("#program-color-palette [data-color-transition]")].map((select) => select.value);
    const suggestions = ["#37C9FF", "#FF8A3D", "#B56CFF", "#5AE0A1", "#FFE05A"];
    palette.push(suggestions[(palette.length - 3 + suggestions.length) % suggestions.length]);
    transitions.push("snap");
    renderPalettePickers(palette, transitions);
    syncProgrammerFromInputs();
    scheduleProgrammerApply();
  }
  function readVisualLayers() {
    return [...document.querySelectorAll(".visual-layer-card")].map((card) => ({
      id: card.dataset.layerId,
      pattern: card.querySelector("[data-layer-field=pattern]").value,
      color: card.querySelector("[data-layer-field=color]").value.toUpperCase(),
      opacity: Number(card.querySelector("[data-layer-field=opacity]").value),
      density: Number(card.querySelector("[data-layer-field=density]").value),
      size: Number(card.querySelector("[data-layer-field=size]").value),
      speed: Number(card.querySelector("[data-layer-field=speed]").value),
    }));
  }
  function renderVisualLayers(layers = []) {
    const root = $("#program-visual-layers");
    root.replaceChildren();
    const safeLayers = Array.isArray(layers) ? layers.slice(0, 8) : [];
    $("#visual-layer-count").textContent = safeLayers.length + " layer" + (safeLayers.length === 1 ? "" : "s");
    $("#visual-layer-empty").hidden = safeLayers.length > 0;
    $("#program-add-layer").disabled = safeLayers.length >= 8;
    safeLayers.forEach((layer, index) => {
      const card = element("article", "visual-layer-card");
      card.dataset.layerId = layer.id || "layer-" + (index + 1);
      const heading = element("div", "visual-layer-card-heading");
      heading.append(element("strong", "", "Layer " + (index + 1)));
      const remove = button("Remove", "console-button subtle-button");
      remove.setAttribute("aria-label", "Remove visual layer " + (index + 1));
      heading.append(remove);
      const patternLabel = element("label", "console-field");
      patternLabel.append(element("span", "", "Pattern"));
      const pattern = document.createElement("select");
      pattern.dataset.layerField = "pattern";
      [["snowflakes", "Falling snowflakes"], ["squares", "Square grid"], ["orbit", "Rotating circles"]].forEach(([value, label]) => pattern.add(new Option(label, value)));
      pattern.value = ["snowflakes", "squares", "orbit"].includes(layer.pattern) ? layer.pattern : "snowflakes";
      patternLabel.append(pattern);
      const colorLabel = element("label", "console-field layer-color-field");
      colorLabel.append(element("span", "", "Colour"));
      const color = document.createElement("input");
      color.type = "color";
      color.dataset.layerField = "color";
      color.value = /^#[0-9A-F]{6}$/i.test(layer.color) ? layer.color : "#EAF8FF";
      colorLabel.append(color);
      const fields = [
        ["opacity", "Opacity", 0, 100, 1, 68, "%"],
        ["density", "Density", 1, 120, 1, 30, ""],
        ["size", "Size", 8, 100, 1, 48, "%"],
        ["speed", "Speed", 0, 100, 1, 35, "%"],
      ];
      const controls = element("div", "visual-layer-controls");
      fields.forEach(([key, label, min, max, step, fallback, suffix]) => {
        const field = element("label", "console-field layer-range-field");
        const title = element("span", "", label);
        const value = Number.isFinite(Number(layer[key])) ? Number(layer[key]) : fallback;
        const output = element("output", "", String(value) + suffix);
        title.append(document.createTextNode(" "), output);
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(value);
        input.dataset.layerField = key;
        input.addEventListener("input", () => {
          output.textContent = input.value + suffix;
          syncProgrammerFromInputs();
          scheduleProgrammerApply();
        });
        field.append(title, input);
        controls.append(field);
      });
      const handleLayerEdit = () => { syncProgrammerFromInputs(); scheduleProgrammerApply(); };
      pattern.addEventListener("change", handleLayerEdit);
      color.addEventListener("input", handleLayerEdit);
      remove.addEventListener("click", () => {
        state.programmer.layers = readVisualLayers().filter((item) => item.id !== card.dataset.layerId);
        renderVisualLayers(state.programmer.layers);
        syncProgrammerFromInputs();
        scheduleProgrammerApply();
      });
      card.append(heading, patternLabel, colorLabel, controls);
      root.append(card);
    });
  }
  function addVisualLayer() {
    const layers = readVisualLayers();
    if (layers.length >= 8) return;
    layers.push({ id: "layer-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6), pattern: "snowflakes", color: "#EAF8FF", opacity: 68, density: 30, size: 48, speed: 35 });
    renderVisualLayers(layers);
    syncProgrammerFromInputs();
    scheduleProgrammerApply();
  }
  function updateFaderOutput(input, output, suffix) {
    output.textContent = input.value + suffix;
  }
  function bindTouchReorder(handle, itemSelector, getId, onDrop) {
    handle.addEventListener("pointerdown", (startEvent) => {
      if (startEvent.pointerType !== "touch" && startEvent.pointerType !== "pen") return;
      const source = handle.closest(itemSelector);
      if (!source) return;
      const startX = startEvent.clientX;
      const startY = startEvent.clientY;
      let dragging = false;
      const cleanup = () => {
        source.classList.remove("touch-reorder-active");
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onEnd);
        document.removeEventListener("pointercancel", onCancel);
      };
      const onMove = (event) => {
        if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < 9) return;
        dragging = true;
        event.preventDefault();
        source.classList.add("touch-reorder-active");
      };
      const onEnd = (event) => {
        cleanup();
        if (!dragging) return;
        event.preventDefault();
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(itemSelector);
        if (target && target !== source) onDrop(getId(source), getId(target));
      };
      const onCancel = () => cleanup();
      document.addEventListener("pointermove", onMove, { passive: false });
      document.addEventListener("pointerup", onEnd, { once: true });
      document.addEventListener("pointercancel", onCancel, { once: true });
    });
  }
  function setMasterLayout(layout) {
    const supported = ["compact", "standard", "large"];
    state.masterLayout = supported.includes(layout) ? layout : "standard";
    $("#master-layout").value = state.masterLayout;
    $("#master-deck").dataset.layout = state.masterLayout;
    try { window.localStorage.setItem("webglow.master-layout", state.masterLayout); } catch {}
  }
  function setMasterWheelControl(enabled) {
    state.masterWheelControl = Boolean(enabled);
    $("#master-wheel-control").checked = state.masterWheelControl;
    try { window.localStorage.setItem("webglow.master-wheel-control", String(state.masterWheelControl)); } catch {}
  }
  function syncMasters() {
    updateFaderOutput($("#grand-master"), $("#grand-master-output"), "%");
    updateFaderOutput($("#rate-master"), $("#rate-master-output"), "%");
    updateFaderOutput($("#fade-master"), $("#fade-master-output"), "%");
    $("#header-grand-master").value = $("#grand-master").value;
    updateFaderOutput($("#header-grand-master"), $("#header-grand-master-output"), "%");
    updateCommandLine();
  }
  function setMasterValues(values) {
    Object.entries(values).forEach(([id, value]) => { $("#" + id).value = String(value); });
    syncMasters();
  }
  function restoreMasterPreferences() {
    try { setMasterLayout(window.localStorage.getItem("webglow.master-layout") || "standard"); } catch { setMasterLayout("standard"); }
    try { setMasterWheelControl(window.localStorage.getItem("webglow.master-wheel-control") === "true"); } catch { setMasterWheelControl(false); }
    try {
      const division = window.localStorage.getItem("webglow.tap-division");
      if (["1", "2", "4", "8"].includes(division)) $("#tap-division").value = division;
    } catch {}
    syncMasters();
  }
  function tapTempo() {
    const now = performance.now();
    state.tapTimes = [...state.tapTimes.filter((time) => now - time < 2500), now].slice(-4);
    if (state.tapTimes.length < 2) {
      notify("Tap again to set tempo.", "success");
      return;
    }
    const intervals = state.tapTimes.slice(1).map((time, index) => time - state.tapTimes[index]);
    const average = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
    const bpm = 60_000 / average;
    state.currentBpm = Math.round(bpm);
    $("#tap-tempo").textContent = "Tap · " + state.currentBpm + " BPM";
    const division = Number($("#tap-division").value) || 1;
    const targetFrequency = bpm / 60 / division;
    const speed = Math.round(Math.max(0, Math.min(100, ((targetFrequency - 0.05) / 2.95) * 100)));
    $("#program-speed").value = String(speed);
    updateFaderOutput($("#program-speed"), $("#program-speed-output"), "%");
    syncProgrammerFromInputs();
    // Tap tempo is an absolute target. Leave the playback rate neutral so a
    // pre-existing Rate master value cannot silently skew the tapped timing.
    setMasterValues({ "rate-master": 100 });
    scheduleProgrammerApply();
    const actualFrequency = 0.05 + (2.95 * speed / 100);
    const isClamped = Math.abs(actualFrequency - targetFrequency) > 0.03;
    notify("Tap tempo " + Math.round(bpm) + " BPM · 1:" + division + " · " + actualFrequency.toFixed(2) + " Hz" + (isClamped ? " (effect speed limit)" : ""), "success");
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
    const mode = state.settings.fixtureSortMode || "id";
    const sectionOrder = new Map((state.settings.seatSections || ["Left", "Center", "Right"]).map((section, index) => [section.toLocaleLowerCase(), index]));
    const customOrder = new Map((state.settings.fixtureOrder || []).map((id, index) => [id, index]));
    const lights = [...state.lights].sort((left, right) => {
      if (mode === "seat") {
        const leftRank = sectionOrder.get((left.guest?.section || "").toLocaleLowerCase()) ?? Number.MAX_SAFE_INTEGER;
        const rightRank = sectionOrder.get((right.guest?.section || "").toLocaleLowerCase()) ?? Number.MAX_SAFE_INTEGER;
        if (leftRank !== rightRank) return leftRank - rightRank;
      } else if (mode === "custom") {
        const leftRank = customOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
        const rightRank = customOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
        if (leftRank !== rightRank) return leftRank - rightRank;
      }
      return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" });
    });
    $("#fixture-sort-hint").textContent = mode === "seat"
      ? "Fixtures follow the configured audience sections; unassigned fixtures are listed last."
      : mode === "custom" ? "Drag a fixture tile to change its position. Custom order is saved to server settings." : "Fixtures are sorted by fixture ID.";
    lights.forEach((light, index) => {
      const item = element("div", "fixture-item");
      item.dataset.fixtureId = light.id;
      item.draggable = mode === "custom";
      const fixture = button("", "fixture-button" + (state.selected.has(light.id) ? " selected" : ""));
      fixture.style.setProperty("--fixture-colour", light.state.color);
      fixture.dataset.fixtureKind = light.kind || "display";
      fixture.setAttribute("aria-pressed", String(state.selected.has(light.id)));
      const number = element("strong", "fixture-number", String(light.fixtureNumber || index + 1));
      const label = element("span", "", light.name);
      const outputLabel = light.kind === "wled" ? "WLED · " + light.wled?.url : light.kind === "dmx" ? "DMX · " + (light.dmx?.profileId || "profile") + " @ " + light.dmx?.startAddress : light.id;
      const id = element("small", "", outputLabel + " · " + (light.state.on ? light.state.pattern + " · " + Math.round(light.state.brightness) + "%" : "Off"));
      const preview = element("span", "fixture-live-preview pattern-" + light.state.pattern + (light.state.on ? "" : " is-off"));
      const palette = Array.isArray(light.state.colors) ? light.state.colors : [];
      preview.style.setProperty("--fixture-colour", palette[0] || light.state.color || "#000000");
      if (palette[1]) preview.style.setProperty("--fixture-colour-two", palette[1]);
      if (palette[2]) preview.style.setProperty("--fixture-colour-three", palette[2]);
      preview.style.setProperty("--fixture-level", String(light.state.brightness / 100));
      preview.title = light.state.on ? light.state.pattern + " · " + Math.round(light.state.brightness) + "%" : "Output off";
      fixture.append(number, label, id, preview);
      fixture.addEventListener("click", () => {
        if (state.justDraggedFixture) { state.justDraggedFixture = false; return; }
        if (state.selected.has(light.id)) state.selected.delete(light.id);
        else state.selected.add(light.id);
        renderFixtureGrid();
        updateCommandLine();
      });
      item.addEventListener("dragstart", (event) => {
        if (event.target.closest(".fixture-order-control")) { event.preventDefault(); return; }
        state.draggingFixtureId = light.id;
        state.justDraggedFixture = true;
        event.dataTransfer?.setData("text/plain", light.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      item.addEventListener("dragover", (event) => { if (mode === "custom") event.preventDefault(); });
      item.addEventListener("drop", (event) => {
        if (mode !== "custom") return;
        event.preventDefault();
        const sourceId = state.draggingFixtureId || event.dataTransfer?.getData("text/plain");
        if (!sourceId || sourceId === light.id) return;
        const reordered = [...lights];
        const from = reordered.findIndex((candidate) => candidate.id === sourceId);
        const to = reordered.findIndex((candidate) => candidate.id === light.id);
        if (from < 0 || to < 0) return;
        const [moved] = reordered.splice(from, 1);
        reordered.splice(to, 0, moved);
        void saveFixtureOrder(reordered.map((candidate) => candidate.id));
      });
      item.addEventListener("dragend", () => { state.draggingFixtureId = null; window.setTimeout(() => { state.justDraggedFixture = false; }, 250); });
      item.append(fixture);
      if (mode === "custom") {
        const controls = element("div", "fixture-order-controls");
        const moveUp = button("↑", "fixture-order-control");
        const moveDown = button("↓", "fixture-order-control");
        moveUp.title = "Move fixture earlier";
        moveDown.title = "Move fixture later";
        moveUp.disabled = index === 0;
        moveDown.disabled = index === lights.length - 1;
        const move = (direction) => {
          const reordered = [...lights];
          const targetIndex = index + direction;
          if (targetIndex < 0 || targetIndex >= reordered.length) return;
          [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
          void saveFixtureOrder(reordered.map((candidate) => candidate.id));
        };
        moveUp.addEventListener("click", (event) => { event.stopPropagation(); move(-1); });
        moveDown.addEventListener("click", (event) => { event.stopPropagation(); move(1); });
        controls.append(moveUp, moveDown);
        item.append(controls);
      }
      grid.append(item);
    });
    updateCommandLine();
  }
  async function saveFixtureOrder(order) {
    try {
      const result = await api("/settings", { method: "PATCH", body: { fixtureOrder: order } });
      state.settings = { ...state.settings, ...result };
      renderFixtureGrid();
    } catch (error) { handleError(error); }
  }
  const DMX_CHANNEL_FUNCTIONS = [["operation", "Operation mode"], ["red", "Red"], ["green", "Green"], ["blue", "Blue"], ["dimmer", "Dimmer"], ["speed", "Speed"], ["fixed", "Fixed value"]];
  function addDmxChannelRow(channel = {}, channelNumber = $("#dmx-profile-channels").children.length + 1) {
    const row = element("div", "dmx-channel-row");
    const name = document.createElement("input");
    name.maxLength = 40;
    name.required = true;
    name.value = channel.name || "Channel " + channelNumber;
    name.setAttribute("aria-label", "DMX channel " + channelNumber + " name");
    const fn = document.createElement("select");
    fn.setAttribute("aria-label", "DMX channel " + channelNumber + " function");
    DMX_CHANNEL_FUNCTIONS.forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; fn.append(option); });
    fn.value = channel.function || "fixed";
    const fixed = document.createElement("input");
    fixed.type = "number"; fixed.min = "0"; fixed.max = "255"; fixed.step = "1"; fixed.value = String(channel.fixedValue ?? 0);
    fixed.className = "dmx-channel-fixed"; fixed.title = "Fixed DMX value (0–255)";
    const modes = document.createElement("input");
    modes.type = "text"; modes.className = "dmx-channel-modes"; modes.placeholder = "solid=0, chase=160";
    modes.value = Object.entries(channel.operationValues || {}).map(([pattern, output]) => pattern + "=" + output).join(", ");
    modes.title = "Pattern-to-DMX operation values";
    const remove = button("×", "console-button danger-button dmx-channel-remove");
    remove.setAttribute("aria-label", "Remove channel " + channelNumber);
    remove.addEventListener("click", () => { if ($("#dmx-profile-channels").children.length > 1) row.remove(); });
    const sync = () => { fixed.hidden = fn.value !== "fixed"; modes.hidden = fn.value !== "operation"; };
    fn.addEventListener("change", sync); sync();
    row.append(name, fn, fixed, modes, remove);
    $("#dmx-profile-channels").append(row);
  }
  function resetDmxProfileForm() {
    state.editingDmxProfile = null;
    $("#dmx-profile-name").value = "";
    $("#dmx-profile-form-title").textContent = "Create custom profile";
    $("#save-dmx-profile").textContent = "Save profile";
    $("#cancel-dmx-profile-edit").hidden = true;
    $("#dmx-profile-channels").replaceChildren();
    [["Red", "red"], ["Green", "green"], ["Blue", "blue"]].forEach(([name, fn], index) => addDmxChannelRow({ name, function: fn }, index + 1));
  }
  function profileFromEditor() {
    const channels = [...$("#dmx-profile-channels").querySelectorAll(".dmx-channel-row")].map((row) => {
      const [name, fn, fixed, modes] = row.querySelectorAll("input, select");
      const channel = { name: name.value.trim(), function: fn.value };
      if (fn.value === "fixed") channel.fixedValue = Number(fixed.value);
      if (fn.value === "operation") {
        const values = {};
        for (const entry of modes.value.split(",").map((item) => item.trim()).filter(Boolean)) {
          const [pattern, output, ...extra] = entry.split("=").map((part) => part.trim());
          if (!pattern || output === undefined || extra.length || !/^\d+$/.test(output)) throw new Error("Operation mappings use pattern=value, for example solid=0, chase=160.");
          if (Object.hasOwn(values, pattern)) throw new Error("An operation pattern can only be mapped once per channel.");
          values[pattern] = Number(output);
        }
        if (Object.keys(values).length) channel.operationValues = values;
      }
      return channel;
    });
    return { name: $("#dmx-profile-name").value.trim(), channels };
  }
  function renderDmxSetup() {
    const status = state.dmxStatus;
    $("#dmx-connection-summary").textContent = status ? (status.connected ? "Adapter detected · ready for output" : "No uDMX adapter detected") : "Adapter status unavailable";
    $("#dmx-connection-summary").dataset.tone = status?.connected ? "success" : "error";
    renderDetailList("#dmx-connection-details", [
      ["Adapter", status?.device || "Unknown"],
      ["USB ID", (status?.vendorId || "0x16c0") + ":" + (status?.productId || "0x05dc")],
      ["Patched fixtures", String(status?.patchedFixtures ?? state.lights.filter((light) => light.kind === "dmx").length)],
      ["Universe", "512 channels"],
      ...(status?.lastError ? [["Last output issue", status.lastError]] : []),
    ]);
    const select = $("#new-dmx-profile");
    const selected = select.value;
    select.replaceChildren();
    state.dmxProfiles.forEach((profile) => { const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name + " · " + profile.channels.length + " ch"; select.append(option); });
    if (state.dmxProfiles.some((profile) => profile.id === selected)) select.value = selected;
    const patchSelect = $("#dmx-patch-fixture");
    if (patchSelect) {
      const previous = state.dmxPatchFixtureId || patchSelect.value;
      patchSelect.replaceChildren(new Option("Choose a DMX fixture", ""));
      state.lights.filter((light) => light.kind === "dmx").forEach((light) => patchSelect.append(new Option((light.fixtureNumber ? "#" + light.fixtureNumber + " · " : "") + light.name, light.id)));
      state.dmxPatchFixtureId = state.lights.some((light) => light.id === previous && light.kind === "dmx") ? previous : "";
      patchSelect.value = state.dmxPatchFixtureId;
      $("#dmx-patch-selection").textContent = state.dmxPatchFixtureId ? "Selected: " + (state.lights.find((light) => light.id === state.dmxPatchFixtureId)?.name || state.dmxPatchFixtureId) + " · tap a channel to set its start address." : "Select a fixture, then choose its start channel.";
      renderDmxPatchGrid();
    }
    const list = $("#dmx-profile-list");
    list.replaceChildren();
    state.dmxProfiles.forEach((profile) => {
      const card = element("article", "dmx-profile-card");
      const header = element("div", "dmx-profile-card-head");
      const title = element("div");
      title.append(element("strong", "", profile.name), element("span", "", profile.channels.length + " channels" + (profile.builtIn ? " · built in" : " · custom")));
      header.append(title);
      const detail = element("p", "console-copy", profile.channels.map((channel, index) => (index + 1) + ". " + channel.name + " — " + channel.function).join(" · "));
      card.append(header, detail);
      if (profile.builtIn) {
        const customize = button("Use as template", "console-button subtle-button");
        customize.addEventListener("click", () => {
          state.editingDmxProfile = null;
          $("#dmx-profile-name").value = profile.name + " (custom)";
          $("#dmx-profile-form-title").textContent = "Create custom profile from preset";
          $("#save-dmx-profile").textContent = "Save as custom profile";
          $("#cancel-dmx-profile-edit").hidden = true;
          $("#dmx-profile-channels").replaceChildren();
          profile.channels.forEach((channel, index) => addDmxChannelRow(channel, index + 1));
          $("#dmx-profile-name").focus();
        });
        card.append(customize);
      }
      if (!profile.builtIn) {
        const actions = element("div", "row-actions");
        const edit = button("Edit", "console-button subtle-button");
        edit.addEventListener("click", () => {
          state.editingDmxProfile = profile.id;
          $("#dmx-profile-name").value = profile.name;
          $("#dmx-profile-form-title").textContent = "Edit custom profile";
          $("#save-dmx-profile").textContent = "Save changes";
          $("#cancel-dmx-profile-edit").hidden = false;
          $("#dmx-profile-channels").replaceChildren();
          profile.channels.forEach((channel, index) => addDmxChannelRow(channel, index + 1));
          $("#dmx-profile-name").focus();
        });
        const remove = button("Delete", "console-button danger-button");
        remove.addEventListener("click", async () => {
          if (!window.confirm("Delete DMX profile “" + profile.name + "”? It cannot be deleted while fixtures use it.")) return;
          try { await api("/dmx/profiles/" + encodeURIComponent(profile.id), { method: "DELETE" }); await loadDmxSetup(); notify("DMX profile deleted.", "success"); }
          catch (error) { handleError(error); }
        });
        actions.append(edit, remove); card.append(actions);
      }
      list.append(card);
    });
    if (!state.dmxProfiles.length) list.append(element("p", "console-empty", "No DMX profiles are available."));
  }
  function renderDmxPatchGrid() {
    const grid = $("#dmx-universe-grid");
    if (!grid) return;
    grid.replaceChildren();
    const occupancy = new Map();
    state.lights.filter((light) => light.kind === "dmx" && light.dmx).forEach((light) => {
      const profile = state.dmxProfiles.find((candidate) => candidate.id === light.dmx.profileId);
      (profile?.channels || []).forEach((channel, index) => {
        const address = light.dmx.startAddress + index;
        if (address <= 512) occupancy.set(address, { light, channel, start: index === 0 });
      });
    });
    for (let address = 1; address <= 512; address += 1) {
      const cell = button(String(address), "dmx-channel-cell");
      const assigned = occupancy.get(address);
      cell.dataset.channel = String(address);
      cell.setAttribute("role", "gridcell");
      if ((address - 1) % 32 === 0) cell.classList.add("universe-row-start");
      if (assigned) {
        cell.classList.add("occupied");
        if (assigned.start) cell.classList.add("fixture-start");
        cell.title = "Channel " + address + " · " + assigned.light.name + " · " + assigned.channel.name + (assigned.start ? " · fixture start" : "");
      } else cell.title = "Channel " + address + " · unpatched";
      cell.addEventListener("dragover", (event) => event.preventDefault());
      cell.addEventListener("drop", (event) => {
        event.preventDefault();
        const fixtureId = event.dataTransfer?.getData("text/plain") || state.dmxPatchFixtureId;
        if (fixtureId) void patchDmxFixture(fixtureId, address);
      });
      cell.addEventListener("click", () => {
        if (!state.dmxPatchFixtureId) {
          notify("Choose a DMX fixture before selecting its start channel.", "error");
          return;
        }
        void patchDmxFixture(state.dmxPatchFixtureId, address);
      });
      grid.append(cell);
    }
  }
  async function patchDmxFixture(lightId, startAddress) {
    const light = state.lights.find((item) => item.id === lightId && item.kind === "dmx");
    if (!light?.dmx) return;
    try {
      const result = await api("/lights/" + encodeURIComponent(lightId) + "/dmx-patch", { method: "PATCH", body: { ...light.dmx, startAddress } });
      state.lights[state.lights.findIndex((item) => item.id === lightId)] = result.light;
      state.dmxPatchFixtureId = lightId;
      renderDmxSetup();
      renderSetupLights();
      renderFixtureGrid();
      notify("" + result.light.name + " patched at DMX address " + startAddress + (result.outputWarning ? " · output unavailable; saved in WebGlow" : ""), result.outputWarning ? "" : "success");
    } catch (error) { handleError(error); }
  }
  async function loadDmxSetup() {
    const [profiles, status] = await Promise.all([api("/dmx/profiles"), api("/dmx/status")]);
    state.dmxProfiles = profiles.profiles || [];
    state.dmxStatus = status;
    renderDmxSetup();
    renderSetupLights();
  }
  function renderSetupLights() {
    const list = $("#setup-lights");
    list.replaceChildren();
    $("#setup-empty").hidden = state.lights.length > 0;
    state.lights.forEach((light, index) => {
      const row = element("article", "setup-row console-setup-row");
      const number = element("label", "fixture-number-field");
      number.append(element("span", "", "Fixture number"));
      const numberInput = document.createElement("input");
      numberInput.type = "number";
      numberInput.min = "1";
      numberInput.max = "9999";
      numberInput.step = "1";
      numberInput.required = true;
      numberInput.value = String(light.fixtureNumber || index + 1);
      number.append(numberInput);
      const name = element("label");
      name.append(element("span", "", "Fixture name"));
      const nameInput = document.createElement("input");
      nameInput.value = light.name;
      nameInput.maxLength = 80;
      name.append(nameInput);
      const id = element("label");
      const isWled = light.kind === "wled";
      const isDmx = light.kind === "dmx";
      id.append(element("span", "", isWled ? "WLED connection" : isDmx ? "DMX patch" : "Fixture ID"));
      const idInput = document.createElement("input");
      const profile = state.dmxProfiles.find((item) => item.id === light.dmx?.profileId);
      idInput.value = isWled ? light.wled?.url + " · Segment " + light.wled?.segment : isDmx ? (profile?.name || light.dmx?.profileId) + " · Address " + light.dmx?.startAddress + "–" + ((light.dmx?.startAddress || 1) + (profile?.channels.length || 1) - 1) : light.id;
      id.append(idInput);
      let addressInput;
      if (isDmx) {
        idInput.readOnly = true;
        addressInput = document.createElement("input");
        addressInput.type = "number"; addressInput.min = "1"; addressInput.max = "512"; addressInput.step = "1";
        addressInput.inputMode = "numeric"; addressInput.value = String(light.dmx?.startAddress || 1);
        addressInput.setAttribute("aria-label", "DMX start address for " + light.name);
        id.append(element("span", "dmx-typed-address-label", "Start address"), addressInput);
      } else if (isWled) idInput.readOnly = true;
      const actions = element("div", "row-actions");
      const save = button("Save", "console-button subtle-button");
      const destroy = button("Delete", "console-button danger-button");
      if (isDmx) {
        row.draggable = true;
        row.title = "Drag this fixture onto a channel in the patch table";
        row.addEventListener("dragstart", (event) => {
          state.dmxPatchFixtureId = light.id;
          if (event.dataTransfer) { event.dataTransfer.setData("text/plain", light.id); event.dataTransfer.effectAllowed = "move"; }
          const patchSelect = $("#dmx-patch-fixture");
          if (patchSelect) patchSelect.value = light.id;
          $("#dmx-patch-selection").textContent = "Selected: " + light.name + " · drop on a channel to repatch.";
        });
      }
      save.addEventListener("click", async () => {
        try {
          let saved = light;
          if (isDmx && Number(addressInput.value) !== light.dmx?.startAddress) {
            const patched = await api("/lights/" + encodeURIComponent(light.id) + "/dmx-patch", { method: "PATCH", body: { ...light.dmx, startAddress: Number(addressInput.value) } });
            saved = patched.light;
          }
          const updated = await api("/lights/" + encodeURIComponent(light.id), { method: "PATCH", body: { name: nameInput.value, fixtureNumber: Number(numberInput.value) } });
          state.lights[state.lights.findIndex((candidate) => candidate.id === light.id)] = { ...saved, ...updated, ...(saved.dmx ? { dmx: saved.dmx } : {}) };
          if (isDmx) renderDmxSetup();
          renderFixtureGrid();
          renderSetupLights();
          notify("Fixture details saved. Its stable fixture ID is unchanged.", "success");
        } catch (error) { handleError(error); }
      });
      destroy.addEventListener("click", async () => {
        if (!window.confirm("Delete “" + light.name + "”? This only removes it from WebGlow.")) return;
        try {
          await api("/lights/" + encodeURIComponent(light.id), { method: "DELETE" });
          state.lights = state.lights.filter((candidate) => candidate.id !== light.id);
          state.selected.delete(light.id);
          if (isDmx) { state.dmxPatchSignature = ""; renderDmxSetup(); }
          renderFixtureGrid();
          renderSetupLights();
          notify("Fixture deleted.", "success");
        } catch (error) { handleError(error); }
      });
      actions.append(save);
      let displayUrlRow;
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
      } else if (!isDmx) {
        const copy = button("Copy URL", "console-button go-button");
        const show = button("Show URL", "console-button subtle-button");
        const url = element("div", "display-url");
        const code = element("code", "", displayUrl(light.id));
        code.hidden = true;
        copy.addEventListener("click", async () => { await copyText(displayUrl(light.id)); notify("Display URL copied.", "success"); });
        show.addEventListener("click", () => { code.hidden = !code.hidden; show.textContent = code.hidden ? "Show URL" : "Hide URL"; });
        actions.append(copy, show);
        displayUrlRow = url;
        url.append(code);
      }
      if (isDmx) {
        const select = button(state.dmxPatchFixtureId === light.id ? "Selected for patch" : "Select to patch", "console-button subtle-button");
        select.addEventListener("click", () => {
          state.dmxPatchFixtureId = light.id;
          $("#dmx-patch-fixture").value = light.id;
          $("#dmx-patch-selection").textContent = "Selected: " + light.name + " · tap a channel to set its start address.";
          $("#dmx-patch-panel").hidden = false;
          $("#toggle-dmx-patch").setAttribute("aria-expanded", "true");
          $("#toggle-dmx-patch").textContent = "Close patch table";
        });
        actions.append(select);
      }
      actions.append(destroy);
      row.append(number, name, id, actions);
      if (displayUrlRow) row.append(displayUrlRow);
      list.append(row);
    });
  }
  function renderCueList() {
    const list = $("#cue-list");
    list.replaceChildren();
    const stack = state.stacks.find((candidate) => candidate.id === state.activeCueStackId) || state.stacks[0];
    if (stack) state.activeCueStackId = stack.id;
    const stackTabs = $("#cue-stack-tabs");
    stackTabs.replaceChildren();
    state.stacks.forEach((candidate) => {
      const tab = button("", "cue-stack-tab" + (candidate.id === state.activeCueStackId ? " active" : ""));
      tab.dataset.stackId = candidate.id;
      tab.draggable = state.stacks.length > 1;
      tab.setAttribute("aria-pressed", String(candidate.id === state.activeCueStackId));
      const count = state.scenes.filter((scene) => scene.stackId === candidate.id).length;
      const grip = element("span", "reorder-grip", "⠿");
      grip.title = "Drag to reorder cue stacks";
      tab.append(grip, element("strong", "", candidate.name), element("span", "", count + (count === 1 ? " cue" : " cues")));
      bindTouchReorder(grip, ".cue-stack-tab", (item) => item.dataset.stackId, (sourceId, targetId) => {
        const ordered = [...state.stacks];
        const from = ordered.findIndex((item) => item.id === sourceId);
        const to = ordered.findIndex((item) => item.id === targetId);
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = ordered.splice(from, 1);
        ordered.splice(to, 0, moved);
        state.justDraggedCueStack = true;
        void api("/cue-stacks/order", { method: "PUT", body: { stackIds: ordered.map((item) => item.id) } }).then((result) => {
          state.stacks = result.stacks;
          renderCueList();
        }).catch(handleError).finally(() => window.setTimeout(() => { state.justDraggedCueStack = false; }, 220));
      });
      tab.addEventListener("click", () => {
        if (state.justDraggedCueStack) return;
        state.activeCueStackId = candidate.id;
        try { window.localStorage.setItem("webglow.active-cue-stack", candidate.id); } catch {}
        renderCueList();
      });
      tab.addEventListener("dragstart", (event) => { state.draggingCueStackId = candidate.id; event.dataTransfer?.setData("text/plain", candidate.id); });
      tab.addEventListener("dragover", (event) => { if (state.draggingCueStackId) event.preventDefault(); });
      tab.addEventListener("drop", (event) => {
        event.preventDefault();
        const sourceId = state.draggingCueStackId || event.dataTransfer?.getData("text/plain");
        if (!sourceId || sourceId === candidate.id) return;
        const ordered = [...state.stacks];
        const from = ordered.findIndex((item) => item.id === sourceId);
        const to = ordered.findIndex((item) => item.id === candidate.id);
        if (from < 0 || to < 0) return;
        const [moved] = ordered.splice(from, 1);
        ordered.splice(to, 0, moved);
        state.justDraggedCueStack = true;
        void api("/cue-stacks/order", { method: "PUT", body: { stackIds: ordered.map((item) => item.id) } }).then((result) => {
          state.stacks = result.stacks;
          renderCueList();
        }).catch(handleError).finally(() => window.setTimeout(() => { state.justDraggedCueStack = false; }, 160));
      });
      stackTabs.append(tab);
    });
    $("#cue-stack-title").textContent = stack?.name || "Main playback";
    $("#cue-stack-name").value = stack?.name || "";
    $("#rename-cue-stack").disabled = !stack;
    $("#delete-cue-stack").disabled = !stack || stack.id === "main" || state.scenes.some((scene) => scene.stackId === stack.id);
    const stackIndex = state.stacks.findIndex((candidate) => candidate.id === stack?.id);
    $("#cue-stack-earlier").disabled = stackIndex <= 0;
    $("#cue-stack-later").disabled = stackIndex < 0 || stackIndex >= state.stacks.length - 1;
    const rank = new Map((stack?.cueOrder || []).map((id, index) => [id, index]));
    const visibleScenes = state.scenes.filter((scene) => scene.stackId === (stack?.id || "main")).sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER) || Number(left.id) - Number(right.id));
    $("#cue-empty").hidden = visibleScenes.length > 0;
    $("#cue-empty").textContent = stack ? `The ${stack.name} stack is empty. Record a cue or update this stack from the programmer.` : "Create a cue stack to start programming.";
    const active = state.scenes.find((scene) => scene.id === state.activeCueId);
    $("#active-cue").textContent = active ? "Live " + active.id + " · " + active.name : "Standby";
    visibleScenes.forEach((scene) => {
      const row = element("article", "cue-row" + (scene.id === state.activeCueId ? " active" : ""));
      row.draggable = true;
      row.dataset.cueId = scene.id;
      row.addEventListener("dragstart", (event) => { state.draggingCueId = scene.id; event.dataTransfer?.setData("text/plain", scene.id); });
      row.addEventListener("dragover", (event) => { if (state.draggingCueId) event.preventDefault(); });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const sourceId = state.draggingCueId || event.dataTransfer?.getData("text/plain");
        if (!sourceId || sourceId === scene.id) return;
        const ordered = [...visibleScenes];
        const from = ordered.findIndex((item) => item.id === sourceId);
        const to = ordered.findIndex((item) => item.id === scene.id);
        if (from < 0 || to < 0) return;
        const [moved] = ordered.splice(from, 1);
        ordered.splice(to, 0, moved);
        void api(`/cue-stacks/${encodeURIComponent(stack.id)}/cues/order`, { method: "PUT", body: { cueOrder: ordered.map((item) => item.id) } })
          .then((result) => { state.stacks = state.stacks.map((item) => item.id === result.stack.id ? result.stack : item); renderCueList(); })
          .catch(handleError);
      });
      row.append(
        element("strong", "cue-number", scene.id),
        element("span", "cue-name", scene.name),
        element("span", "cue-targets", (scene.ids === "all" ? "All · dynamic" : scene.ids.length + " selected") + (scene.scaleEffect ? " · scaled" : "")),
        element("span", "cue-fade", (Number(scene.state.fadeMs || 0) / 1000) + " s"),
      );
      const cueNumber = row.querySelector(".cue-number");
      const grip = element("span", "reorder-grip", "⠿");
      grip.title = "Drag to reorder this cue";
      cueNumber.prepend(grip);
      bindTouchReorder(grip, ".cue-row", (item) => item.dataset.cueId, (sourceId, targetId) => {
        const ordered = [...visibleScenes];
        const from = ordered.findIndex((item) => item.id === sourceId);
        const to = ordered.findIndex((item) => item.id === targetId);
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = ordered.splice(from, 1);
        ordered.splice(to, 0, moved);
        state.justDraggedCue = true;
        void api(`/cue-stacks/${encodeURIComponent(stack.id)}/cues/order`, { method: "PUT", body: { cueOrder: ordered.map((item) => item.id) } })
          .then((result) => { state.stacks = state.stacks.map((item) => item.id === result.stack.id ? result.stack : item); renderCueList(); })
          .catch(handleError).finally(() => window.setTimeout(() => { state.justDraggedCue = false; }, 220));
      });
      const actions = element("div", "cue-actions");
      const go = button("Go", "console-button go-button");
      const update = button("Update", "console-button subtle-button");
      const earlier = button("↑", "console-button subtle-button order-control");
      const later = button("↓", "console-button subtle-button order-control");
      const deleteCue = button("Delete", "console-button subtle-button");
      earlier.title = "Move cue earlier in this stack";
      later.title = "Move cue later in this stack";
      const cueIndex = visibleScenes.findIndex((candidate) => candidate.id === scene.id);
      earlier.disabled = cueIndex <= 0;
      later.disabled = cueIndex < 0 || cueIndex >= visibleScenes.length - 1;
      go.addEventListener("click", () => runCue(scene));
      update.addEventListener("click", () => { void updateCue(scene); });
      earlier.addEventListener("click", () => { void moveCueOrder(scene.id, -1); });
      later.addEventListener("click", () => { void moveCueOrder(scene.id, 1); });
      deleteCue.addEventListener("click", () => deleteCueById(scene.id));
      actions.append(go, update, earlier, later, deleteCue);
      row.append(actions);
      list.append(row);
    });
    state.timecodeConsole?.refreshCueOptions();
  }
  async function moveCueOrder(cueId, direction) {
    const stack = state.stacks.find((candidate) => candidate.id === state.activeCueStackId);
    if (!stack) return;
    const rank = new Map(stack.cueOrder.map((id, index) => [id, index]));
    const ordered = state.scenes.filter((scene) => scene.stackId === stack.id).sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER) || Number(left.id) - Number(right.id));
    const from = ordered.findIndex((scene) => scene.id === cueId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
    try {
      const result = await api(`/cue-stacks/${encodeURIComponent(stack.id)}/cues/order`, { method: "PUT", body: { cueOrder: ordered.map((scene) => scene.id) } });
      state.stacks = state.stacks.map((candidate) => candidate.id === stack.id ? result.stack : candidate);
      renderCueList();
    } catch (error) { handleError(error); }
  }
  async function moveStackOrder(direction) {
    const from = state.stacks.findIndex((stack) => stack.id === state.activeCueStackId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= state.stacks.length) return;
    const ordered = [...state.stacks];
    [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
    try {
      const result = await api("/cue-stacks/order", { method: "PUT", body: { stackIds: ordered.map((stack) => stack.id) } });
      state.stacks = result.stacks;
      renderCueList();
    } catch (error) { handleError(error); }
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
      add("Listening port", String(state.settings.server.port));
      const https = state.settings.server.https;
      if (https) {
        add("HTTPS listener", https.enabled ? "Enabled · public port " + https.publicPort : "Disabled");
        add("HTTPS certificate", https.certificateMode === "local-ca" ? "WebGlow-generated local CA" : https.certificateMode === "custom" ? "Custom PEM certificate" : "Not configured");
        if (https.configuredHosts?.length) add("Additional certificate names", https.configuredHosts.join(", "));
        if (https.localCaFingerprint) add("Local CA SHA-256", https.localCaFingerprint);
        const trustNote = $("#https-trust-note");
        trustNote.textContent = https.certificateMode === "local-ca"
          ? "WebGlow generated a local CA and an IP/domain-matched server certificate. Browsers still warn until the CA is installed and trusted on each device. For a zero-warning guest experience, provide a publicly trusted certificate for your domain. WebGlow learns the current HTTP host automatically; restart after saving a different public URL to add that name."
          : https.certificateMode === "custom"
            ? "The custom certificate must include the exact IP address or domain in the public URL and a complete certificate chain. Browser trust depends on the issuing authority. Set WEBGLOW_TLS_CERT_FILE and WEBGLOW_TLS_KEY_FILE in the deployment environment; restart after changing certificate files."
            : "HTTPS is disabled. Set WEBGLOW_HTTPS_ENABLED=true in the application environment and restart WebGlow.";
        $("#download-https-ca").hidden = https.certificateMode !== "local-ca";
      }
      add("CORS policy", state.settings.server.corsOrigin);
      add("Persistent storage", state.settings.server.persistence);
    }
  }
  function renderGuestSharing() {
    const enabled = state.settings.guestRegistrationEnabled === true;
    $("#guest-registration-enabled").checked = enabled;
    $("#guest-share").hidden = !enabled;
    $("#setup-guest-share").hidden = !enabled;
    if (!enabled) return;
    $("#guest-join-url").textContent = guestJoinUrl();
    const qrUrl = "/api/v1/guest-registration/qr?cache=" + Date.now();
    $("#guest-qr").src = qrUrl;
    $("#setup-guest-qr").src = qrUrl;
  }
  async function downloadQrPng(source, filename) {
    const image = new Image();
    image.src = source;
    await image.decode();
    const size = 1200;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the QR image.");
    context.clearRect(0, 0, size, size);
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, size, size);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG conversion failed.")), "image/png"));
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  function openQrModal(image) {
    const modal = $("#qr-modal");
    const preview = $("#qr-modal-image");
    preview.src = image.currentSrc || image.src;
    preview.alt = image.alt || "Enlarged QR code";
    $("#qr-modal-label").textContent = image.id === "public-url-qr-image" ? $("#public-url-qr-label").textContent : guestJoinUrl();
    modal.dataset.filename = image.id === "public-url-qr-image" ? "WebGlow-application-QR.png" : "WebGlow-guest-join-QR.png";
    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", "");
  }
  document.addEventListener("click", (event) => {
    const image = event.target.closest?.("img.qr-code-preview");
    if (image) openQrModal(image);
  });
  $("#qr-modal-close").addEventListener("click", () => $("#qr-modal").close());
  $("#qr-modal").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
  $("#qr-modal-download").addEventListener("click", async () => {
    try { await downloadQrPng($("#qr-modal-image").src, $("#qr-modal").dataset.filename || "WebGlow-QR.png"); notify("Transparent PNG downloaded.", "success"); }
    catch (error) { handleError(error); }
  });
  function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let value = Number(bytes) || 0;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return (value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
  }
  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours ? hours + "h " + minutes + "m" : minutes + "m " + (total % 60) + "s";
  }
  function renderDetailList(selector, entries) {
    const root = $(selector);
    root.replaceChildren();
    entries.forEach(([key, value]) => {
      const row = element("div");
      row.append(element("dt", "", key), element("dd", "", value));
      root.append(row);
    });
  }
  function renderCommandHistory() {
    const list = $("#command-history-list");
    list.replaceChildren();
    const data = state.history || { events: [], count: 0, storageBytes: 0, retention: state.settings.historyRetention || "month" };
    const events = data.events || [];
    $("#history-summary").textContent = data.count + " commands · " + formatBytes(data.storageBytes);
    $("#history-load-older").hidden = !data.hasMore;
    $("#history-undo").disabled = !data.undoAvailable;
    $("#history-redo").disabled = !data.redoAvailable;
    if (!events.length) {
      const emptyMessage = data.count > 0
        ? "Open History to load the retained command list."
        : "No commands in the selected history window yet.";
      list.append(element("p", "console-empty", emptyMessage));
      return;
    }
    events.forEach((entry) => {
      const row = element("article", "history-row");
      const stamp = new Date(entry.at);
      row.append(
        element("time", "history-time", Number.isNaN(stamp.getTime()) ? "—" : stamp.toLocaleString()),
        element("strong", "history-action", entry.action),
        element("span", "history-summary-text", entry.summary),
        element("span", "history-fixtures", entry.fixtureIds?.length ? entry.fixtureIds.length + " fixtures" : "system"),
      );
      if (entry.detail) row.append(element("small", "history-detail", entry.detail));
      if (entry.canRestore) {
        const restore = button("Restore point", "console-button subtle-button history-restore");
        restore.title = "Restore the affected fixtures to their output at this history point";
        restore.addEventListener("click", () => { void restoreHistoryPoint(entry.id); });
        row.append(restore);
      }
      list.append(row);
    });
    if (data.count > events.length) list.append(element("p", "history-detail", "Showing the latest " + events.length + " of " + data.count + " retained commands."));
  }
  async function restoreHistoryPoint(eventId) {
    if (!window.confirm("Restore the affected fixtures to their output at this history point?")) return;
    try {
      const result = await api("/history/" + encodeURIComponent(eventId) + "/restore", { method: "POST", body: {} });
      mergeUpdatedLights(result.lights || []);
      renderFixtureGrid();
      await loadHistory(!$("#command-history-panel").hidden);
      notify("Fixtures restored to the selected history point.", "success");
    } catch (error) { handleError(error); }
  }
  function mergeUpdatedLights(updated) {
    const byId = new Map(updated.map((light) => [light.id, light]));
    state.lights = state.lights.map((light) => byId.get(light.id) || light);
  }
  async function moveHistory(direction) {
    try {
      const result = await api("/history/" + direction, { method: "POST", body: {} });
      mergeUpdatedLights(result.lights || []);
      renderFixtureGrid();
      await loadHistory(!$("#command-history-panel").hidden);
      notify(direction === "undo" ? "Output change undone." : "Output change redone.", "success");
    } catch (error) { handleError(error); }
  }
  function renderMediaLibrary() {
    const list = $("#media-library");
    list.replaceChildren();
    const totalBytes = state.mediaAssets.reduce((total, asset) => total + asset.sizeBytes, 0);
    $("#media-storage").textContent = formatBytes(totalBytes) + " in library";
    $("#apply-media").disabled = !state.mediaAssets.some((asset) => asset.id === state.selectedMediaId);
    state.mediaAssets.forEach((asset) => {
      const row = element("article", "media-card" + (asset.id === state.selectedMediaId ? " selected" : ""));
      const choose = button("", "media-select");
      choose.setAttribute("aria-pressed", String(asset.id === state.selectedMediaId));
      if (asset.kind === "image") {
        const image = element("img");
        image.src = asset.url;
        image.alt = "";
        choose.append(image);
      } else {
        choose.append(element("span", "media-video-mark", asset.url.toLowerCase().endsWith(".webm") || asset.url.toLowerCase().endsWith(".mp4") ? "▶" : "GIF"));
      }
      const details = element("div", "media-card-details");
      const label = asset.kind === "video" ? "Video loop" : asset.url.toLowerCase().endsWith(".gif") ? "Animated GIF" : "Still image";
      details.append(element("b", "", label), element("span", "", formatBytes(asset.sizeBytes)));
      const remove = button("Delete", "console-button subtle-button");
      choose.addEventListener("click", () => {
        state.selectedMediaId = asset.id;
        $("#program-media-status").textContent = label + " ready to add";
        renderMediaLibrary();
      });
      remove.addEventListener("click", async () => {
        if (!window.confirm("Delete this media file? Displays using it will no longer be able to load it.")) return;
        try {
          await api("/media/" + encodeURIComponent(asset.id), { method: "DELETE" });
          state.mediaAssets = state.mediaAssets.filter((candidate) => candidate.id !== asset.id);
          if (state.selectedMediaId === asset.id) state.selectedMediaId = null;
          if (state.programmer.mediaUrl === asset.url) { state.programmer.mediaUrl = null; state.programmer.mediaKind = null; state.programmer.mediaTouched = true; }
          renderMediaLibrary();
          notify("Media deleted.", "success");
        } catch (error) { handleError(error); }
      });
      row.append(choose, details, remove);
      list.append(row);
    });
    if (!state.mediaAssets.length) list.append(element("p", "console-empty", "Upload a GIF, image, or silent video to build a media layer."));
    if (state.programmer.mediaUrl) {
      const current = state.mediaAssets.find((asset) => asset.url === state.programmer.mediaUrl);
      $("#program-media-opacity").value = String(state.programmer.mediaOpacity ?? 100);
      $("#program-media-opacity-output").textContent = $("#program-media-opacity").value + "%";
      const selected = state.mediaAssets.find((asset) => asset.id === state.selectedMediaId);
      const label = (asset) => asset.kind === "video" ? "video loop" : asset.url.toLowerCase().endsWith(".gif") ? "animated GIF" : "still image";
      $("#program-media-status").textContent = selected && selected.url !== state.programmer.mediaUrl
        ? "Selected · " + label(selected) + " ready to add"
        : current ? "Playing · " + label(current) : "A media layer is in the current look";
    } else if (state.selectedMediaId) {
      $("#program-media-status").textContent = "Selected · ready to add as a layer";
    } else {
      $("#program-media-status").textContent = "No media layer in the current look";
    }
  }
  function renderMonitoring() {
    const metrics = state.metrics;
    const guests = state.guests;
    if (!metrics) return;
    const traffic = metrics.traffic || {};
    const process = metrics.process || {};
    const host = metrics.host || {};
    $("#monitor-cpu").textContent = Number(process.cpuPercent || 0).toFixed(1) + "%";
    $("#monitor-memory").textContent = formatBytes(process.rssBytes);
    $("#monitor-sockets").textContent = String(traffic.activeDisplaySockets || 0);
    $("#monitor-guests-count").textContent = String(guests?.registered || 0);
    renderDetailList("#monitor-process", [
      ["Uptime", formatDuration(metrics.uptimeSeconds)],
      ["CPU", Number(process.cpuPercent || 0).toFixed(1) + "%"],
      ["RSS memory", formatBytes(process.rssBytes)],
      ["Heap used", formatBytes(process.heapUsedBytes) + " of " + formatBytes(process.heapTotalBytes)],
      ["Started", metrics.startedAt ? new Date(metrics.startedAt).toLocaleString() : "—"],
    ]);
    renderDetailList("#monitor-traffic", [
      ["Requests", String(traffic.requests || 0)],
      ["Received", formatBytes(traffic.receivedBytes)],
      ["Sent", formatBytes(traffic.sentBytes)],
      ["Display sockets", String(traffic.activeDisplaySockets || 0)],
      ["Scope", traffic.note || "WebGlow service traffic"],
    ]);
    renderDetailList("#monitor-host", [
      ["Runtime", (host.platform || "—") + " · " + (host.architecture || "—")],
      ["CPUs", String(host.cpus || "—")],
      ["Free memory", formatBytes(host.freeMemoryBytes) + " of " + formatBytes(host.totalMemoryBytes)],
      ["Load average", Array.isArray(host.loadAverage) ? host.loadAverage.map((value) => Number(value).toFixed(2)).join(" · ") : "—"],
    ]);
    renderDetailList("#monitor-guests", [
      ["Registration", guests?.registrationEnabled ? "Open" : "Closed"],
      ["Registered", String(guests?.registered || 0)],
      ["Active lights", String(guests?.active || 0)],
      ["Guest sockets", String(guests?.activeSockets || 0)],
      ["Guest state", formatBytes(guests?.resources?.persistedStateBytes)],
      ["Guest traffic", formatBytes(guests?.resources?.outboundWebsocketBytes)],
    ]);
    const guestList = $("#monitor-guest-list");
    guestList.replaceChildren();
    (guests?.guests || []).slice(0, 24).forEach((guest) => {
      const row = element("div", "monitor-guest" + (guest.connected ? " connected" : ""));
      const seen = guest.lastSeenAt ? new Date(guest.lastSeenAt).toLocaleString() : "unknown";
      row.append(element("b", "", guest.name), element("span", "", guest.connected ? "Connected" : "Offline · " + seen));
      guestList.append(row);
    });
    if (!(guests?.guests || []).length) guestList.append(element("p", "console-empty", "No guest lights have registered."));
    $("#monitor-updated").textContent = "Last refreshed " + new Date().toLocaleTimeString() + ". Values update every 15 seconds while the portal is open.";
  }
  async function loadLights() {
    const result = await api("/lights");
    state.lights = (result.lights || []).sort((left, right) => left.id.localeCompare(right.id));
    const existing = new Set(state.lights.map((light) => light.id));
    state.selected = new Set([...state.selected].filter((id) => existing.has(id)));
    renderFixtureGrid();
    renderSetupLights();
    const signature = JSON.stringify(state.lights.filter((light) => light.kind === "dmx").map((light) => [light.id, light.name, light.fixtureNumber, light.dmx]));
    if (signature !== state.dmxPatchSignature) {
      state.dmxPatchSignature = signature;
      renderDmxSetup();
    }
  }
  async function loadScenes() {
    const result = await api("/scenes");
    state.scenes = result.scenes || [];
    state.stacks = result.stacks || [{ id: "main", name: "Main", cueOrder: [] }];
    try {
      const rememberedStack = window.localStorage.getItem("webglow.active-cue-stack");
      state.activeCueStackId = state.stacks.some((stack) => stack.id === rememberedStack) ? rememberedStack : state.stacks[0]?.id || "main";
    } catch { state.activeCueStackId = state.stacks[0]?.id || "main"; }
    try {
      const remembered = window.localStorage.getItem("webglow.active-cue");
      state.activeCueId = state.scenes.some((scene) => scene.id === remembered) ? remembered : null;
    } catch { state.activeCueId = null; }
    renderCueList();
  }
  async function loadSettings() {
    state.settings = await api("/settings");
    $("#public-base-url").value = state.settings.publicBaseUrl || "";
    renderServerDetails(state.metrics);
    renderGuestSharing();
    $("#history-retention").value = state.settings.historyRetention || "month";
    $("#guest-auto-remove-enabled").checked = state.settings.guestAutoRemoveEnabled === true;
    $("#guest-inactivity-hours").value = String(state.settings.guestInactivityHours || 24);
    $("#guest-remember-hours").value = String(state.settings.guestRememberHours || 24);
    $("#auto-refresh-devices").checked = state.settings.autoRefreshDevices !== false;
    $("#seat-sections").value = (state.settings.seatSections || ["Left", "Center", "Right"]).join("\n");
    $("#virtual-subsections-enabled").checked = state.settings.virtualSubsectionsEnabled === true;
    $("#virtual-subsections-count").value = String(state.settings.virtualSubsectionsCount || 3);
    $("#virtual-subsections-count-field").hidden = !$("#virtual-subsections-enabled").checked;
    $("#fixture-sort-mode").value = state.settings.fixtureSortMode || "id";
    renderFixtureGrid();
    renderSettingsCategory(document.querySelector("[data-settings-tab].active")?.dataset.settingsTab || "display");
    void loadCloudflared().catch(handleError);
  }
  async function loadCloudflared() {
    const tunnel = await api("/tunnel");
    state.cloudflared = tunnel;
    const labels = {
      unconfigured: "Not configured",
      unavailable: "Install cloudflared",
      stopped: "Disconnected",
      starting: "Connecting…",
      connected: "Connected",
      stopping: "Disconnecting…",
      error: "Connection error",
    };
    $("#cloudflared-state").textContent = labels[tunnel.state] || tunnel.state;
    $("#cloudflared-state").dataset.tone = tunnel.state === "connected" ? "success" : tunnel.state === "error" || tunnel.state === "unavailable" ? "error" : "";
    $("#cloudflared-message").textContent = tunnel.message + (tunnel.hostname ? " Public hostname: https://" + tunnel.hostname : "");
    if (document.activeElement !== $("#cloudflared-hostname")) $("#cloudflared-hostname").value = tunnel.hostname || "";
    if (document.activeElement !== $("#cloudflared-auto-start")) $("#cloudflared-auto-start").checked = tunnel.autoStart === true;
    $("#cloudflared-output").textContent = tunnel.output?.length ? tunnel.output.join("\n") : "No tunnel output yet.";
    $("#cloudflared-connect").disabled = tunnel.state === "connected" || tunnel.state === "starting" || tunnel.state === "stopping" || !tunnel.configured || !tunnel.installed;
    $("#cloudflared-disconnect").disabled = tunnel.state === "stopped" || tunnel.state === "unconfigured" || tunnel.state === "unavailable";
    if (["starting", "connected", "stopping"].includes(tunnel.state)) {
      if (!state.cloudflaredTimer) state.cloudflaredTimer = window.setInterval(() => { void loadCloudflared().catch(() => undefined); }, 3000);
    } else if (state.cloudflaredTimer) {
      window.clearInterval(state.cloudflaredTimer);
      state.cloudflaredTimer = null;
    }
  }
  async function loadGuests() {
    const guests = await api("/guests");
    state.guests = guests;
    renderMonitoring();
  }
  async function loadHistory(includeEvents = false, append = false) {
    const offset = append ? (state.history?.events?.length || 0) : 0;
    const query = includeEvents ? "?includeEvents=true&offset=" + offset : "";
    const result = await api("/history" + query);
    if (append && state.history) result.events = [...(state.history.events || []), ...(result.events || [])];
    state.history = result;
    renderCommandHistory();
    $("#history-storage").textContent = state.history.count + " commands · " + formatBytes(state.history.storageBytes) + " on disk";
  }
  async function loadMedia() {
    const response = await api("/media");
    state.mediaAssets = response.assets || [];
    if (!state.selectedMediaId && state.programmer.mediaUrl) {
      state.selectedMediaId = state.mediaAssets.find((asset) => asset.url === state.programmer.mediaUrl)?.id || null;
    }
    if (!state.mediaAssets.some((asset) => asset.id === state.selectedMediaId)) state.selectedMediaId = null;
    renderMediaLibrary();
  }
  async function loadMetrics() {
    try {
      const metrics = await api("/metrics");
      state.metrics = metrics;
      renderServerDetails(metrics);
      renderMonitoring();
    } catch (error) {
      handleError(error);
    }
  }
  function scheduleProgrammerApply() {
    if (state.liveApplyTimer) window.clearTimeout(state.liveApplyTimer);
    $("#live-programmer-status").textContent = "Sending live output…";
    state.liveApplyTimer = window.setTimeout(() => {
      state.liveApplyTimer = null;
      void applyProgrammer(true);
    }, 65);
  }
  async function applyProgrammer(live = false) {
    syncProgrammerFromInputs();
    if (state.liveApplyInFlight) {
      state.liveApplyQueued = true;
      return;
    }
    state.liveApplyInFlight = true;
    try {
      const program = effectiveProgrammer();
      const useChaseHelper = program.pattern === "chase" && !program.layers?.length && !state.programmer.mediaTouched;
      const result = useChaseHelper
        ? await api("/lights/chase", { method: "POST", body: { ids: targetIds(), color: program.color, speed: program.speed, fadeMs: program.fadeMs, direction: $("#program-direction").value, on: true } })
        : await api("/lights/batch", { method: "POST", body: { ids: targetIds(), state: program, direction: $("#program-direction").value } });
      state.lights = result.lights || state.lights;
      renderFixtureGrid();
      renderSetupLights();
      const message = "Live on " + result.count + " fixture" + (result.count === 1 ? "" : "s");
      $("#live-programmer-status").textContent = message;
      if (!live) { setStatus("Live programmer applied to " + result.count + " fixture" + (result.count === 1 ? "" : "s"), "success"); notify("Live output applied.", "success"); }
    } catch (error) { $("#live-programmer-status").textContent = "Live output unavailable"; handleError(error); }
    finally {
      state.liveApplyInFlight = false;
      if (state.liveApplyQueued) {
        state.liveApplyQueued = false;
        scheduleProgrammerApply();
      }
    }
  }
  async function makeChase() {
    syncProgrammerFromInputs();
    try {
      const program = effectiveProgrammer();
      const useBatch = program.pattern === "multi-chase" || Boolean(program.layers?.length) || state.programmer.mediaTouched;
      const result = useBatch
        ? await api("/lights/batch", { method: "POST", body: { ids: targetIds(), state: program, direction: $("#program-direction").value } })
        : await api("/lights/chase", { method: "POST", body: { ids: targetIds(), color: program.color, speed: program.speed, fadeMs: program.fadeMs, direction: $("#program-direction").value, on: true } });
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
  function renderBlackoutState() {
    ["#blackout", "#master-blackout"].forEach((selector) => {
      const control = $(selector);
      control.textContent = state.blackoutActive ? "Restore output" : "Blackout";
      control.setAttribute("aria-pressed", String(state.blackoutActive));
      control.classList.toggle("active", state.blackoutActive);
    });
  }
  async function blackout() {
    try {
      if (state.blackoutActive) {
        if (state.blackoutRestoreIds.length) await api("/lights/batch", { method: "POST", body: { ids: state.blackoutRestoreIds, state: { on: true, fadeMs: effectiveProgrammer().fadeMs } } });
        state.blackoutActive = false;
        state.blackoutRestoreIds = [];
        renderBlackoutState();
        await loadLights();
        notify("Blackout released; previous live fixtures restored.", "success");
        return;
      }
      state.blackoutRestoreIds = state.lights.filter((light) => light.state.on).map((light) => light.id);
      await api("/lights/batch", { method: "POST", body: { ids: "all", state: { on: false, fadeMs: 0 } } });
      state.blackoutActive = true;
      renderBlackoutState();
      await loadLights();
      notify("Blackout active.", "success");
    } catch (error) { handleError(error); }
  }
  async function restoreOutput() {
    if (state.blackoutActive) return blackout();
    try {
      await api("/lights/batch", { method: "POST", body: { ids: "all", state: { on: true, fadeMs: effectiveProgrammer().fadeMs } } });
      await loadLights();
      notify("Output restored.", "success");
    } catch (error) { handleError(error); }
  }
  async function recordCue() {
    syncProgrammerFromInputs();
    const recordLive = $("#timecode-live-record").checked;
    if (recordLive && !state.timecodeConsole?.canRecordLiveCue()) {
      notify("Select a song timeline, arm LTC, and wait for a locked signal before recording live.", "error");
      return;
    }
    try {
      const id = $("#cue-number").value.trim();
      const name = $("#cue-name").value.trim();
      const targetMode = $("#cue-target-mode").value;
      if (targetMode === "selected" && !state.selected.size) {
        notify("Select fixtures or choose All current & future for a dynamic cue.", "error");
        return;
      }
      const result = await api("/scenes", {
        method: "POST",
        body: {
          id,
          stackId: state.activeCueStackId,
          ...(name ? { name } : {}),
          ids: targetMode === "all" ? "all" : [...state.selected],
          state: getStoredCueState(),
          scaleEffect: $("#cue-scale-effect").checked,
          ...(state.programmerAttributes.has("effect") ? { effectDirection: $("#program-direction").value } : {}),
        },
      });
      state.scenes.push(result.scene);
      state.scenes.sort((left, right) => Number(left.id) - Number(right.id));
      const stack = state.stacks.find((item) => item.id === result.scene.stackId);
      if (stack && !stack.cueOrder.includes(result.scene.id)) stack.cueOrder.push(result.scene.id);
      state.activeCueStackId = result.scene.stackId;
      try { window.localStorage.setItem("webglow.active-cue-stack", state.activeCueStackId); } catch {}
      renderCueList();
      if (recordLive) await state.timecodeConsole.recordCueAtCurrentLtc(result.scene.id);
      const next = Number(id) + 1;
      if (Number.isFinite(next)) $("#cue-number").value = String(next);
      $("#cue-name").value = "";
      await loadHistory();
      notify("Cue " + id + " recorded.", "success");
    } catch (error) { handleError(error); }
  }
  async function updateCue(scene) {
    const targetMode = $("#cue-target-mode").value;
    if (targetMode === "selected" && !state.selected.size) {
      notify("Select fixtures or choose All current & future before updating targets.", "error");
      return;
    }
    try {
      const result = await api("/scenes/" + encodeURIComponent(scene.id), {
        method: "PATCH",
        body: {
          state: { ...scene.state, ...getStoredCueState() },
          stackId: state.activeCueStackId,
          ids: targetMode === "all" ? "all" : [...state.selected],
          scaleEffect: $("#cue-scale-effect").checked,
          ...(state.programmerAttributes.has("effect") ? { effectDirection: $("#program-direction").value } : {}),
        },
      });
      state.scenes = state.scenes.map((candidate) => candidate.id === result.scene.id ? result.scene : candidate);
      await loadScenes();
      notify("Cue " + scene.id + " updated from the programmer.", "success");
    } catch (error) { handleError(error); }
  }
  function runCueStep(direction) {
    const stack = state.stacks.find((candidate) => candidate.id === state.activeCueStackId);
    const order = new Map((stack?.cueOrder || []).map((id, index) => [id, index]));
    const stackScenes = state.scenes.filter((scene) => scene.stackId === state.activeCueStackId)
      .sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER) || Number(left.id) - Number(right.id));
    if (!stackScenes.length) {
      notify("Record a cue before using GO.", "error");
      return;
    }
    const currentIndex = stackScenes.findIndex((scene) => scene.id === state.activeCueId);
    const fallback = direction > 0 ? 0 : stackScenes.length - 1;
    const nextIndex = currentIndex < 0 ? fallback : Math.max(0, Math.min(stackScenes.length - 1, currentIndex + direction));
    void runCue(stackScenes[nextIndex]);
  }
  async function runCue(scene) {
    try {
      const result = await api("/scenes/" + encodeURIComponent(scene.id) + "/go", { method: "POST" });
      state.lights = result.lights || state.lights;
      state.activeCueId = scene.id;
      try { window.localStorage.setItem("webglow.active-cue", scene.id); } catch {}
      renderFixtureGrid();
      renderSetupLights();
      renderCueList();
      setStatus("Cue " + scene.id + " live", "success");
      notify("Cue " + scene.id + " is live.", "success");
    } catch (error) { handleError(error); }
  }
  async function deleteCueById(id) {
    if (!window.confirm("Delete Cue " + id + "?")) return;
    try {
      await api("/scenes/" + encodeURIComponent(id), { method: "DELETE" });
      state.scenes = state.scenes.filter((scene) => scene.id !== id);
      if (state.activeCueId === id) {
        state.activeCueId = null;
        try { window.localStorage.removeItem("webglow.active-cue"); } catch {}
      }
      renderCueList();
      notify("Cue " + id + " deleted.", "success");
    } catch (error) { handleError(error); }
  }
  function switchView(path, replace) {
    const normalized = VIEWS[path] ? path : "/";
    const view = VIEWS[normalized];
    document.querySelectorAll(".app-view").forEach((section) => { section.hidden = section.id !== "view-" + view; });
    document.querySelector(".console-shell").classList.toggle("timeline-view-active", view === "playback");
    document.querySelectorAll("[data-view-link]").forEach((link) => {
      link.classList.toggle("active", link.dataset.viewLink === view);
    });
    document.title = "WebGlow " + (view === "console" ? "Program" : view[0].toUpperCase() + view.slice(1));
    if (!replace && window.location.pathname !== normalized) window.history.pushState({}, "", normalized);
  }
  function showAuth() {
    $("#auth-dialog").hidden = false;
    $("#auth-title").textContent = state.status?.setupRequired ? "Create your portal owner" : "Sign in to WebGlow";
    $("#auth-copy").textContent = state.status?.setupRequired
      ? "This first account protects the Program, Setup, and Settings areas. Use at least 12 characters for the password."
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
      await Promise.all([loadLights(), loadScenes(), loadSettings(), loadMetrics(), loadGuests(), loadHistory(), loadMedia(), loadDmxSetup()]);
      if (!state.timecodeConsole) {
        const { TimecodeConsole } = await import("/timecode-console.js");
        state.timecodeConsole = new TimecodeConsole({ api, getScenes: () => state.scenes, getStacks: () => state.stacks, notify, handleError });
      }
      await state.timecodeConsole.load();
      switchView(window.location.pathname, true);
      setStatus("Connected", "success");
      if (state.metricsTimer) window.clearInterval(state.metricsTimer);
      state.metricsTimer = window.setInterval(() => {
        void loadMetrics();
        void loadHistory(!$("#command-history-panel").hidden).catch(handleError);
      }, 15000);
      if (state.rosterTimer) window.clearInterval(state.rosterTimer);
      state.rosterTimer = window.setInterval(() => {
        if (state.settings.autoRefreshDevices === false) return;
        void loadLights().catch(handleError);
        void loadGuests().catch(handleError);
      }, 5000);
    } catch (error) { handleError(error); }
  }
  function renderSettingsCategory(category) {
    document.querySelectorAll("[data-settings-tab]").forEach((tab) => tab.classList.toggle("active", tab.dataset.settingsTab === category));
    document.querySelectorAll("[data-settings-category]").forEach((panel) => { panel.hidden = panel.dataset.settingsCategory !== category; });
  }
  async function exportShowfile() {
    const includeMedia = $("#showfile-include-media").checked;
    const control = $("#showfile-export");
    control.disabled = true;
    try {
      const response = await fetch(API + "/showfile?includeMedia=" + String(includeMedia), { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new Error(body?.error?.message || "Showfile export failed (" + response.status + ").");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "WebGlow-Showfile-" + new Date().toISOString().slice(0, 10) + ".wgshow";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      notify(includeMedia ? "Showfile exported with referenced media." : "Showfile exported without media files.", "success");
    } catch (error) { handleError(error); }
    finally { control.disabled = false; }
  }
  async function importShowfile(file) {
    let showfile;
    try { showfile = JSON.parse(await file.text()); }
    catch { notify("That file is not valid WebGlow showfile JSON.", "error"); return; }
    const fixtureCount = Array.isArray(showfile?.fixtures) ? showfile.fixtures.length : 0;
    const cueCount = Array.isArray(showfile?.cues) ? showfile.cues.length : 0;
    const timelineCount = Array.isArray(showfile?.timecode?.sequences) ? showfile.timecode.sequences.length : 0;
    const message = `Load “${file.name}”? This replaces ${fixtureCount} configured fixture(s), ${cueCount} cue(s), cue stacks, timelines and audience-section ordering. Guest lights and portal/server settings are preserved. WLED fixtures may change output.`;
    if (!window.confirm(message)) return;
    const input = $("#showfile-import");
    input.disabled = true;
    setStatus("Loading showfile…");
    try {
      const result = await api("/showfile", { method: "PUT", body: showfile });
      try {
        window.localStorage.removeItem("webglow.active-cue");
        window.localStorage.removeItem("webglow.active-cue-stack");
      } catch {}
      await Promise.all([loadLights(), loadScenes(), loadSettings(), loadMedia(), loadHistory(true), loadDmxSetup()]);
      if (state.timecodeConsole) await state.timecodeConsole.load();
      const warnings = [];
      if (result.missingMedia) warnings.push(result.missingMedia + " media reference(s) were unavailable and cleared");
      if (result.wledFailures) warnings.push(result.wledFailures + " WLED fixture(s) did not respond");
      if (result.dmxFailures) warnings.push(result.dmxFailures + " DMX output update(s) failed; check the uDMX connection in Setup");
      setStatus("Connected", "success");
      notify("Showfile loaded: " + result.cues + " cues, " + result.timelines + " timeline(s)." + (warnings.length ? " " + warnings.join("; ") + "." : ""), warnings.length ? "error" : "success");
    } catch (error) { handleError(error); }
    finally { input.value = ""; input.disabled = false; }
  }
  function getStoredCueState() {
    const value = effectiveProgrammer();
    const stored = { on: true, fadeMs: value.fadeMs };
    if (state.programmerAttributes.has("intensity")) stored.brightness = value.brightness;
    if (state.programmerAttributes.has("colour")) stored.color = value.color;
    if (state.programmerAttributes.has("effect")) {
      stored.pattern = value.pattern;
      stored.speed = value.speed;
      if (value.pattern === "multi-chase") {
        stored.colors = value.colors;
        stored.colorTransitions = value.colorTransitions;
        stored.colorStepMs = value.colorStepMs;
      }
      stored.layers = value.layers || [];
      if (state.programmer.mediaTouched) {
        stored.mediaUrl = value.mediaUrl || null;
        stored.mediaKind = value.mediaKind || null;
        stored.mediaOpacity = value.mediaOpacity;
      }
    }
    return stored;
  }
  function setProgrammerInputs(value = {}) {
    state.programmer = {
      on: true,
      brightness: Number.isFinite(value.brightness) ? value.brightness : 80,
      color: value.color || "#2EA8FF",
      colors: Array.isArray(value.colors) && value.colors.length >= 2 ? value.colors : ["#2EA8FF", "#FF3D81", "#FFD447"],
      colorTransition: value.colorTransition === "ramp" ? "ramp-up" : (["snap", "fade", "ramp-up", "ramp-down"].includes(value.colorTransition) ? value.colorTransition : "snap"),
      colorTransitions: Array.isArray(value.colorTransitions) && value.colorTransitions.length >= 2
        ? value.colorTransitions.slice(0, 8).map((transition) => transition === "ramp" ? "ramp-up" : (["snap", "fade", "ramp-up", "ramp-down"].includes(transition) ? transition : "snap"))
        : Array(Math.min(8, Math.max(2, Array.isArray(value.colors) ? value.colors.length : 3))).fill(value.colorTransition === "ramp" ? "ramp-up" : (["snap", "fade", "ramp-up", "ramp-down"].includes(value.colorTransition) ? value.colorTransition : "snap")),
      colorStepMs: Number.isFinite(value.colorStepMs) ? value.colorStepMs : 750,
      pattern: value.pattern || "solid",
      speed: Number.isFinite(value.speed) ? value.speed : 50,
      fadeMs: Number.isFinite(value.fadeMs) ? value.fadeMs : 1000,
      layers: Array.isArray(value.layers) ? value.layers.map((layer) => ({ ...layer })) : [],
      mediaOpacity: Number.isFinite(value.mediaOpacity) ? value.mediaOpacity : 100,
      mediaTouched: value.mediaUrl !== undefined || value.mediaKind !== undefined,
      ...(value.mediaUrl === undefined ? {} : { mediaUrl: value.mediaUrl }),
      ...(value.mediaKind === undefined ? {} : { mediaKind: value.mediaKind }),
    };
    $("#program-brightness").value = String(state.programmer.brightness);
    $("#program-speed").value = String(state.programmer.speed);
    $("#program-colour").value = state.programmer.color;
    state.programmer.colorTransitions = Array.from({ length: state.programmer.colors.length }, (_, index) => state.programmer.colorTransitions[index] || "snap");
    renderPalettePickers(state.programmer.colors, state.programmer.colorTransitions);
    $("#program-color-step").value = String(state.programmer.colorStepMs / 1000);
    $("#program-pattern").value = state.programmer.pattern === "multi-chase" ? "chase" : state.programmer.pattern;
    $("#program-fade").value = String(state.programmer.fadeMs);
    $("#program-media-opacity").value = String(state.programmer.mediaOpacity);
    $("#program-media-opacity-output").textContent = state.programmer.mediaOpacity + "%";
    const mediaId = typeof state.programmer.mediaUrl === "string" ? state.programmer.mediaUrl.match(/^\/media\/([^/?#]+)/)?.[1] : null;
    state.selectedMediaId = mediaId || null;
    renderVisualLayers(state.programmer.layers);
    renderMediaLibrary();
    updateMultiChaseControls();
    updateFaderOutput($("#program-brightness"), $("#program-brightness-output"), "%");
    updateFaderOutput($("#program-speed"), $("#program-speed-output"), "%");
    updateCommandLine();
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
  $("#toggle-command-history").addEventListener("click", () => {
    const panel = $("#command-history-panel");
    panel.hidden = !panel.hidden;
    $("#toggle-command-history").setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) void loadHistory(true).catch(handleError);
  });
  $("#history-undo").addEventListener("click", () => { void moveHistory("undo"); });
  $("#history-redo").addEventListener("click", () => { void moveHistory("redo"); });
  $("#history-load-older").addEventListener("click", async (event) => {
    const control = event.currentTarget;
    control.disabled = true;
    try { await loadHistory(true, true); } catch (error) { handleError(error); }
    finally { control.disabled = false; }
  });
  $("#program-brightness").addEventListener("input", (event) => {
    updateFaderOutput(event.currentTarget, $("#program-brightness-output"), "%");
    syncProgrammerFromInputs(); updateCommandLine(); scheduleProgrammerApply();
  });
  $("#program-speed").addEventListener("input", (event) => {
    updateFaderOutput(event.currentTarget, $("#program-speed-output"), "%");
    syncProgrammerFromInputs(); updateCommandLine(); scheduleProgrammerApply();
  });
  ["#grand-master", "#rate-master", "#fade-master"].forEach((selector) => {
    $(selector).addEventListener("input", () => { syncMasters(); scheduleProgrammerApply(); });
  });
  $("#header-grand-master").addEventListener("input", (event) => {
    $("#grand-master").value = event.currentTarget.value;
    syncMasters();
    scheduleProgrammerApply();
  });
  $("#master-layout").addEventListener("change", (event) => setMasterLayout(event.currentTarget.value));
  $("#tap-division").addEventListener("change", (event) => {
    try { window.localStorage.setItem("webglow.tap-division", event.currentTarget.value); } catch {}
    notify("Tap division set to 1:" + event.currentTarget.value + ". Tap again to apply it.", "success");
  });
  $("#master-wheel-control").addEventListener("change", (event) => {
    setMasterWheelControl(event.currentTarget.checked);
    notify(state.masterWheelControl ? "Mouse-wheel fader control enabled." : "Mouse-wheel fader control disabled.", "success");
  });
  $("#master-deck").addEventListener("wheel", (event) => {
    if (!state.masterWheelControl) return;
    const fader = event.target.closest(".touch-fader");
    const input = fader?.querySelector('input[type="range"]');
    if (!input || input.disabled) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    const steps = Math.max(1, Math.round(Math.abs(event.deltaY) / 100));
    const step = Number(input.step) || 1;
    const next = Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + direction * step * steps));
    input.value = String(next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, { passive: false });
  document.querySelectorAll("[data-settings-tab]").forEach((tab) => tab.addEventListener("click", () => renderSettingsCategory(tab.dataset.settingsTab)));
  $("#permissions-refresh").addEventListener("click", () => {
    if (!state.timecodeConsole) return;
    void state.timecodeConsole.refreshDevices().catch(handleError);
  });
  $("#permission-request-mic").addEventListener("click", () => {
    if (!state.timecodeConsole) return;
    void state.timecodeConsole.refreshDevices(true).then(() => notify("Microphone access checked. " + state.timecodeConsole.inputDevices.length + " addressable input(s) found.", "success")).catch(handleError);
  });
  $("#settings-about").addEventListener("click", () => {
    const trigger = $("#settings-about");
    const verse = $("#psalm-easter-egg");
    const show = verse.hidden;
    trigger.setAttribute("aria-expanded", String(show));
    if (show) {
      verse.hidden = false;
      requestAnimationFrame(() => verse.classList.add("is-visible"));
    } else {
      verse.classList.remove("is-visible");
      window.setTimeout(() => { if (trigger.getAttribute("aria-expanded") !== "true") verse.hidden = true; }, 320);
    }
  });
  $("#showfile-export").addEventListener("click", () => { void exportShowfile(); });
  $("#showfile-import").addEventListener("change", (event) => {
    const file = event.currentTarget.files?.[0];
    if (file) void importShowfile(file);
  });
  $("#fixture-sort-mode").addEventListener("change", async (event) => {
    try {
      const result = await api("/settings", { method: "PATCH", body: { fixtureSortMode: event.currentTarget.value } });
      state.settings = { ...state.settings, ...result };
      renderFixtureGrid();
      notify("Fixture order saved.", "success");
    } catch (error) { handleError(error); }
  });
  $("#audience-behavior-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const seatSections = $("#seat-sections").value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    try {
      const result = await api("/settings", { method: "PATCH", body: {
        seatSections,
        autoRefreshDevices: $("#auto-refresh-devices").checked,
        virtualSubsectionsEnabled: $("#virtual-subsections-enabled").checked,
        virtualSubsectionsCount: Number($("#virtual-subsections-count").value),
      } });
      state.settings = { ...state.settings, ...result };
      renderFixtureGrid();
      notify("Audience sections, effect subsections, and roster refresh settings saved.", "success");
    } catch (error) { handleError(error); }
  });
  $("#virtual-subsections-enabled").addEventListener("change", (event) => {
    $("#virtual-subsections-count-field").hidden = !event.currentTarget.checked;
  });
  $("#reset-masters").addEventListener("click", () => {
    setMasterValues({ "grand-master": 100, "rate-master": 100, "fade-master": 100 });
    scheduleProgrammerApply();
    notify("Masters reset to full output.", "success");
  });
  document.querySelectorAll("[data-master-preset]").forEach((preset) => preset.addEventListener("click", () => {
    const values = {
      full: { "grand-master": 100, "rate-master": 100, "fade-master": 100 },
      half: { "grand-master": 50, "rate-master": 100, "fade-master": 100 },
      snap: { "grand-master": 100, "rate-master": 100, "fade-master": 0 },
    };
    setMasterValues(values[preset.dataset.masterPreset] || values.full);
    scheduleProgrammerApply();
    notify(preset.textContent + " master preset selected.", "success");
  }));
  $("#tap-tempo").addEventListener("click", tapTempo);
  $("#program-colour").addEventListener("input", () => {
    const first = $("#program-color-palette input[type=\"color\"]");
    if (first) { first.value = $("#program-colour").value; first.dispatchEvent(new Event("input", { bubbles: true })); }
    else { syncProgrammerFromInputs(); scheduleProgrammerApply(); }
    updateCommandLine();
  });
  $("#program-pattern").addEventListener("change", () => {
    if ($("#program-pattern").value !== "chase" && state.programmer.pattern === "multi-chase") state.programmer.pattern = $("#program-pattern").value;
    updateMultiChaseControls(); syncProgrammerFromInputs(); updateCommandLine(); scheduleProgrammerApply();
  });
  $("#multi-chase-toggle").addEventListener("click", () => {
    const enable = $("#program-pattern").value !== "chase" || state.programmer.pattern !== "multi-chase";
    if (enable) {
      $("#program-pattern").value = "chase";
      const first = $("#program-color-palette input[type=\"color\"]");
      if (first) { first.value = $("#program-colour").value; first.dispatchEvent(new Event("input", { bubbles: true })); }
    }
    state.programmer.pattern = enable ? "multi-chase" : "chase";
    updateMultiChaseControls(); syncProgrammerFromInputs(); updateCommandLine(); scheduleProgrammerApply();
  });
  $("#program-color-step").addEventListener("input", () => { syncProgrammerFromInputs(); scheduleProgrammerApply(); });
  $("#program-add-color").addEventListener("click", addPaletteColor);
  $("#program-add-layer").addEventListener("click", addVisualLayer);
  document.querySelectorAll("[data-effect-preset]").forEach((button) => button.addEventListener("click", () => applyQuickEffectPreset(button.dataset.effectPreset)));
  $("#program-media-opacity").addEventListener("input", () => {
    $("#program-media-opacity-output").textContent = $("#program-media-opacity").value + "%";
    if (state.programmer.mediaTouched) { syncProgrammerFromInputs(); scheduleProgrammerApply(); }
  });
  $("#program-fade").addEventListener("change", () => { syncProgrammerFromInputs(); updateCommandLine(); scheduleProgrammerApply(); });
  $("#program-direction").addEventListener("change", () => {
    updateCommandLine();
    if ($("#program-pattern").value !== "solid") scheduleProgrammerApply();
  });
  document.querySelectorAll("[data-attribute]").forEach((tab) => tab.addEventListener("click", () => {
    const attribute = tab.dataset.attribute;
    if (state.programmerAttributes.has(attribute)) state.programmerAttributes.delete(attribute);
    else state.programmerAttributes.add(attribute);
    tab.classList.toggle("active", state.programmerAttributes.has(attribute));
    tab.setAttribute("aria-pressed", String(state.programmerAttributes.has(attribute)));
    document.body.dataset.attribute = [...state.programmerAttributes].join(" ");
  }));
  $("#make-chase").addEventListener("click", makeChase);
  $("#flash-fixtures").addEventListener("click", flashFixtures);
  $("#blackout").addEventListener("click", blackout);
  $("#master-blackout").addEventListener("click", blackout);
  $("#restore-output").addEventListener("click", restoreOutput);
  $("#clear-programmer").addEventListener("click", () => {
    if (state.clearArmed) {
      state.clearArmed = false;
      if (state.clearTimer) window.clearTimeout(state.clearTimer);
      state.clearTimer = null;
      const active = state.scenes.find((scene) => scene.id === state.activeCueId);
      setProgrammerInputs(active?.state || {});
      $("#program-direction").value = active?.effectDirection || "forward";
      if (active) void runCue(active);
      else notify("Programmer cleared to defaults; no cue is currently active.", "success");
      return;
    }
    state.selected.clear();
    renderFixtureGrid();
    state.clearArmed = true;
    notify("Fixture selection cleared. Press Clear again to clear the programmer and restore the active cue.", "success");
    state.clearTimer = window.setTimeout(() => { state.clearArmed = false; state.clearTimer = null; }, 1100);
  });
  $("#all-fixtures").addEventListener("click", () => {
    state.selected = new Set(state.lights.map((light) => light.id));
    renderFixtureGrid();
    notify("All fixtures selected.", "success");
  });
  $("#record-cue").addEventListener("click", recordCue);
  $("#cue-stack-earlier").addEventListener("click", () => { void moveStackOrder(-1); });
  $("#cue-stack-later").addEventListener("click", () => { void moveStackOrder(1); });
  $("#create-cue-stack").addEventListener("click", async () => {
    const name = $("#cue-stack-name").value.trim();
    if (!name) { notify("Enter a name for the new cue stack.", "error"); return; }
    try {
      const result = await api("/cue-stacks", { method: "POST", body: { name } });
      state.stacks.push(result.stack);
      state.activeCueStackId = result.stack.id;
      try { window.localStorage.setItem("webglow.active-cue-stack", state.activeCueStackId); } catch {}
      renderCueList();
      notify("Cue stack created. Record cues into it, then switch stacks from the cards.", "success");
    } catch (error) { handleError(error); }
  });
  $("#rename-cue-stack").addEventListener("click", async () => {
    const stack = state.stacks.find((item) => item.id === state.activeCueStackId);
    const name = $("#cue-stack-name").value.trim();
    if (!stack || !name) return;
    try {
      const result = await api("/cue-stacks/" + encodeURIComponent(stack.id), { method: "PATCH", body: { name } });
      state.stacks = state.stacks.map((item) => item.id === stack.id ? result.stack : item);
      renderCueList();
      notify("Cue stack renamed.", "success");
    } catch (error) { handleError(error); }
  });
  $("#delete-cue-stack").addEventListener("click", async () => {
    const stack = state.stacks.find((item) => item.id === state.activeCueStackId);
    if (!stack || stack.id === "main" || state.scenes.some((scene) => scene.stackId === stack.id)) return;
    if (!window.confirm("Delete the empty “" + stack.name + "” cue stack?")) return;
    try {
      await api("/cue-stacks/" + encodeURIComponent(stack.id), { method: "DELETE" });
      state.stacks = state.stacks.filter((item) => item.id !== stack.id);
      state.activeCueStackId = state.stacks[0]?.id || "main";
      try { window.localStorage.setItem("webglow.active-cue-stack", state.activeCueStackId); } catch {}
      renderCueList();
      notify("Empty cue stack deleted.", "success");
    } catch (error) { handleError(error); }
  });
  $("#cue-go-next").addEventListener("click", () => runCueStep(1));
  $("#cue-back").addEventListener("click", () => runCueStep(-1));
  $("#refresh-lights").addEventListener("click", () => { void loadLights().catch(handleError); });
  function syncFixtureTypeForm() {
    const isWled = $("#new-light-kind").value === "wled";
    const isDmx = $("#new-light-kind").value === "dmx";
    $("#new-wled-url-field").hidden = !isWled;
    $("#new-wled-segment-field").hidden = !isWled;
    $("#new-dmx-profile-field").hidden = !isDmx;
    $("#new-dmx-address-field").hidden = !isDmx;
    $("#new-wled-url").required = isWled;
    $("#new-dmx-profile").required = isDmx;
    $("#create-fixture-button").textContent = isWled ? "Connect WLED fixture" : isDmx ? "Patch DMX fixture" : "Create web display";
  }
  $("#new-light-kind").addEventListener("change", syncFixtureTypeForm);
  $("#toggle-dmx-patch").addEventListener("click", (event) => {
    const panel = $("#dmx-patch-panel");
    panel.hidden = !panel.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
    event.currentTarget.textContent = panel.hidden ? "Open patch table" : "Close patch table";
    if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("#dmx-patch-fixture").addEventListener("change", (event) => {
    state.dmxPatchFixtureId = event.currentTarget.value;
    const light = state.lights.find((candidate) => candidate.id === state.dmxPatchFixtureId);
    $("#dmx-patch-selection").textContent = light ? "Selected: " + light.name + " · tap or drop on a channel to set its start address." : "Select a fixture, then choose its start channel.";
    renderSetupLights();
  });
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
            : kind === "dmx"
              ? { dmx: { profileId: $("#new-dmx-profile").value, startAddress: Number($("#new-dmx-address").value) } }
            : {}),
        },
      });
      state.lights.push(result.light);
      $("#new-light-id").value = ""; $("#new-light-name").value = "";
      if (kind === "wled") $("#new-wled-url").value = "";
      if (kind === "dmx") { await loadDmxSetup(); $("#new-dmx-address").value = "1"; }
      renderFixtureGrid(); renderSetupLights();
      notify(kind === "wled" ? "WLED fixture connected." : kind === "dmx" ? "DMX fixture patched and ready for the programmer." : "Fixture created. Copy its display URL.", "success");
    } catch (error) { handleError(error); }
  });
  $("#add-dmx-channel").addEventListener("click", () => {
    if ($("#dmx-profile-channels").children.length >= 32) { notify("A profile can have at most 32 channels.", "error"); return; }
    addDmxChannelRow();
  });
  $("#cancel-dmx-profile-edit").addEventListener("click", resetDmxProfileForm);
  $("#dmx-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const profile = profileFromEditor();
      if (profile.channels.length > 32) throw new Error("A DMX profile can have at most 32 channels.");
      const editingId = state.editingDmxProfile;
      const result = await api(editingId ? "/dmx/profiles/" + encodeURIComponent(editingId) : "/dmx/profiles", {
        method: editingId ? "PATCH" : "POST",
        body: profile,
      });
      if (editingId) state.dmxProfiles = state.dmxProfiles.map((item) => item.id === editingId ? result.profile : item);
      else state.dmxProfiles.push(result.profile);
      resetDmxProfileForm();
      renderDmxSetup();
      renderSetupLights();
      notify(editingId ? "DMX profile updated." : "Custom DMX profile created.", "success");
    } catch (error) { handleError(error); }
  });
  $("#refresh-dmx-status").addEventListener("click", () => { void loadDmxSetup().catch(handleError); });
  $("#public-url-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/settings", { method: "PATCH", body: { publicBaseUrl: $("#public-base-url").value.trim() } });
      state.settings = { ...state.settings, ...result };
      $("#public-base-url").value = result.publicBaseUrl || "";
      renderSetupLights();
      renderGuestSharing();
      notify("Display address saved.", "success");
    } catch (error) { handleError(error); }
  });
  $("#use-current-url").addEventListener("click", () => { $("#public-base-url").value = window.location.origin; });
  $("#download-public-url-qr").addEventListener("click", async (event) => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      const response = await fetch(API + "/application-url/qr", { credentials: "same-origin", headers: { Accept: "image/svg+xml" }, cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new Error(body?.error?.message || "QR code generation failed.");
      }
      if (state.publicUrlQrObjectUrl) URL.revokeObjectURL(state.publicUrlQrObjectUrl);
      state.publicUrlQrObjectUrl = URL.createObjectURL(await response.blob());
      $("#public-url-qr-image").src = state.publicUrlQrObjectUrl;
      $("#public-url-qr-label").textContent = state.settings.publicBaseUrl || window.location.origin;
      $("#public-url-qr-preview").hidden = false;
      await downloadQrPng(state.publicUrlQrObjectUrl, "WebGlow-application-QR.png");
      notify("Public application QR code downloaded as a transparent PNG. Click its preview to enlarge or save it again.", "success");
    } catch (error) { handleError(error); }
    finally { control.disabled = false; }
  });
  $("#use-tunnel-hostname").addEventListener("click", () => {
    const hostname = $("#cloudflared-hostname").value.trim();
    if (hostname) $("#public-base-url").value = "https://" + hostname;
  });
  $("#cloudflared-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = $("#cloudflared-token").value.trim();
    try {
      await api("/tunnel", {
        method: "PATCH",
        body: {
          hostname: $("#cloudflared-hostname").value.trim(),
          autoStart: $("#cloudflared-auto-start").checked,
          ...(token ? { token } : {}),
        },
      });
      $("#cloudflared-token").value = "";
      await loadCloudflared();
      notify("Cloudflare Tunnel settings saved.", "success");
    } catch (error) { handleError(error); }
  });
  $("#cloudflared-clear-token").addEventListener("click", async () => {
    if (!window.confirm("Clear the saved Cloudflare Tunnel token and disconnect the tunnel?")) return;
    try {
      await api("/tunnel", { method: "PATCH", body: { clearToken: true } });
      $("#cloudflared-token").value = "";
      await loadCloudflared();
      notify("Saved tunnel token cleared.", "success");
    } catch (error) { handleError(error); }
  });
  $("#cloudflared-connect").addEventListener("click", async () => {
    try {
      await api("/tunnel/start", { method: "POST", body: {} });
      await loadCloudflared();
      notify("Cloudflare Tunnel is starting.", "success");
    } catch (error) { handleError(error); }
  });
  $("#cloudflared-disconnect").addEventListener("click", async () => {
    try {
      await api("/tunnel/stop", { method: "POST", body: {} });
      await loadCloudflared();
      notify("Cloudflare Tunnel disconnected.", "success");
    } catch (error) { handleError(error); }
  });
  $("#refresh-monitor").addEventListener("click", () => { void Promise.all([loadMetrics(), loadGuests()]).catch(handleError); });
  $("#history-retention-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/settings", { method: "PATCH", body: { historyRetention: $("#history-retention").value } });
      state.settings = { ...state.settings, ...result };
      await loadHistory();
      notify("History retention saved. Older entries were removed.", "success");
    } catch (error) { handleError(error); }
  });
  $("#guest-expiry-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/settings", {
        method: "PATCH",
        body: { guestAutoRemoveEnabled: $("#guest-auto-remove-enabled").checked, guestInactivityHours: Number($("#guest-inactivity-hours").value), guestRememberHours: Number($("#guest-remember-hours").value) },
      });
      state.settings = { ...state.settings, ...result };
      notify("Guest cleanup and device memory settings saved.", "success");
    } catch (error) { handleError(error); }
  });
  $("#media-upload-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#media-file");
    if (!input.files?.[0]) return;
    const form = new FormData();
    form.append("file", input.files[0]);
    try {
      const response = await fetch(API + "/media", { method: "POST", credentials: "same-origin", body: form, cache: "no-store" });
      const result = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(result?.error?.message || "Upload failed (" + response.status + ").");
      input.value = "";
      state.selectedMediaId = result.asset.id;
      await loadMedia();
      $("#program-media-status").textContent = "Upload complete · choose Use selected media to add it";
      await loadHistory();
      notify("Media uploaded and ready to play.", "success");
    } catch (error) { handleError(error); }
  });
  async function applyMediaAsset(clear = false) {
    const asset = state.mediaAssets.find((candidate) => candidate.id === state.selectedMediaId);
    if (!clear && !asset) { notify("Choose an item from the media library first.", "error"); return; }
    state.programmer.mediaTouched = true;
    state.programmer.mediaUrl = clear ? null : asset.url;
    state.programmer.mediaKind = clear ? null : asset.kind;
    state.programmer.mediaOpacity = Number($("#program-media-opacity").value);
    if (clear) state.selectedMediaId = null;
    syncProgrammerFromInputs();
    renderMediaLibrary();
    scheduleProgrammerApply();
    notify(clear ? "Media layer cleared from the selected programmer targets." : "Media layer added to the live programmer look.", "success");
  }
  $("#apply-media").addEventListener("click", () => { void applyMediaAsset(); });
  $("#clear-media").addEventListener("click", () => { void applyMediaAsset(true); });
  $("#guest-registration-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/settings", {
        method: "PATCH",
        body: { guestRegistrationEnabled: $("#guest-registration-enabled").checked },
      });
      state.settings = { ...state.settings, ...result };
      renderGuestSharing();
      await loadGuests();
      notify(state.settings.guestRegistrationEnabled ? "Guest registration is open." : "Guest registration is closed.", "success");
    } catch (error) { handleError(error); }
  });
  $("#copy-guest-url").addEventListener("click", async () => {
    if (!state.settings.guestRegistrationEnabled) {
      notify("Enable guest registration before sharing the join link.", "error");
      return;
    }
    await copyText(guestJoinUrl());
    notify("Guest join URL copied.", "success");
  });
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
  resetDmxProfileForm();
  renderPalettePickers(state.programmer.colors, state.programmer.colorTransitions);
  renderVisualLayers(state.programmer.layers);
  updateMultiChaseControls();
  syncFixtureTypeForm();
  registerPwa();
  bootstrap();
})();
