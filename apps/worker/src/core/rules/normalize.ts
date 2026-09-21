import type { MatchOptions } from './types.ts';

const WHITESPACE_RUN = /\s+/gu;

/**
 * Canonicalises text before matching. Always applies Unicode NFC so that
 * pre-composed and combining Thai sequences compare equal (decision doc
 * Phase 4: "กำหนดกติกา Unicode/ช่องว่าง/ตัวพิมพ์ชัดเจน").
 */
export function normalizeText(input: string, options: MatchOptions): string {
  let text = input.normalize('NFC');
  if (!options.caseSensitive) text = text.toLowerCase();
  if (options.collapseWhitespace) text = text.replace(WHITESPACE_RUN, ' ');
  if (options.trim) text = text.trim();
  return text;
}
