// Writes the committed synthetic fixture: fixtures/synthetic/{u.data,u.item,traps.json} from seed 38.
// Usage: npm run gen:synthetic   (deterministic; re-running produces byte-identical files)
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateSynthetic, SYNTHETIC_SEED, trapsSidecar } from '../src/core/data/synthetic.ts';

const outDir = fileURLToPath(new URL('../fixtures/synthetic/', import.meta.url));
const fx = generateSynthetic(SYNTHETIC_SEED);

await mkdir(outDir, { recursive: true });
await writeFile(new URL('../fixtures/synthetic/u.data', import.meta.url), fx.uData, 'utf8');
await writeFile(new URL('../fixtures/synthetic/u.item', import.meta.url), fx.uItem);
await writeFile(new URL('../fixtures/synthetic/traps.json', import.meta.url), `${JSON.stringify(trapsSidecar(fx), null, 2)}\n`, 'utf8');

const rows = fx.uData.split('\n').filter((l) => l !== '').length;
console.log(`gen:synthetic seed=${fx.seed}: ${rows} u.data rows, ${fx.uItem.length} u.item bytes, ${fx.traps.length} trap records -> ${outDir}`);
