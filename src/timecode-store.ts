import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { validateTimecodeProgram } from './validation.js';
import type { TimecodeProgram } from './types.js';

interface PersistedTimecode { version: 1; program: TimecodeProgram }

export const DEFAULT_TIMECODE_PROGRAM: TimecodeProgram = {
  frameRate: '25',
  sequences: [],
  segments: [],
};

export class TimecodeStore {
  private program: TimecodeProgram = structuredClone(DEFAULT_TIMECODE_PROGRAM);
  private pendingWrite: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly dataFile: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, 'utf8')) as Partial<PersistedTimecode>;
      if (parsed.version !== 1 || !parsed.program) throw new Error('The saved timecode program does not match the expected format.');
      this.program = validateTimecodeProgram(parsed.program);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Unable to load timecode program from ' + this.dataFile + ': ' + String(error));
      }
    }
    this.initialized = true;
  }

  get(): TimecodeProgram { return structuredClone(this.program); }

  async replace(program: TimecodeProgram): Promise<TimecodeProgram> {
    const previous = this.program;
    this.program = structuredClone(program);
    try { await this.persist(); } catch (error) { this.program = previous; throw error; }
    return this.get();
  }

  async removeCue(cueId: string): Promise<number> {
    const previous = this.program;
    let removed = 0;
    this.program = {
      ...this.program,
      sequences: this.program.sequences.map((sequence) => {
        const events = sequence.events.filter((event) => event.cueId !== cueId);
        removed += sequence.events.length - events.length;
        return { ...sequence, events };
      }),
    };
    if (!removed) return 0;
    try { await this.persist(); } catch (error) { this.program = previous; throw error; }
    return removed;
  }

  async close(): Promise<void> { await this.pendingWrite; }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify({ version: 1, program: this.program } satisfies PersistedTimecode, null, 2)}\n`;
    const write = this.pendingWrite.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.dataFile), { recursive: true });
      const temporary = this.dataFile + '.' + process.pid + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, serialized, 'utf8');
      await rename(temporary, this.dataFile);
    });
    this.pendingWrite = write;
    await write;
  }
}
