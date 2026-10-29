// Masked probe (PLAN §4): titles removed, year + genres kept. Reported as masked − unmasked ΔNDCG@10 on the matched
// probe users. Masking tests reliance on title text; it does NOT remove a model's memorisation of the items.
export const MASKED_VARIANT = 'masked';
export const MASKING_NOTE =
  'masked = titles removed, year and genres kept; masked − unmasked measures reliance on title text, it does not remove memorisation';

/** Copies with empty titles (the payload schema requires every title to be '' in the masked variant). */
export function maskTitles<T extends { title: string }>(items: readonly T[]): T[] {
  return items.map((it) => ({ ...it, title: '' }));
}
