import os from 'node:os';

export class Metrics {
  private readonly startedAt = Date.now();
  private lastCpu = process.cpuUsage();
  private lastCpuAt = process.hrtime.bigint();
  private processCpuPercent = 0;
  private requestCount = 0;
  private receivedBytes = 0;
  private sentBytes = 0;
  private websocketConnections = 0;

  recordRequest(bytes: number): void {
    this.requestCount += 1;
    this.receivedBytes += Math.max(0, bytes);
  }

  recordResponse(bytes: number): void {
    this.sentBytes += Math.max(0, bytes);
  }

  websocketOpened(): void {
    this.websocketConnections += 1;
  }

  websocketClosed(): void {
    this.websocketConnections = Math.max(0, this.websocketConnections - 1);
  }

  snapshot(): Record<string, unknown> {
    const currentCpu = process.cpuUsage();
    const currentCpuAt = process.hrtime.bigint();
    const elapsedMicros = Number(currentCpuAt - this.lastCpuAt) / 1_000;
    const usedMicros =
      currentCpu.user - this.lastCpu.user + currentCpu.system - this.lastCpu.system;
    if (elapsedMicros > 0) {
      this.processCpuPercent = Math.round((usedMicros / elapsedMicros) * 1000) / 10;
    }
    this.lastCpu = currentCpu;
    this.lastCpuAt = currentCpuAt;

    const memory = process.memoryUsage();
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000),
      process: {
        cpuPercent: this.processCpuPercent,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
      },
      traffic: {
        requests: this.requestCount,
        receivedBytes: this.receivedBytes,
        sentBytes: this.sentBytes,
        activeDisplaySockets: this.websocketConnections,
        note: 'WebGlow HTTP and display WebSocket payload totals, not host network-interface traffic.',
      },
      host: {
        platform: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        cpus: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        loadAverage: os.loadavg(),
      },
    };
  }
}
