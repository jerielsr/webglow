import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const HISTORY_RETENTIONS = ['all', 'year', 'month', 'week', 'day'] as const;
export type HistoryRetention = (typeof HISTORY_RETENTIONS)[number];

export interface CommandHistoryEvent {
  id: string;
  at: string;
  action: string;
  summary: string;
  fixtureIds: string[];
  detail?: string;
}

interface PersistedHistory { version: 1; events: CommandHistoryEvent[] }

const RETENTION_MS: Record<Exclude<HistoryRetention, 'all'>, number> = {
  year: 365 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  day: 24 * 60 * 60_000,
};

function isEvent(value: unknown): value is CommandHistoryEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<CommandHistoryEvent>;
  return typeof event.id === 'string' && typeof event.at === 'string' && typeof event.action === 'string' &&
    typeof event.summary === 'string' && Array.isArray(event.fixtureIds) && event.fixtureIds.every((id) => typeof id === 'string') &&
    (event.detail === undefined || typeof event.detail === 'string');
}

export class CommandHistoryStore {
  private events: CommandHistoryEvent[] = [];
  private pendingWrite: Promise<void> = Promise.resolve();
  private initialized = false;
  private retention: HistoryRetention = 'month';

  constructor(private readonly historyFile: string) {}

  async initialize(retention: HistoryRetention): Promise<void> {
    if (this.initialized) return;
    try {
      const parsed = JSON.parse(await readFile(this.historyFile, 'utf8')) as Partial<PersistedHistory>;
      if (parsed.version !== 1 || !Array.isArray(parsed.events) || !parsed.events.every(isEvent)) {
        throw new Error('The saved command history does not match the expected format.');
      }
      this.events = parsed.events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Unable to load command history from ' + this.historyFile + ': ' + String(error));
      }
    }
    this.initialized = true;
    await this.setRetention(retention);
  }

  async record(input: Omit<CommandHistoryEvent, 'id' | 'at'>): Promise<void> {
    const now = new Date();
    const fixtureIds = [...new Set(input.fixtureIds)];
    const previous = this.events.at(-1);
    const coalesceProgrammer = input.action === 'Batch programmer' && previous?.action === input.action &&
      previous.summary === input.summary && previous.detail === input.detail &&
      JSON.stringify(previous.fixtureIds) === JSON.stringify(fixtureIds) && now.getTime() - Date.parse(previous.at) < 1_500;
    if (coalesceProgrammer && previous) previous.at = now.toISOString();
    else this.events.push({ ...input, fixtureIds, id: randomUUID(), at: now.toISOString() });
    await this.pruneAndPersist();
  }

  async list(offset = 0, limit = 200): Promise<{
    events: CommandHistoryEvent[];
    count: number;
    storageBytes: number;
    retention: HistoryRetention;
    offset: number;
    nextOffset: number;
    hasMore: boolean;
  }> {
    const summary = await this.summary();
    const start = Math.max(0, Math.floor(offset));
    const pageSize = Math.max(1, Math.min(200, Math.floor(limit)));
    const newestFirst = [...this.events].reverse();
    const events = newestFirst.slice(start, start + pageSize);
    const nextOffset = start + events.length;
    return {
      events,
      ...summary,
      offset: start,
      nextOffset,
      hasMore: nextOffset < summary.count,
    };
  }

  async summary(): Promise<{ count: number; storageBytes: number; retention: HistoryRetention }> {
    const serialized = JSON.stringify({ version: 1, events: this.events }, null, 2) + '\n';
    return { count: this.events.length, storageBytes: Buffer.byteLength(serialized), retention: this.retention };
  }

  async setRetention(retention: HistoryRetention): Promise<void> {
    this.retention = retention;
    await this.pruneAndPersist();
  }

  async close(): Promise<void> { await this.pendingWrite; }

  private async pruneAndPersist(): Promise<void> {
    if (this.retention !== 'all') {
      const cutoff = Date.now() - RETENTION_MS[this.retention];
      this.events = this.events.filter((event) => Date.parse(event.at) >= cutoff);
    }
    const serialized = JSON.stringify({ version: 1, events: this.events } satisfies PersistedHistory, null, 2) + '\n';
    const write = this.pendingWrite.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.historyFile), { recursive: true });
      const temporary = this.historyFile + '.' + process.pid + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, serialized, 'utf8');
      await rename(temporary, this.historyFile);
    });
    this.pendingWrite = write;
    await write;
  }
}
