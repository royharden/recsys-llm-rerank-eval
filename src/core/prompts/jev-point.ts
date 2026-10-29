// jev-point request (PLAN §4 [C question text, X validation]): one Jev request, state = history text, K questions
// ("Nouls") keyed c_<pos> in PAYLOAD order (the core already shuffled the question order by seed before sending).
// Vendorable: imports only contracts/, util/, prompts/, zod and config/prompts/*.json.
import { z } from 'zod';
import j1 from '../../../config/prompts/jev-point.v1.json' with { type: 'json' };
import type { RerankPayload } from '../contracts/rerank-payload.ts';
import { promptHash } from './hash.ts';
import { historyLabel, jevKey, sanitizeTitle, UNTITLED } from './labels.ts';

/** Model pin (PLAN §4): the returned model id must equal it; no alias substitution. */
export const JEV_MODEL_PIN = 'jev-1.13.0';

export const JEV_VERSIONS = ['jev-point.v1'] as const;
export type JevVersion = (typeof JEV_VERSIONS)[number];

export const JevTemplateSchema = z
  .object({
    schemaVersion: z.literal(1),
    promptVersion: z.enum(JEV_VERSIONS),
    arm: z.literal('jev-point'),
    stateHeader: z.string().min(1).max(1000),
    questionTemplate: z
      .string()
      .min(1)
      .max(1000)
      .refine((s) => s.split('{item}').length === 2, 'questionTemplate must contain {item} exactly once'),
  })
  .strict();

export type JevTemplate = z.infer<typeof JevTemplateSchema>;

export const JEV_TEMPLATES: Readonly<Record<JevVersion, JevTemplate>> = {
  'jev-point.v1': JevTemplateSchema.parse(j1),
};

export function isJevVersion(v: string): v is JevVersion {
  return (JEV_VERSIONS as readonly string[]).includes(v);
}

interface ItemMeta {
  title: string;
  year: number | null;
  genres: readonly string[];
}

/** `"<title>" (<year>; <genres>)` with the title sanitised and JSON-quoted (its delimiters). */
export function jevItemText(item: ItemMeta): string {
  const title = JSON.stringify(sanitizeTitle(item.title) || UNTITLED);
  const year = item.year === null ? 'year unknown' : String(item.year);
  const genres = item.genres.length > 0 ? item.genres.join(', ') : 'no genres';
  return `${title} (${year}; ${genres})`;
}

export interface JevQuestion {
  key: string;
  text: string;
}

export interface RenderedJev {
  promptVersion: JevVersion;
  state: string;
  /** Payload (= presentation) order; key c_<pos>. */
  questions: JevQuestion[];
}

export function renderJev(p: RerankPayload): RenderedJev {
  if (p.arm !== 'jev-point' || !isJevVersion(p.promptVersion)) throw new Error(`renderJev: not a jev-point payload (${p.promptVersion})`);
  const t = JEV_TEMPLATES[p.promptVersion];
  const state = [
    t.stateHeader,
    '<history>',
    ...p.history.map((h, i) => `${historyLabel(i + 1)} ${JSON.stringify({ title: sanitizeTitle(h.title) || UNTITLED, year: h.year, genres: [...h.genres] })}`),
    '</history>',
  ].join('\n');
  const [before, after] = t.questionTemplate.split('{item}');
  const questions = p.candidates.map((c, i) => ({ key: jevKey(i + 1), text: `${before}${jevItemText(c)}${after}` }));
  return { promptVersion: p.promptVersion, state, questions };
}

export function jevPromptHash(r: RenderedJev): string {
  return promptHash({ promptVersion: r.promptVersion, state: r.state, questions: r.questions.map((q) => ({ key: q.key, text: q.text })) });
}

/**
 * The full serialized TypeSafe request body. Envelope follows the approved local 01-jev-integration-guide.md.
 * The Noul type/instructions JSON shape remains provisional until live docs/API verification; boundVerified stays false.
 * The hard bound is computed on exactly these bytes, shared by dry run and the live adapter.
 */
export function serializeJevRequest(model: string, r: RenderedJev): string {
  return JSON.stringify({ model, state: r.state, questions: Object.fromEntries(r.questions.map((q) => [q.key, { type: 'noul', instructions: q.text }])) });
}
