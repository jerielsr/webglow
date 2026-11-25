class LtcCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capture = new Float32Array(1024);
    this.captureLength = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    let channel = null;
    let channelIndex = -1;
    let strongestEnergy = -1;
    const channelLevels = [];
    for (let index = 0; index < (channels?.length || 0); index += 1) {
      const candidate = channels[index];
      if (!candidate?.length) continue;
      let mean = 0;
      for (let index = 0; index < candidate.length; index += 1) mean += candidate[index];
      mean /= candidate.length;
      let energy = 0;
      let peak = 0;
      for (let index = 0; index < candidate.length; index += 1) {
        const centered = candidate[index] - mean;
        energy += centered * centered;
        peak = Math.max(peak, Math.abs(centered));
      }
      const rms = Math.sqrt(energy / candidate.length);
      channelLevels.push({ channel: index + 1, rms, peak });
      if (energy > strongestEnergy) {
        strongestEnergy = energy;
        channel = candidate;
        channelIndex = index;
      }
    }
    if (channel?.length) {
      let offset = 0;
      while (offset < channel.length) {
        const count = Math.min(channel.length - offset, this.capture.length - this.captureLength);
        this.capture.set(channel.subarray(offset, offset + count), this.captureLength);
        this.captureLength += count;
        offset += count;
        if (this.captureLength === this.capture.length) {
          const copy = this.capture;
          this.capture = new Float32Array(1024);
          this.captureLength = 0;
          this.port.postMessage({
            samples: copy,
            channelIndex: channelIndex + 1,
            channelCount: channels.length,
            channelLevels,
          }, [copy.buffer]);
        }
      }
    }
    return true;
  }
}

registerProcessor("webglow-ltc-capture", LtcCaptureProcessor);
