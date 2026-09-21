import type { RuleId } from '@line-first/contracts';

/**
 * Deliberately literal-only.  JavaScript regular expressions can take an
 * unbounded amount of CPU for a crafted input, which would stop the single
 * event loop that receives and sends for every bot.  A keyword race cannot
 * afford that shared stall.
 */
export const MATCH_KINDS = ['exact', 'prefix', 'contains'] as const;

export type MatchKind = (typeof MATCH_KINDS)[number];

/** Author-facing rule, as stored in config. Validated by {@link compileRules}. */
export interface RuleSpec {
  id: string;
  /** Higher wins. Ties broken by config order (stable). */
  priority: number;
  kind: MatchKind;
  /** Literal needle for exact/prefix/contains. */
  pattern: string;
  /** Reply text. Phase 1 treats it as a static template. */
  reply: string;
}

/** Normalisation applied to BOTH rule patterns and inbound text before matching.
 * Defined once per rule set so behaviour is consistent (decision doc Phase 4). */
export interface MatchOptions {
  caseSensitive: boolean;
  trim: boolean;
  collapseWhitespace: boolean;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  caseSensitive: false,
  trim: true,
  collapseWhitespace: false,
};

export interface CompiledRule {
  readonly id: RuleId;
  readonly priority: number;
  readonly kind: MatchKind;
  readonly reply: string;
  readonly configIndex: number;
  test(normalizedText: string): boolean;
}

export interface CompiledRuleSet {
  readonly options: MatchOptions;
  match(rawText: string): CompiledRule | null;
  readonly size: number;
}
