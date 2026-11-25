const RATE_INFO = Object.freeze({
  "23.976": { nominal: 24, actual: 24_000 / 1_001, drop: 0 },
  "24": { nominal: 24, actual: 24, drop: 0 },
  "25": { nominal: 25, actual: 25, drop: 0 },
  "29.97df": { nominal: 30, actual: 30_000 / 1_001, drop: 2 },
  "30": { nominal: 30, actual: 30, drop: 0 },
});

export function getRateInfo(rate) {
  const info = RATE_INFO[String(rate)];
  if (!info) throw new RangeError("Choose a supported SMPTE frame rate.");
  return info;
}

export function framesPerDay(rate) {
  const info = getRateInfo(rate);
  return info.nominal * 24 * 60 * 60 - info.drop * (24 * 60 - 24 * 6);
}

export function parseTimecode(value, rate) {
  const info = getRateInfo(rate);
  const match = String(value).trim().match(/^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/);
  if (!match) throw new RangeError("Enter timecode as HH:MM:SS:FF.");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const frame = Number(match[5]);
  if (hours > 23 || minutes > 59 || seconds > 59 || frame >= info.nominal) {
    throw new RangeError("That timecode is outside the selected frame rate.");
  }
  const totalMinutes = hours * 60 + minutes;
  if (info.drop && seconds === 0 && totalMinutes % 10 !== 0 && frame < info.drop) {
    throw new RangeError("Frames 00 and 01 are skipped at non-tenth minutes in 29.97 drop-frame timecode.");
  }
  const nominalFrames = ((hours * 60 + minutes) * 60 + seconds) * info.nominal + frame;
  return nominalFrames - info.drop * (totalMinutes - Math.floor(totalMinutes / 10));
}

export function formatTimecode(frameCount, rate) {
  const info = getRateInfo(rate);
  const dayFrames = framesPerDay(rate);
  let count = ((Math.trunc(frameCount) % dayFrames) + dayFrames) % dayFrames;
  let nominalFrame;
  if (info.drop) {
    const framesPerTenMinutes = info.nominal * 60 * 10 - info.drop * 9;
    const framesPerMinute = info.nominal * 60 - info.drop;
    const tenMinuteBlocks = Math.floor(count / framesPerTenMinutes);
    const remainder = count % framesPerTenMinutes;
    const droppedWithinBlock = remainder <= 2 ? 0 : Math.min(9, Math.floor((remainder - 2) / framesPerMinute));
    const droppedLabels = info.drop * (tenMinuteBlocks * 9 + droppedWithinBlock);
    nominalFrame = count + droppedLabels;
  } else {
    nominalFrame = count;
  }
  const frame = nominalFrame % info.nominal;
  const totalSeconds = Math.floor(nominalFrame / info.nominal);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60) % 24;
  const separator = info.drop ? ";" : ":";
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":") + separator + String(frame).padStart(2, "0");
}

// SMPTE ST 12-1 transmits the sync word as bits 64..79: 00, twelve 1s, 01.
// This is the wire order (the order emitted by the bi-phase decoder), not the
// reversed numeric representation 0x3FFD used by some packed-bit APIs.
const LTC_SYNC = Object.freeze([0, 0, ...Array(12).fill(1), 0, 1]);

function readBits(bits, start, width) {
  let value = 0;
  for (let offset = 0; offset < width; offset += 1) value |= bits[start + offset] << offset;
  return value;
}

function decodeLtcFrame(bits, frameRate) {
  const frame = readBits(bits, 0, 4) + readBits(bits, 8, 2) * 10;
  const seconds = readBits(bits, 16, 4) + readBits(bits, 24, 3) * 10;
  const minutes = readBits(bits, 32, 4) + readBits(bits, 40, 3) * 10;
  const hours = readBits(bits, 48, 4) + readBits(bits, 56, 2) * 10;
  const rate = getRateInfo(frameRate);
  if (frame >= rate.nominal || seconds > 59 || minutes > 59 || hours > 23) return null;
  const timecode = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${rate.drop ? ";" : ":"}${String(frame).padStart(2, "0")}`;
  try { return { timecode, frames: parseTimecode(timecode, frameRate), dropFrame: Boolean(bits[10]) }; }
  catch { return null; }
}

/** Decode forward-running SMPTE LTC from mono Web Audio samples. */
export class LtcDecoder {
  constructor(frameRate, onFrame, onLevel = () => undefined, onDiagnostics = () => undefined) {
    this.frameRate = frameRate;
    this.onFrame = onFrame;
    this.onLevel = onLevel;
    this.onDiagnostics = onDiagnostics;
    this.stats = {
      blocks: 0,
      samples: 0,
      zeroCrossings: 0,
      intervals: 0,
      invalidIntervals: 0,
      bits: 0,
      syncMatches: 0,
      invalidFrames: 0,
      decodedFrames: 0,
      peak: 0,
      rms: 0,
      lastTimecode: null,
      lastFrameAt: null,
    };
    this.reset();
  }

  setFrameRate(frameRate) {
    this.frameRate = frameRate;
    this.reset();
  }

  reset() {
    this.sampleIndex = 0;
    this.lastCrossing = null;
    this.sign = 0;
    this.pendingBoundary = false;
    this.bits = [];
    this.silentSamples = 0;
  }

  getDiagnostics() {
    return { frameRate: this.frameRate, ...this.stats };
  }

  publishDiagnostics() {
    this.onDiagnostics(this.getDiagnostics());
  }

  pushSamples(samples, sampleRate) {
    if (!samples?.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
    this.stats.blocks += 1;
    this.stats.samples += samples.length;
    let mean = 0;
    for (let index = 0; index < samples.length; index += 1) mean += samples[index];
    mean /= samples.length;
    let peak = 0;
    let energy = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const centeredSample = samples[index] - mean;
      const magnitude = Math.abs(centeredSample);
      if (magnitude > peak) peak = magnitude;
      energy += centeredSample * centeredSample;
    }
    const rms = Math.sqrt(energy / samples.length);
    this.stats.peak = peak;
    this.stats.rms = rms;
    this.onLevel({ peak, rms });
    if (peak < 0.008) {
      this.silentSamples += samples.length;
      if (this.silentSamples > sampleRate / 2) this.reset();
      this.sampleIndex += samples.length;
      this.publishDiagnostics();
      return;
    }
    this.silentSamples = 0;
    const threshold = Math.max(0.002, Math.min(0.15, peak * 0.16));
    const halfBit = sampleRate / (getRateInfo(this.frameRate).actual * 160);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index] - mean;
      const nextSign = sample >= threshold ? 1 : sample <= -threshold ? -1 : 0;
      if (!nextSign) continue;
      if (!this.sign) {
        this.sign = nextSign;
        continue;
      }
      if (nextSign === this.sign) continue;
      this.sign = nextSign;
      this.stats.zeroCrossings += 1;
      const crossing = this.sampleIndex + index;
      if (this.lastCrossing !== null) this.acceptInterval(crossing - this.lastCrossing, halfBit);
      this.lastCrossing = crossing;
    }
    this.sampleIndex += samples.length;
    this.publishDiagnostics();
  }

  acceptInterval(interval, halfBit) {
    this.stats.intervals += 1;
    if (!Number.isFinite(interval) || interval < halfBit * 0.48 || interval > halfBit * 2.65) {
      this.stats.invalidIntervals += 1;
      this.bits.length = 0;
      this.pendingBoundary = false;
      return;
    }
    const isHalf = interval < halfBit * 1.47;
    if (this.pendingBoundary) {
      if (isHalf) this.pendingBoundary = false;
      else { this.bits.length = 0; this.pendingBoundary = false; }
      return;
    }
    if (isHalf) {
      this.pushBit(1);
      this.pendingBoundary = true;
    } else {
      this.pushBit(0);
    }
  }

  pushBit(bit) {
    this.stats.bits += 1;
    this.bits.push(bit);
    if (this.bits.length > 96) this.bits.shift();
    if (this.bits.length < 80) return;
    const syncStart = this.bits.length - LTC_SYNC.length;
    if (!LTC_SYNC.every((value, index) => this.bits[syncStart + index] === value)) return;
    this.stats.syncMatches += 1;
    const payloadStart = this.bits.length - 80;
    const decoded = decodeLtcFrame(this.bits.slice(payloadStart, payloadStart + 64), this.frameRate);
    if (decoded) {
      this.stats.decodedFrames += 1;
      this.stats.lastTimecode = decoded.timecode;
      this.stats.lastFrameAt = new Date().toISOString();
      this.onFrame(decoded);
    } else {
      this.stats.invalidFrames += 1;
    }
  }
}
