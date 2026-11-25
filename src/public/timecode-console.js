export function selectableAudioInputs(devices) {
  const seenDeviceIds = new Set();
  return devices.filter((device) => {
    if (device.kind !== "audioinput" || typeof device.deviceId !== "string") return false;
    const deviceId = device.deviceId.trim();
    if (!deviceId || deviceId === "default" || seenDeviceIds.has(deviceId)) return false;
    seenDeviceIds.add(deviceId);
    return true;
  });
}

export function strongestAudioChannel(channels) {
  let strongest = null;
  let strongestEnergy = -1;
  for (const channel of channels || []) {
    if (!channel?.length) continue;
    let mean = 0;
    for (let index = 0; index < channel.length; index += 1) mean += channel[index];
    mean /= channel.length;
    let energy = 0;
    for (let index = 0; index < channel.length; index += 1) {
      const centered = channel[index] - mean;
      energy += centered * centered;
    }
    if (energy > strongestEnergy) {
      strongestEnergy = energy;
      strongest = channel;
    }
  }
  return strongest;
}

function audioChannelMetrics(channel) {
  if (!channel?.length) return { peak: 0, rms: 0 };
  let mean = 0;
  for (let index = 0; index < channel.length; index += 1) mean += channel[index];
  mean /= channel.length;
  let peak = 0;
  let energy = 0;
  for (let index = 0; index < channel.length; index += 1) {
    const centered = channel[index] - mean;
    peak = Math.max(peak, Math.abs(centered));
    energy += centered * centered;
  }
  return { peak, rms: Math.sqrt(energy / channel.length) };
}

export class TimecodeConsole {
  constructor({ api, getScenes, getStacks = () => [], notify, handleError, desktopBridge = window.webglowDesktop }) {
    this.api = api;
    this.getScenes = getScenes;
    this.getStacks = getStacks;
    this.notify = notify;
    this.handleError = handleError;
    this.desktopBridge = desktopBridge;
    this.core = null;
    this.program = { frameRate: "25", sequences: [], segments: [] };
    this.activeSequenceId = null;
    this.selectedCueStackId = null;
    this.currentFrame = 0;
    this.decoder = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.silentNode = null;
    this.locked = false;
    this.lastFrameAt = 0;
    this.inputLevel = 0;
    this.playbackMode = null;
    this.lastEvaluatedFrame = null;
    this.testTimer = null;
    this.lockTimer = null;
    this.bound = false;
    this.deviceId = this.getSavedDeviceId();
    this.lastMeterPaint = 0;
    this.inputDevices = [];
    this.hiddenInputDeviceCount = 0;
    this.songPlayhead = null;
    this.songPlayheadSpan = 0;
    this.projectPlayhead = null;
    this.projectPlayheadRange = null;
    this.captureDiagnostics = { active: false, processor: "Stopped", sampleRate: null, channelCount: null, channel: null, channelLevels: [], peak: 0, rms: 0, sampleBlocks: 0, startedAt: null, inputLabel: "" };
    this.decoderDiagnostics = null;
    this.diagnosticEvents = [];
    this.lastDiagnosticsPaint = 0;
    this.lastFrameDiagnosticAt = 0;
    this.bind();
  }

  getSavedDeviceId() {
    try { return window.localStorage.getItem("webglow.timecode-device") || ""; } catch { return ""; }
  }

  async load() {
    this.core = await import("/timecode-core.js");
    const response = await this.api("/timecode/program");
    this.program = response.program;
    this.activeSequenceId = this.activeSequenceId || this.program.sequences[0]?.id || null;
    this.render();
    await this.refreshDevices();
    this.renderDiagnostics(true);
    if (this.lockTimer) window.clearInterval(this.lockTimer);
    this.lockTimer = window.setInterval(() => this.checkInputLock(), 250);
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    $("#timecode-sequence-form").addEventListener("submit", (event) => { event.preventDefault(); void this.addSequence(); });
    $("#timecode-sequence-select").addEventListener("change", (event) => { this.activeSequenceId = event.currentTarget.value || null; this.render(); });
    $("#timecode-sequence-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-sequence-id]");
      if (!button) return;
      this.activeSequenceId = button.dataset.sequenceId;
      this.render();
    });
    $("#timecode-project-sequence-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-sequence-id]");
      if (!button) return;
      $("#timecode-segment-sequence").value = button.dataset.sequenceId;
      this.renderProjectSequenceCards();
    });
    $("#timecode-sequence-delete").addEventListener("click", () => { void this.deleteSequence(); });
    $("#timecode-set-zero").addEventListener("click", () => { void this.setSequenceZero(); });
    $("#timecode-event-form").addEventListener("submit", (event) => { event.preventDefault(); void this.addCueEvent(); });
    $("#timecode-event-stack").addEventListener("change", (event) => { this.selectedCueStackId = event.currentTarget.value || null; this.renderCueOptions(); });
    $("#timecode-capture-event").addEventListener("click", () => this.captureCurrentPosition());
    $("#timecode-segment-form").addEventListener("submit", (event) => { event.preventDefault(); void this.addSegment(); });
    $("#timecode-frame-rate").addEventListener("change", () => { void this.saveFrameRate(); });
    $("#timecode-save-settings").addEventListener("click", () => { void this.saveFrameRate(); });
    $("#timecode-refresh-devices").addEventListener("click", () => { void this.refreshDevices(true).catch(this.handleError); });
    $("#timecode-audio-device").addEventListener("change", (event) => {
      this.deviceId = event.currentTarget.value;
      try { window.localStorage.setItem("webglow.timecode-device", this.deviceId); } catch {}
      if (this.mediaStream) void this.startInput().catch(this.handleError);
    });
    $("#timecode-start-input").addEventListener("click", () => { void this.startInput().catch(this.handleError); });
    $("#timecode-stop-input").addEventListener("click", () => { void this.stopInput(); });
    $("#timecode-export-diagnostics").addEventListener("click", () => this.exportDiagnostics());
    $("#timecode-arm-ltc").addEventListener("click", () => this.armLtc());
    $("#timecode-play-test").addEventListener("click", () => this.startTest());
    $("#timecode-stop").addEventListener("click", () => this.stopPlayback());
    navigator.mediaDevices?.addEventListener?.("devicechange", () => {
      const selectedBeforeRefresh = this.deviceId;
      void this.refreshDevices().then(() => {
        if (this.mediaStream && selectedBeforeRefresh && selectedBeforeRefresh !== this.deviceId) void this.startInput().catch(this.handleError);
      }).catch(this.handleError);
    });
    window.addEventListener("beforeunload", () => { void this.stopInput(); });
  }

  get sequence() {
    return this.program.sequences.find((sequence) => sequence.id === this.activeSequenceId) || null;
  }

  async persistProgram(successMessage) {
    try {
      const response = await this.api("/timecode/program", { method: "PUT", body: this.program });
      this.program = response.program;
      this.render();
      if (successMessage) this.notify(successMessage, "success");
    } catch (error) { this.handleError(error); }
  }

  async addSequence() {
    const name = $("#timecode-sequence-name").value.trim();
    if (!name) return;
    this.program.sequences.push({ id: crypto.randomUUID(), name, events: [] });
    this.activeSequenceId = this.program.sequences.at(-1).id;
    $("#timecode-sequence-name").value = "";
    await this.persistProgram("Timeline added.");
  }

  async deleteSequence() {
    const sequence = this.sequence;
    if (!sequence) return;
    if (!window.confirm(`Delete the “${sequence.name}” timeline and its show placements?`)) return;
    this.program.sequences = this.program.sequences.filter((item) => item.id !== sequence.id);
    this.program.segments = this.program.segments.filter((segment) => segment.sequenceId !== sequence.id);
    this.activeSequenceId = this.program.sequences[0]?.id || null;
    await this.persistProgram("Timeline deleted.");
  }

  async setSequenceZero() {
    if (!this.sequence) { this.notify("Create or select a song timeline first.", "error"); return; }
    if (!this.locked) { this.notify("Start the LTC monitor and wait for a valid timecode lock first.", "error"); return; }
    this.sequence.sourceStartFrame = this.currentFrame;
    await this.persistProgram("Timeline zero set to the current LTC position.");
  }

  captureCurrentPosition() {
    if (!this.locked) { this.notify("No locked LTC signal. Enter a timeline position manually or start the monitor.", "error"); return; }
    const origin = this.sequence?.sourceStartFrame;
    const frame = origin === undefined ? this.currentFrame : this.wrapFrame(this.currentFrame - origin);
    $("#timecode-event-frame").value = this.core.formatTimecode(frame, this.program.frameRate);
  }

  async addCueEvent() {
    const sequence = this.sequence;
    if (!sequence) { this.notify("Create or select a song timeline first.", "error"); return; }
    try {
      const frame = this.core.parseTimecode($("#timecode-event-frame").value, this.program.frameRate);
      const cueId = $("#timecode-event-cue").value;
      if (!cueId) throw new Error("Record a cue before placing it on a timeline.");
      sequence.events.push({ id: crypto.randomUUID(), frame, cueId });
      sequence.events.sort((left, right) => left.frame - right.frame);
      await this.persistProgram("Cue placed on the song timeline.");
    } catch (error) { this.notify(error instanceof Error ? error.message : "Invalid cue position.", "error"); }
  }

  canRecordLiveCue() {
    return Boolean(this.sequence && this.playbackMode === "ltc" && this.locked);
  }

  async recordCueAtCurrentLtc(cueId) {
    if (!this.canRecordLiveCue()) throw new Error("Arm LTC and wait for a locked signal before recording a cue to the timeline.");
    const sequence = this.sequence;
    if (!sequence) throw new Error("Select a song timeline before recording cues live.");
    if (sequence.sourceStartFrame === undefined) sequence.sourceStartFrame = this.currentFrame;
    const frame = this.wrapFrame(this.currentFrame - sequence.sourceStartFrame);
    sequence.events.push({ id: crypto.randomUUID(), frame, cueId });
    sequence.events.sort((left, right) => left.frame - right.frame);
    await this.persistProgram("Cue recorded to the song timeline at " + this.core.formatTimecode(frame, this.program.frameRate) + ".");
    return frame;
  }

  async addSegment() {
    const sequenceId = $("#timecode-segment-sequence").value;
    if (!sequenceId) { this.notify("Create a song timeline before placing it on the project.", "error"); return; }
    try {
      const startFrame = this.core.parseTimecode($("#timecode-segment-start").value, this.program.frameRate);
      this.program.segments.push({ id: crypto.randomUUID(), sequenceId, startFrame });
      this.program.segments.sort((left, right) => left.startFrame - right.startFrame);
      await this.persistProgram("Timeline placed on the show clock.");
    } catch (error) { this.notify(error instanceof Error ? error.message : "Invalid project timecode.", "error"); }
  }

  async saveFrameRate() {
    const nextRate = $("#timecode-frame-rate").value;
    if (!this.core) return;
    if (nextRate !== this.program.frameRate && (this.program.sequences.length || this.program.segments.length)) {
      if (!window.confirm("Changing frame rate keeps frame numbers as-is, so their displayed SMPTE times will change. Continue?")) {
        $("#timecode-frame-rate").value = this.program.frameRate;
        return;
      }
    }
    if (nextRate !== this.program.frameRate) this.stopPlayback();
    this.program.frameRate = nextRate;
    if (this.decoder) this.decoder.setFrameRate(nextRate);
    await this.persistProgram("Timecode frame rate saved.");
  }

  async refreshDevices(askPermission = false) {
    const select = $("#timecode-audio-device");
    const previous = this.deviceId || select.value;
    if (!navigator.mediaDevices?.enumerateDevices) {
      select.replaceChildren(option("", "Microphone selection is not available in this browser"));
      this.inputDevices = [];
      await this.updatePermissionDiagnostics();
      return;
    }
    try {
      if (askPermission) {
        if (this.desktopBridge?.requestMicrophoneAccess) {
          const granted = await this.desktopBridge.requestMicrophoneAccess();
          if (!granted) throw new Error("Microphone access was denied in macOS Privacy & Security settings.");
        }
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        probe.getTracks().forEach((track) => track.stop());
      }
      // `default` is a browser alias for the system-selected microphone, not
      // a physical input. Keep the separate Default option and list every
      // addressable audioinput, including communications aliases if present.
      const enumeratedDevices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
      this.hiddenInputDeviceCount = enumeratedDevices.filter((device) =>
        device.deviceId !== "default" && (typeof device.deviceId !== "string" || !device.deviceId.trim()),
      ).length;
      const devices = selectableAudioInputs(enumeratedDevices);
      this.inputDevices = devices;
      select.replaceChildren(option("", "Default microphone"));
      devices.forEach((device, index) => {
        // Browsers hide labels until permission is granted; ordinal labels make
        // every discovered input selectable without implying there is only one.
        const fallback = `Audio input ${index + 1}`;
        select.append(option(device.deviceId, device.label?.trim() || fallback));
      });
      select.value = devices.some((device) => device.deviceId === previous) ? previous : "";
      this.deviceId = select.value;
      await this.updatePermissionDiagnostics();
      return devices;
    } catch (error) {
      await this.updatePermissionDiagnostics(error);
      throw error;
    }
  }

  async updatePermissionDiagnostics(error) {
    const set = (id, message, tone = "") => {
      const target = $(id);
      if (!target) return;
      target.textContent = message;
      target.dataset.tone = tone;
    };
    const secure = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
    set("#permission-secure-status", secure ? "Available" : "Blocked · use HTTPS or localhost", secure ? "success" : "error");
    set("#permission-fullscreen-status", document.documentElement.requestFullscreen ? "Supported · user action required" : "Not supported by this browser", document.documentElement.requestFullscreen ? "success" : "");
    set("#permission-wake-status", "wakeLock" in navigator ? "Automatic request on displays" : "Automatic best-effort fallback on displays", "");
    set("#permission-network-status", navigator.onLine ? "Portal connected · local network/firewall may still restrict fixtures" : "Browser is offline", navigator.onLine ? "success" : "error");
    const count = this.inputDevices.length;
    const hiddenInputs = this.hiddenInputDeviceCount;
    const inputSummary = count === 0
      ? hiddenInputs > 0
        ? `${hiddenInputs} input${hiddenInputs === 1 ? "" : "s"} hidden until microphone access · refresh inputs after granting`
        : "No additional selectable inputs · Default microphone remains available"
      : count + (count === 1 ? " additional input · plus Default microphone" : " additional inputs · plus Default microphone")
        + (hiddenInputs > 0 ? ` · ${hiddenInputs} more need microphone access` : "");
    set("#permission-input-count", inputSummary);
    let microphoneState = this.mediaStream ? "Granted · LTC monitor is using the microphone" : "Not checked";
    let microphoneTone = this.mediaStream ? "success" : "";
    if (error) {
      microphoneState = "Unavailable · " + (error instanceof Error ? error.message : String(error));
      microphoneTone = "error";
    } else if (!this.mediaStream) {
      try {
        if (this.desktopBridge?.getMicrophoneAccessStatus) {
          const desktopState = await this.desktopBridge.getMicrophoneAccessStatus();
          if (desktopState === "denied" || desktopState === "restricted") {
            microphoneState = desktopState === "restricted" ? "Restricted by macOS" : "Denied by macOS";
            microphoneTone = "error";
          } else if (desktopState === "granted") {
            microphoneState = "Granted by macOS · start LTC monitor to enumerate inputs";
            microphoneTone = "success";
          } else if (desktopState === "not-determined") {
            microphoneState = "Permission not requested yet";
          }
        } else if (navigator.permissions?.query) {
          const result = await navigator.permissions.query({ name: "microphone" });
          microphoneState = result.state === "granted" ? "Granted by browser" : result.state === "denied" ? "Denied by browser" : "Permission not requested yet";
          microphoneTone = result.state === "granted" ? "success" : result.state === "denied" ? "error" : "";
        }
      } catch {
        // Some browsers intentionally do not expose microphone permission state.
      }
    }
    set("#permission-microphone-status", microphoneState, microphoneTone);
  }

  recordDiagnostic(message, details = {}) {
    this.diagnosticEvents.push({ at: new Date().toISOString(), message, ...details });
    if (this.diagnosticEvents.length > 250) this.diagnosticEvents.shift();
    this.renderDiagnosticEvents();
  }

  recordCapturedSamples(metadata = {}) {
    const levels = Array.isArray(metadata.channelLevels) ? metadata.channelLevels : [];
    const selectedLevel = levels.find((level) => level.channel === metadata.channelIndex) || {};
    this.captureDiagnostics.sampleBlocks += 1;
    this.captureDiagnostics.channelCount = Number(metadata.channelCount) || this.captureDiagnostics.channelCount;
    this.captureDiagnostics.channel = Number(metadata.channelIndex) > 0 ? Number(metadata.channelIndex) : this.captureDiagnostics.channel;
    if (levels.length) this.captureDiagnostics.channelLevels = levels.map((level) => ({ channel: level.channel, rms: level.rms, peak: level.peak }));
    this.captureDiagnostics.peak = Number.isFinite(selectedLevel.peak) ? selectedLevel.peak : this.captureDiagnostics.peak;
    this.captureDiagnostics.rms = Number.isFinite(selectedLevel.rms) ? selectedLevel.rms : this.captureDiagnostics.rms;
    const decoder = this.decoder?.getDiagnostics?.();
    if (decoder) this.decoderDiagnostics = decoder;
    this.renderDiagnostics();
  }

  receiveDecoderDiagnostics(diagnostics) {
    this.decoderDiagnostics = diagnostics;
    this.renderDiagnostics();
  }

  diagnosticSummary() {
    const capture = this.captureDiagnostics;
    const decoder = this.decoderDiagnostics;
    if (!capture.active) return "Start the monitor to capture diagnostic data.";
    if (!decoder || decoder.samples === 0) return "Audio capture is open, but no sample buffers have reached the decoder yet.";
    const elapsedMs = capture.startedAt ? Date.now() - Date.parse(capture.startedAt) : 0;
    if (decoder.peak < 0.008) return "Samples are arriving, but the signal is below the LTC decoder's minimum level.";
    if (decoder.zeroCrossings < 8 && elapsedMs > 1_000) return "Signal level is present, but the waveform is not producing enough polarity transitions for LTC.";
    if (decoder.intervals > 20 && decoder.invalidIntervals / decoder.intervals > 0.2) return "Transitions are present, but their timing does not fit the selected frame rate. Check the LTC frame-rate setting.";
    if (!decoder.syncMatches && elapsedMs > 1_000) return "Biphase transitions are being decoded, but no SMPTE frame sync word is found. Confirm this is forward LTC and select its exact frame rate.";
    if (decoder.syncMatches && !decoder.decodedFrames) return "SMPTE sync was found, but the time address is invalid for the selected frame rate.";
    if (decoder.decodedFrames && this.locked) return `LTC locked · latest frame ${decoder.lastTimecode || "—"}.`;
    if (decoder.decodedFrames) return `Frames were decoded earlier, but no new frame has arrived recently. Last frame: ${decoder.lastTimecode || "—"}.`;
    return "Signal received · waiting for a complete LTC frame.";
  }

  renderDiagnostics(force = false) {
    const now = performance.now();
    if (!force && now - this.lastDiagnosticsPaint < 200) return;
    this.lastDiagnosticsPaint = now;
    const capture = this.captureDiagnostics;
    const decoder = this.decoderDiagnostics || this.decoder?.getDiagnostics?.();
    const set = (selector, value) => {
      const target = $(selector);
      if (target) target.textContent = value;
    };
    const sampleRate = capture.sampleRate ? `${Math.round(capture.sampleRate).toLocaleString()} Hz` : "—";
    const channels = capture.channelCount ? `${capture.channelCount} ch` : "—";
    const channel = capture.channel ? ` · using ch ${capture.channel}` : "";
    set("#timecode-diag-capture", `${capture.processor} · ${sampleRate} · ${channels}${channel}`);
    const channelLevels = capture.channelLevels.map((level) => `ch${level.channel} ${(level.rms * 100).toFixed(1)}% RMS`).join(" · ");
    set("#timecode-diag-signal", `Peak ${capture.peak.toFixed(3)} · RMS ${capture.rms.toFixed(3)}${channelLevels ? ` · ${channelLevels}` : ""} · ${capture.sampleBlocks.toLocaleString()} blocks`);
    set("#timecode-diag-decoder", decoder
      ? `${decoder.zeroCrossings.toLocaleString()} transitions · ${decoder.intervals.toLocaleString()} intervals (${decoder.invalidIntervals.toLocaleString()} off-timing) · ${decoder.syncMatches.toLocaleString()} syncs · ${decoder.decodedFrames.toLocaleString()} frames`
      : "No decoder data yet.");
    set("#timecode-diag-last-frame", decoder?.lastTimecode
      ? `${decoder.lastTimecode} · ${decoder.lastFrameAt ? new Date(decoder.lastFrameAt).toLocaleTimeString() : ""}`
      : "No valid frame decoded yet.");
    set("#timecode-diagnostics-status", this.diagnosticSummary());
    const detail = $("#timecode-input-detail");
    if (detail) detail.textContent = this.captureDiagnostics.active ? this.diagnosticSummary() : "Choose an input, then start the monitor.";
  }

  renderDiagnosticEvents() {
    const list = $("#timecode-diagnostics-events");
    if (!list) return;
    const recent = this.diagnosticEvents.slice(-8).reverse();
    list.replaceChildren(...recent.map((entry) => {
      const item = document.createElement("li");
      const when = new Date(entry.at).toLocaleTimeString();
      const details = Object.entries(entry).filter(([key]) => key !== "at" && key !== "message")
        .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ");
      item.textContent = `${when} · ${entry.message}${details ? ` · ${details}` : ""}`;
      return item;
    }));
  }

  exportDiagnostics() {
    this.recordDiagnostic("Diagnostics exported");
    const report = {
      application: "WebGlow",
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      frameRate: this.program.frameRate,
      selectedInput: this.captureDiagnostics.inputLabel,
      capture: { ...this.captureDiagnostics },
      decoder: this.decoder?.getDiagnostics?.() || this.decoderDiagnostics,
      events: this.diagnosticEvents,
      note: "This report contains audio levels and decoder counters only; it does not contain or record microphone audio.",
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `WebGlow-LTC-diagnostics-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async startInput() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture requires a secure browser context or the WebGlow macOS app.");
    await this.stopInput();
    this.diagnosticEvents = [];
    this.captureDiagnostics = {
      active: false,
      processor: "Opening input",
      sampleRate: null,
      channelCount: null,
      channel: null,
      channelLevels: [],
      peak: 0,
      rms: 0,
      sampleBlocks: 0,
      startedAt: new Date().toISOString(),
      inputLabel: $("#timecode-audio-device").selectedOptions[0]?.textContent || "Default microphone",
    };
    this.decoderDiagnostics = null;
    this.recordDiagnostic("Opening LTC input", { frameRate: this.program.frameRate, input: this.captureDiagnostics.inputLabel });
    this.renderDiagnostics(true);
    if (this.desktopBridge?.requestMicrophoneAccess) {
      const granted = await this.desktopBridge.requestMicrophoneAccess();
      if (!granted) {
        const error = new Error("Microphone access was denied in macOS Privacy & Security settings.");
        this.recordDiagnostic("Microphone permission denied", { message: error.message });
        await this.updatePermissionDiagnostics(error);
        throw error;
      }
    }
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
    };
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (error) {
      this.recordDiagnostic("Microphone capture failed", {
        name: error instanceof Error && "name" in error ? error.name : "CaptureError",
        message: error instanceof Error ? error.message : String(error),
      });
      if (!this.deviceId) {
        await this.updatePermissionDiagnostics(error);
        throw error;
      }
      const failedDeviceId = this.deviceId;
      let currentDevices = this.inputDevices;
      try { currentDevices = await this.refreshDevices(true); } catch {}
      if (currentDevices.some((device) => device.deviceId === failedDeviceId)) {
        this.deviceId = failedDeviceId;
        $("#timecode-audio-device").value = failedDeviceId;
        try { window.localStorage.setItem("webglow.timecode-device", failedDeviceId); } catch {}
        const errorName = error instanceof Error && "name" in error ? error.name : "CaptureError";
        const errorMessage = error instanceof Error ? error.message : String(error);
        const selectedLabel = currentDevices.find((device) => device.deviceId === failedDeviceId)?.label || "selected input";
        const selectedError = new Error(`Could not open ${selectedLabel} (${errorName}): ${errorMessage}`);
        await this.updatePermissionDiagnostics(selectedError);
        throw selectedError;
      }
      this.deviceId = "";
      try { window.localStorage.removeItem("webglow.timecode-device"); } catch {}
      $("#timecode-audio-device").value = "";
      this.notify("The selected microphone is no longer available; using the default input.", "error");
      const { deviceId: _staleDeviceId, ...defaultAudio } = audio;
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: defaultAudio, video: false });
      } catch (fallbackError) {
        await this.updatePermissionDiagnostics(fallbackError);
        throw fallbackError;
      }
    }
    // Enumerate again after permission is granted: this is when browsers expose
    // the complete input list and human-readable labels.
    await this.refreshDevices();
    const track = this.mediaStream.getAudioTracks()[0];
    const trackSettings = track?.getSettings?.() || {};
    this.captureDiagnostics.inputLabel = track?.label || this.captureDiagnostics.inputLabel;
    this.captureDiagnostics.channelCount = trackSettings.channelCount || null;
    if (!this.deviceId && track?.getSettings().deviceId) {
      this.deviceId = track.getSettings().deviceId;
      try { window.localStorage.setItem("webglow.timecode-device", this.deviceId); } catch {}
    }
    this.audioContext = new AudioContext({ latencyHint: "interactive" });
    await this.audioContext.resume();
    this.captureDiagnostics.sampleRate = this.audioContext.sampleRate;
    this.decoder = new this.core.LtcDecoder(
      this.program.frameRate,
      (frame) => this.receiveLtcFrame(frame),
      (level) => this.receiveLevel(level),
      (diagnostics) => this.receiveDecoderDiagnostics(diagnostics),
    );
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.silentNode = this.audioContext.createGain();
    this.silentNode.gain.value = 0;
    let workletReady = false;
    if (this.audioContext.audioWorklet && window.AudioWorkletNode) {
      try {
        const processorUrl = new URL("/timecode-processor.js?v=6", window.location.href);
        const response = await fetch(processorUrl, { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") || "";
        if (contentType && !/javascript|ecmascript/i.test(contentType)) {
          throw new Error(`unexpected content type ${contentType}`);
        }
        await this.audioContext.audioWorklet.addModule(processorUrl.href);
        this.processorNode = new AudioWorkletNode(this.audioContext, "webglow-ltc-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCountMode: "max",
          channelInterpretation: "discrete",
        });
        this.processorNode.port.onmessage = (event) => {
          const message = event.data;
          if (message?.samples) {
            this.recordCapturedSamples(message);
            this.decoder?.pushSamples(message.samples, this.audioContext?.sampleRate);
          } else if (message instanceof Float32Array) {
            // Compatibility with a worklet loaded from an older PWA cache.
            this.recordCapturedSamples({ channelIndex: 1, channelCount: 1 });
            this.decoder?.pushSamples(message, this.audioContext?.sampleRate);
          }
        };
        workletReady = true;
      } catch (error) {
        // AudioWorklet is preferred, but a module URL/MIME or browser issue must
        // not make LTC monitoring unusable. ScriptProcessor is deprecated but
        // remains a practical compatibility fallback for this low-bandwidth
        // mono signal path.
        console.warn("WebGlow LTC AudioWorklet unavailable; using compatibility audio processor.", error);
        this.recordDiagnostic("AudioWorklet failed; using compatibility processor", {
          name: error instanceof Error && "name" in error ? error.name : "WorkletError",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!workletReady) {
      const reportedChannels = track?.getSettings().channelCount || 2;
      const processor = this.audioContext.createScriptProcessor(1024, Math.max(1, Math.min(32, reportedChannels)), 1);
      processor.onaudioprocess = (event) => {
        const channels = Array.from({ length: event.inputBuffer.numberOfChannels }, (_, index) => event.inputBuffer.getChannelData(index));
        const selectedChannel = strongestAudioChannel(channels);
        if (selectedChannel) {
          const channelIndex = channels.indexOf(selectedChannel);
          const channelLevels = channels.map((channel, index) => ({ channel: index + 1, ...audioChannelMetrics(channel) }));
          this.recordCapturedSamples({
            channelIndex: channelIndex + 1,
            channelCount: channels.length,
            channelLevels,
          });
          this.decoder?.pushSamples(selectedChannel, this.audioContext?.sampleRate);
        }
        event.outputBuffer.getChannelData(0).fill(0);
      };
      this.processorNode = processor;
    }
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silentNode);
    this.silentNode.connect(this.audioContext.destination);
    this.captureDiagnostics.active = true;
    this.captureDiagnostics.processor = workletReady ? "AudioWorklet" : "ScriptProcessor";
    this.recordDiagnostic("LTC monitor started", {
      processor: this.captureDiagnostics.processor,
      sampleRate: this.captureDiagnostics.sampleRate,
      channels: this.captureDiagnostics.channelCount,
      input: this.captureDiagnostics.inputLabel,
    });
    $("#timecode-start-input").disabled = true;
    $("#timecode-stop-input").disabled = false;
    this.updateDisplays();
    this.renderDiagnostics(true);
  }

  async stopInput() {
    const wasActive = Boolean(this.mediaStream);
    if (this.decoder) this.decoderDiagnostics = this.decoder.getDiagnostics();
    if (this.sourceNode) this.sourceNode.disconnect();
    if (this.processorNode) {
      this.processorNode.disconnect();
      if ("onaudioprocess" in this.processorNode) this.processorNode.onaudioprocess = null;
      if ("port" in this.processorNode) this.processorNode.port.onmessage = null;
    }
    if (this.silentNode) this.silentNode.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    if (this.audioContext && this.audioContext.state !== "closed") await this.audioContext.close().catch(() => undefined);
    this.sourceNode = null;
    this.processorNode = null;
    this.silentNode = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.decoder = null;
    this.captureDiagnostics.active = false;
    this.captureDiagnostics.processor = "Stopped";
    this.locked = false;
    this.inputLevel = 0;
    if (this.playbackMode === "ltc") this.stopPlayback();
    $("#timecode-start-input").disabled = false;
    $("#timecode-stop-input").disabled = true;
    $("#timecode-input-level").value = 0;
    $("#timecode-input-detail").textContent = "Choose an input, then start the monitor.";
    await this.updatePermissionDiagnostics();
    this.updateDisplays();
    if (wasActive) this.recordDiagnostic("LTC monitor stopped");
    this.renderDiagnostics(true);
  }

  receiveLevel(level) {
    const now = performance.now();
    this.inputLevel = Math.min(1, Math.max(level.rms * 2.6, level.peak * 0.9));
    this.captureDiagnostics.peak = level.peak;
    this.captureDiagnostics.rms = level.rms;
    if (now - this.lastMeterPaint < 40) return;
    this.lastMeterPaint = now;
    $("#timecode-input-level").value = this.inputLevel;
    this.renderDiagnostics();
  }

  receiveLtcFrame(frame) {
    const wasLocked = this.locked;
    this.lastFrameAt = performance.now();
    this.locked = true;
    this.currentFrame = frame.frames;
    if (!wasLocked || this.lastFrameAt - this.lastFrameDiagnosticAt > 5_000) {
      this.recordDiagnostic(wasLocked ? "LTC frame stream active" : "LTC lock acquired", { timecode: frame.timecode });
      this.lastFrameDiagnosticAt = this.lastFrameAt;
    }
    this.updateDisplays();
    if (this.playbackMode === "ltc") this.advanceShow(frame.frames, "LTC");
  }

  checkInputLock() {
    if (this.locked && performance.now() - this.lastFrameAt > 1_200) {
      this.locked = false;
      this.lastEvaluatedFrame = null;
      this.updateDisplays();
      this.renderDiagnostics(true);
    }
  }

  armLtc() {
    if (this.playbackMode === "ltc") {
      this.stopPlayback();
      return;
    }
    if (!this.mediaStream) {
      this.notify("Start the LTC monitor first. It can be armed while waiting for signal lock.", "error");
      return;
    }
    this.stopTestTimer();
    this.playbackMode = "ltc";
    this.lastEvaluatedFrame = null;
    this.updateDisplays();
  }

  startTest() {
    try {
      const start = this.core.parseTimecode($("#timecode-test-start").value, this.program.frameRate);
      this.stopTestTimer();
      this.playbackMode = "test";
      const dayFrames = this.core.framesPerDay(this.program.frameRate);
      this.lastEvaluatedFrame = (start - 1 + dayFrames) % dayFrames;
      this.currentFrame = start;
      const startedAt = performance.now();
      const fps = this.core.getRateInfo(this.program.frameRate).actual;
      this.advanceShow(start, "Test");
      this.testTimer = window.setInterval(() => {
        const next = (start + Math.floor(((performance.now() - startedAt) / 1000) * fps)) % dayFrames;
        if (next !== this.currentFrame) this.advanceShow(next, "Test");
      }, Math.max(12, Math.floor(1000 / fps / 2)));
      this.updateDisplays();
    } catch (error) { this.notify(error instanceof Error ? error.message : "Invalid test start timecode.", "error"); }
  }

  stopTestTimer() {
    if (this.testTimer) window.clearInterval(this.testTimer);
    this.testTimer = null;
  }

  stopPlayback() {
    this.stopTestTimer();
    this.playbackMode = null;
    this.lastEvaluatedFrame = null;
    this.updateDisplays();
  }

  advanceShow(frame, source) {
    const dayFrames = this.core.framesPerDay(this.program.frameRate);
    const current = ((Math.trunc(frame) % dayFrames) + dayFrames) % dayFrames;
    const previous = this.lastEvaluatedFrame;
    this.currentFrame = current;
    this.updateClocks();
    if (previous === null) {
      this.lastEvaluatedFrame = (current - 1 + dayFrames) % dayFrames;
    }
    const last = this.lastEvaluatedFrame;
    const elapsed = (current - last + dayFrames) % dayFrames;
    this.lastEvaluatedFrame = current;
    if (!elapsed || elapsed > this.core.getRateInfo(this.program.frameRate).nominal * 10) return;
    const due = this.scheduledEvents().map((event) => ({
      ...event,
      distance: (event.frame - last + dayFrames) % dayFrames,
    })).filter((event) => event.distance > 0 && event.distance <= elapsed).sort((left, right) => left.distance - right.distance);
    due.forEach((event) => {
      void this.api("/scenes/" + encodeURIComponent(event.cueId) + "/go", { method: "POST" })
        .then(() => this.notify(`Timecode ${source}: ran cue ${event.cueId} · ${event.sequenceName}.`, "success"))
        .catch(this.handleError);
    });
  }

  wrapFrame(frame) {
    const dayFrames = this.core.framesPerDay(this.program.frameRate);
    return ((Math.trunc(frame) % dayFrames) + dayFrames) % dayFrames;
  }

  scheduledEvents() {
    const sequences = new Map(this.program.sequences.map((sequence) => [sequence.id, sequence]));
    const dayFrames = this.core.framesPerDay(this.program.frameRate);
    return this.program.segments.flatMap((segment) => {
      const sequence = sequences.get(segment.sequenceId);
      if (!sequence) return [];
      return sequence.events.map((event) => ({
        id: segment.id + ":" + event.id,
        cueId: event.cueId,
        sequenceName: sequence.name,
        frame: (segment.startFrame + event.frame) % dayFrames,
      }));
    }).sort((left, right) => left.frame - right.frame);
  }

  refreshCueOptions() {
    this.renderCueOptions();
    this.renderSequenceEvents();
    this.renderProjectTimeline();
  }

  render() {
    $("#timecode-frame-rate").value = this.program.frameRate;
    this.renderSequenceOptions();
    this.renderCueOptions();
    this.renderSequenceEvents();
    this.renderProjectTimeline();
    this.updateDisplays();
  }

  renderSequenceOptions() {
    const editor = $("#timecode-sequence-select");
    const project = $("#timecode-segment-sequence");
    const activeId = this.sequence?.id || this.activeSequenceId;
    editor.replaceChildren(...this.program.sequences.map((sequence) => option(sequence.id, sequence.name)));
    project.replaceChildren(...this.program.sequences.map((sequence) => option(sequence.id, sequence.name)));
    if (this.program.sequences.length) {
      editor.value = this.program.sequences.some((sequence) => sequence.id === activeId) ? activeId : this.program.sequences[0].id;
      if (!this.activeSequenceId || !this.program.sequences.some((sequence) => sequence.id === this.activeSequenceId)) this.activeSequenceId = editor.value;
      project.value = this.program.sequences.some((sequence) => sequence.id === activeId) ? activeId : this.program.sequences[0].id;
    }
    editor.disabled = !this.program.sequences.length;
    project.disabled = !this.program.sequences.length;
    const list = $("#timecode-sequence-list");
    list.replaceChildren();
    this.program.sequences.forEach((sequence) => {
      const card = button("", "timecode-sequence-card" + (sequence.id === activeId ? " selected" : ""));
      card.dataset.sequenceId = sequence.id;
      card.setAttribute("aria-pressed", String(sequence.id === activeId));
      const cueCount = sequence.events.length;
      card.append(element("strong", "", sequence.name), element("span", "", cueCount + (cueCount === 1 ? " cue" : " cues")));
      list.append(card);
    });
    $("#timecode-active-sequence").textContent = this.sequence ? "Editing · " + this.sequence.name : "Select a song timeline";
    $("#timecode-sequence-delete").disabled = !this.sequence;
    $("#timecode-set-zero").disabled = !this.sequence;
    this.renderProjectSequenceCards();
  }

  renderProjectSequenceCards() {
    const root = $("#timecode-project-sequence-list");
    const selectedId = $("#timecode-segment-sequence").value;
    root.replaceChildren();
    this.program.sequences.forEach((sequence) => {
      const placements = this.program.segments.filter((segment) => segment.sequenceId === sequence.id).length;
      const card = button("", "timecode-sequence-card" + (sequence.id === selectedId ? " selected" : ""));
      card.dataset.sequenceId = sequence.id;
      card.setAttribute("aria-pressed", String(sequence.id === selectedId));
      card.append(element("strong", "", sequence.name), element("span", "", placements + (placements === 1 ? " show placement" : " show placements")));
      root.append(card);
    });
  }

  renderCueOptions() {
    const stacks = this.getStacks();
    const stackSelect = $("#timecode-event-stack");
    const priorStackId = this.selectedCueStackId || stackSelect.value;
    stackSelect.replaceChildren(...stacks.map((stack) => option(stack.id, stack.name)));
    this.selectedCueStackId = stacks.some((stack) => stack.id === priorStackId) ? priorStackId : stacks[0]?.id || null;
    stackSelect.value = this.selectedCueStackId || "";
    stackSelect.disabled = stacks.length === 0;
    const cues = this.getScenes().filter((scene) => scene.stackId === this.selectedCueStackId);
    const select = $("#timecode-event-cue");
    const previous = select.value;
    select.replaceChildren(...cues.map((scene) => option(scene.id, `${scene.id} · ${scene.name}`)));
    if (cues.some((scene) => scene.id === previous)) select.value = previous;
    select.disabled = cues.length === 0;
  }

  renderSequenceEvents() {
    const root = $("#timecode-sequence-events");
    const timeline = $("#timecode-song-timeline");
    root.replaceChildren();
    timeline.replaceChildren();
    this.songPlayhead = null;
    this.songPlayheadSpan = 0;
    const sequence = this.sequence;
    $("#timecode-sequence-origin").textContent = sequence?.sourceStartFrame === undefined
      ? "LTC zero not set · capture uses the clock as-is"
      : "Song zero: " + this.core.formatTimecode(sequence.sourceStartFrame, this.program.frameRate);
    if (!sequence?.events.length) {
      const empty = element("p", "console-empty", sequence ? "Place cues at SMPTE positions to build this song timeline." : "Add a song timeline to start cue mapping.");
      root.append(empty);
      timeline.append(element("p", "console-empty", sequence ? "Your cue events will appear here from left to right." : "Select or add a song timeline first."));
      return;
    }
    const cueList = this.getScenes();
    const cues = new Map(cueList.map((scene) => [scene.id, scene]));
    const stacks = this.getStacks();
    const fps = this.core.getRateInfo(this.program.frameRate).nominal;
    const maximum = Math.max(fps * 10, ...sequence.events.map((event) => event.frame + fps * 3));
    const trackScroll = element("div", "timecode-track-scroll");
    const canvas = element("div", "timecode-track-canvas");
    canvas.style.width = "100%";
    canvas.style.minWidth = "max(720px, 100%)";
    const range = element("div", "timecode-timeline-range");
    range.append(element("span", "", this.core.formatTimecode(0, this.program.frameRate)), element("span", "", this.core.formatTimecode(maximum, this.program.frameRate)));
    const lane = element("div", "timecode-song-lane");
    this.songPlayhead = element("div", "timecode-playhead");
    this.songPlayhead.setAttribute("aria-hidden", "true");
    this.songPlayheadSpan = maximum;
    const visualLanes = [];
    [...sequence.events].sort((a, b) => a.frame - b.frame).forEach((event) => {
      let laneIndex = visualLanes.findIndex((lastFrame) => lastFrame < event.frame - Math.ceil(fps * 0.8));
      if (laneIndex === -1) { laneIndex = visualLanes.length; visualLanes.push(-Infinity); }
      visualLanes[laneIndex] = event.frame;
      const marker = button(cues.get(event.cueId)?.id || "?", "timecode-cue-marker");
      marker.style.left = `${Math.max(0, Math.min(100, (event.frame / maximum) * 100))}%`;
      marker.style.top = `${laneIndex * 1.75}rem`;
      marker.title = `${this.core.formatTimecode(event.frame, this.program.frameRate)} · ${cues.get(event.cueId)?.name || "Missing cue"} · drag to move`;
      this.bindFrameDrag(marker, lane, event.frame, maximum, (frame) => { event.frame = frame; });
      lane.append(marker);
    });
    lane.style.height = `${Math.max(2.8, visualLanes.length * 1.75 + 1)}rem`;
    canvas.append(range, lane, this.songPlayhead);
    trackScroll.append(canvas);
    timeline.append(trackScroll);
    sequence.events.forEach((event) => {
      const row = element("article", "timecode-event-row");
      const position = element("input");
      position.value = this.core.formatTimecode(event.frame, this.program.frameRate);
      position.setAttribute("aria-label", "Cue timecode");
      position.addEventListener("change", () => {
        try {
          event.frame = this.core.parseTimecode(position.value, this.program.frameRate);
          sequence.events.sort((left, right) => left.frame - right.frame);
          void this.persistProgram("Cue time updated.");
        } catch (error) { this.notify(error instanceof Error ? error.message : "Invalid cue position.", "error"); }
      });
      const eventCue = cues.get(event.cueId);
      const eventStackSelect = document.createElement("select");
      eventStackSelect.setAttribute("aria-label", "Cue stack for timeline event");
      eventStackSelect.replaceChildren(...stacks.map((stack) => option(stack.id, stack.name)));
      const originalStackId = eventCue?.stackId || stacks[0]?.id || "";
      eventStackSelect.value = originalStackId;
      const cueSelect = document.createElement("select");
      cueSelect.setAttribute("aria-label", "Recorded cue for timeline event");
      const updateEventCueOptions = (preferredCueId) => {
        const stackCues = cueList.filter((scene) => scene.stackId === eventStackSelect.value);
        cueSelect.replaceChildren(...stackCues.map((scene) => option(scene.id, `${scene.id} · ${scene.name}`)));
        if (stackCues.some((scene) => scene.id === preferredCueId)) cueSelect.value = preferredCueId;
        else if (stackCues[0]) cueSelect.value = stackCues[0].id;
        cueSelect.disabled = stackCues.length === 0;
      };
      updateEventCueOptions(event.cueId);
      eventStackSelect.addEventListener("change", () => {
        updateEventCueOptions("");
        if (!cueSelect.value) { eventStackSelect.value = originalStackId; this.notify("That cue stack has no cues yet.", "error"); return; }
        event.cueId = cueSelect.value;
        void this.persistProgram("Timeline event moved to another cue stack.");
      });
      cueSelect.value = event.cueId;
      cueSelect.addEventListener("change", () => {
        event.cueId = cueSelect.value;
        void this.persistProgram("Recorded cue updated.");
      });
      const remove = button("Remove", "console-button danger-button");
      remove.addEventListener("click", () => {
        sequence.events = sequence.events.filter((item) => item.id !== event.id);
        void this.persistProgram("Cue removed from timeline.");
      });
      row.append(position, eventStackSelect, cueSelect, remove);
      root.append(row);
    });
    this.updatePlayheads();
  }

  bindFrameDrag(handle, track, initialFrame, span, setFrame) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType !== "touch") return;
      event.preventDefault();
      const startX = event.clientX;
      const startFrame = initialFrame;
      const bounds = track.getBoundingClientRect();
      handle.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        const delta = ((moveEvent.clientX - startX) / Math.max(bounds.width, 1)) * span;
        const frame = Math.max(0, Math.round(startFrame + delta));
        setFrame(frame);
        handle.style.left = `${Math.max(0, Math.min(100, (frame / span) * 100))}%`;
      };
      const finish = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        this.program.sequences.forEach((sequence) => sequence.events.sort((left, right) => left.frame - right.frame));
        this.program.segments.sort((left, right) => left.startFrame - right.startFrame);
        void this.persistProgram("Timeline position updated.");
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish, { once: true });
      handle.addEventListener("pointercancel", finish, { once: true });
    });
  }

  renderProjectTimeline() {
    const root = $("#timecode-project-timeline");
    const segmentList = $("#timecode-project-segments");
    root.replaceChildren();
    segmentList.replaceChildren();
    this.projectPlayhead = null;
    this.projectPlayheadRange = null;
    if (!this.program.segments.length) {
      root.append(element("p", "console-empty", "Add a song timeline and place it on the show clock."));
      return;
    }
    const sequences = new Map(this.program.sequences.map((sequence) => [sequence.id, sequence]));
    const fps = this.core.getRateInfo(this.program.frameRate).nominal;
    const plotted = this.program.segments.map((segment) => {
      const sequence = sequences.get(segment.sequenceId);
      const contentEnd = Math.max(fps * 5, ...(sequence?.events || []).map((event) => event.frame + fps * 2));
      return { segment, sequence, end: segment.startFrame + contentEnd };
    }).filter((entry) => entry.sequence);
    if (!plotted.length) {
      root.append(element("p", "console-empty", "Add a song timeline and place it on the show clock."));
      return;
    }
    const minimum = Math.min(0, ...plotted.map((entry) => entry.segment.startFrame));
    const maximum = Math.max(...plotted.map((entry) => entry.end));
    const span = Math.max(1, maximum - minimum);
    const range = element("div", "timecode-timeline-range");
    range.append(element("span", "", this.core.formatTimecode(minimum, this.program.frameRate)), element("span", "", this.core.formatTimecode(maximum, this.program.frameRate)));
    const lanes = [];
    plotted.sort((left, right) => left.segment.startFrame - right.segment.startFrame).forEach((entry) => {
      let laneIndex = lanes.findIndex((lane) => lane.end <= entry.segment.startFrame);
      if (laneIndex === -1) { laneIndex = lanes.length; lanes.push({ end: -Infinity, entries: [] }); }
      lanes[laneIndex].end = entry.end;
      lanes[laneIndex].entries.push(entry);
      entry.laneIndex = laneIndex;
    });
    const canvas = element("div", "timecode-track-canvas timecode-project-canvas");
    canvas.style.width = "100%";
    canvas.style.minWidth = "max(720px, 100%)";
    lanes.forEach((layer, laneIndex) => {
      const lane = element("div", "timecode-project-lane");
      lane.style.top = `${laneIndex * 2.65}rem`;
      layer.entries.forEach(({ segment, sequence, end }) => {
        const block = button(sequence.name, "timecode-timeline-segment");
        block.style.left = `${((segment.startFrame - minimum) / span) * 100}%`;
        block.style.width = `${Math.max(4, ((end - segment.startFrame) / span) * 100)}%`;
        block.title = `${sequence.name} · drag to move on the show clock`;
        this.bindFrameDrag(block, lane, segment.startFrame - minimum, span, (frame) => { segment.startFrame = frame + minimum; });
        lane.append(block);
        sequence.events.forEach((event) => {
          const marker = element("i", "timecode-timeline-marker");
          marker.style.left = `${((segment.startFrame + event.frame - minimum) / span) * 100}%`;
          marker.title = `${this.core.formatTimecode(segment.startFrame + event.frame, this.program.frameRate)} · Cue ${event.cueId}`;
          lane.append(marker);
        });
      });
      canvas.append(lane);
    });
    canvas.style.height = `${Math.max(3, lanes.length * 2.65)}rem`;
    this.projectPlayhead = element("div", "timecode-playhead project-playhead");
    this.projectPlayhead.setAttribute("aria-hidden", "true");
    this.projectPlayheadRange = { minimum, span };
    canvas.append(this.projectPlayhead);
    const scroll = element("div", "timecode-track-scroll");
    scroll.append(canvas);
    root.append(range, scroll);
    plotted.forEach(({ segment, sequence }) => {
      const row = element("article", "timecode-event-row");
      const position = element("input");
      position.value = this.core.formatTimecode(segment.startFrame, this.program.frameRate);
      position.setAttribute("aria-label", "Show timeline start timecode");
      position.addEventListener("change", () => {
        try {
          segment.startFrame = this.core.parseTimecode(position.value, this.program.frameRate);
          this.program.segments.sort((left, right) => left.startFrame - right.startFrame);
          void this.persistProgram("Show timeline placement updated.");
        } catch (error) { this.notify(error instanceof Error ? error.message : "Invalid show placement.", "error"); }
      });
      const sequenceSelect = document.createElement("select");
      sequenceSelect.setAttribute("aria-label", "Song timeline in project");
      sequenceSelect.replaceChildren(...this.program.sequences.map((item) => option(item.id, item.name)));
      sequenceSelect.value = sequence.id;
      sequenceSelect.addEventListener("change", () => {
        segment.sequenceId = sequenceSelect.value;
        void this.persistProgram("Placed song timeline updated.");
      });
      const remove = button("Remove", "console-button danger-button");
      remove.addEventListener("click", () => {
        this.program.segments = this.program.segments.filter((item) => item.id !== segment.id);
        void this.persistProgram("Timeline placement removed.");
      });
      row.append(position, sequenceSelect, remove);
      segmentList.append(row);
    });
    this.updatePlayheads();
  }

  updateClocks() {
    if (!this.core) return;
    const value = this.core.formatTimecode(this.currentFrame, this.program.frameRate);
    $("#timecode-control-clock").textContent = value;
    $("#timecode-settings-clock").textContent = value;
    this.updatePlayheads();
  }

  updatePlayheads() {
    if (!this.core) return;
    const show = this.playbackMode === "test" || this.playbackMode === "ltc" || this.locked;
    const position = (playhead, frame, span) => {
      if (!playhead) return;
      const visible = show && span > 0 && frame >= 0 && frame <= span;
      playhead.hidden = !visible;
      if (!visible) return;
      playhead.style.left = `${Math.max(0, Math.min(100, (frame / span) * 100))}%`;
      playhead.dataset.timecode = this.core.formatTimecode(frame, this.program.frameRate);
      playhead.title = "Playhead · " + playhead.dataset.timecode;
    };
    const sequence = this.sequence;
    const relativeFrame = sequence?.sourceStartFrame === undefined
      ? this.currentFrame
      : this.wrapFrame(this.currentFrame - sequence.sourceStartFrame);
    position(this.songPlayhead, relativeFrame, this.songPlayheadSpan);
    const projectRange = this.projectPlayheadRange;
    position(this.projectPlayhead, this.currentFrame - (projectRange?.minimum || 0), projectRange?.span || 0);
  }

  updateDisplays() {
    if (!this.core) return;
    this.updateClocks();
    const listening = Boolean(this.mediaStream);
    const inputStatus = this.locked ? "LTC locked" : listening ? "Listening · waiting for LTC" : "LTC input stopped";
    $("#timecode-settings-status").textContent = this.locked ? "LTC locked" : listening ? "Listening" : "Input stopped";
    $("#timecode-control-input").textContent = inputStatus;
    $("#timecode-control-status").textContent = this.playbackMode === "ltc" ? "LTC armed" : this.playbackMode === "test" ? "Test playing" : "Disarmed";
    $("#timecode-arm-ltc").setAttribute("aria-pressed", String(this.playbackMode === "ltc"));
    $("#timecode-arm-ltc").textContent = this.playbackMode === "ltc" ? "Disarm LTC" : "Arm LTC";
    $("#timecode-settings-status").dataset.tone = this.locked ? "success" : "";
    const liveRecord = $("#timecode-live-record");
    liveRecord.disabled = !this.canRecordLiveCue();
    liveRecord.title = this.canRecordLiveCue() ? "Record button in Program will add cues at the current LTC position." : "Select a song, arm LTC, and wait for signal lock to record live cues.";
  }
}

function $(selector) { return document.querySelector(selector); }

function option(value, text) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  return node;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className) {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}
