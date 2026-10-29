// Append-only local mock checkpoint. Explicit adapter: never a fallback for a failed remote store.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CallRowSchema } from '../ledger/schema.ts';
import { createMemoryResultStore, ResultRowSchema, RunIdentitySchema, resultKey,
  type ResultStore, type RunIdentity } from '../runner/store.ts';

export async function openJsonlStore(file: string, identity: RunIdentity): Promise<ResultStore> {
  const memory = createMemoryResultStore();
  let text = '';
  try { text = await readFile(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  let hasMeta = false;
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`${file}:${index + 1}: corrupt JSONL; restore checkpoint before resume`); }
    if (!value || typeof value !== 'object' || !('type' in value) || !('value' in value)) throw new Error(`${file}:${index + 1}: invalid checkpoint record`);
    if (value.type === 'meta') {
      if (hasMeta) throw new Error('duplicate checkpoint metadata');
      await memory.bind(RunIdentitySchema.parse(value.value)); hasMeta = true;
    } else if (!hasMeta) throw new Error('checkpoint must start with metadata');
    else if (value.type === 'result') await memory.put(ResultRowSchema.parse(value.value));
    else if (value.type === 'call') {
      // Call records are validated by the ledger on reconstruction; reject malformed rows at this boundary too.
      await memory.appendCall(CallRowSchema.parse(value.value));
    } else throw new Error(`unsupported checkpoint record ${String(value.type)}`);
  }
  await memory.bind(identity);
  await mkdir(path.dirname(file), { recursive: true });
  const append = async (type: 'meta' | 'result' | 'call', value: unknown): Promise<void> => {
    await appendFile(file, `${JSON.stringify({ type, value })}\n`, 'utf8');
  };
  if (!hasMeta) await append('meta', identity);
  const resultIds = new Set((await memory.rows()).map(resultKey));
  const callIds = new Set((await memory.calls()).map((r) => r.id));
  return {
    bind: (id) => memory.bind(id), get: (key) => memory.get(key), rows: () => memory.rows(), calls: () => memory.calls(),
    async put(row) {
      const key = resultKey(row);
      await memory.put(row);
      if (!resultIds.has(key)) { await append('result', row); resultIds.add(key); }
    },
    async appendCall(row) {
      await memory.appendCall(row);
      if (!callIds.has(row.id)) { await append('call', row); callIds.add(row.id); }
    },
  };
}
