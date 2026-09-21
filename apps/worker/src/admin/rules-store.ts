import { AppError, ValidationError } from '../errors/base.ts';
import { type BotConfig, parseBotConfig } from '../config/bot-config.ts';
import type { RuleSpec } from '../core/rules/types.ts';

/**
 * Read-modify-write for one bot's rule list, safe to call from an HTTP
 * handler triggered by a browser click.
 *
 * Every write goes through the same validator the worker uses to load its
 * config at startup (`parseBotConfig`), so a bad edit — a duplicate id, a
 * missing pattern, an unknown match kind — is rejected with the same
 * every-problem-at-once message an operator would get from a bad config file,
 * never partially applied. The write itself is temp-file-then-rename, so a
 * crash mid-write leaves the last-good file in place, not a truncated one.
 */
/** Distinct from {@link ValidationError}: the request was well-formed, it just
 * named a rule that is not there — a 404 shape, not a 400 one. */
export class RuleConflictError extends AppError {
  readonly code = 'rule_not_found';
  readonly errorClass = 'permanent' as const;
}

/** What the caller supplies for a new or edited rule — not yet validated. */
export interface RuleInput {
  id: string;
  priority: number;
  kind: string;
  pattern: string;
  reply: string;
}

export class RulesStore {
  constructor(private readonly configPath: string) {}

  async config(): Promise<BotConfig> {
    return await this.#read();
  }

  async list(): Promise<readonly RuleSpec[]> {
    return (await this.#read()).rules;
  }

  async add(input: RuleInput): Promise<BotConfig> {
    const raw = await this.#readRaw();
    const rules = asRuleArray(raw['rules']);
    if (rules.some((r) => ruleId(r) === input.id)) {
      throw new ValidationError(`rule "${input.id}" already exists — use update instead`, {
        id: input.id,
      });
    }
    return this.#writeValidated({ ...raw, rules: [...rules, toRaw(input)] });
  }

  async update(id: string, input: RuleInput): Promise<BotConfig> {
    const raw = await this.#readRaw();
    const rules = asRuleArray(raw['rules']);
    const index = rules.findIndex((r) => ruleId(r) === id);
    if (index === -1) throw new RuleConflictError(`no rule with id "${id}"`, { id });
    const next = [...rules];
    next[index] = toRaw(input);
    return this.#writeValidated({ ...raw, rules: next });
  }

  async remove(id: string): Promise<BotConfig> {
    const raw = await this.#readRaw();
    const rules = asRuleArray(raw['rules']);
    const next = rules.filter((r) => ruleId(r) !== id);
    if (next.length === rules.length) {
      throw new RuleConflictError(`no rule with id "${id}"`, { id });
    }
    return this.#writeValidated({ ...raw, rules: next });
  }

  async setDedicatedRooms(roomIds: readonly string[]): Promise<BotConfig> {
    const raw = await this.#readRaw();
    return await this.#writeValidated({ ...raw, dedicatedRooms: [...roomIds] });
  }

  async setSelectedRooms(
    roomIds: readonly string[],
    dedicatedRooms: readonly string[],
    surfaces: { talk: boolean; square: boolean },
  ): Promise<BotConfig> {
    const raw = await this.#readRaw();
    return await this.#writeValidated({
      ...raw,
      selectedRooms: [...roomIds],
      dedicatedRooms: [...dedicatedRooms],
      talk: surfaces.talk,
      square: surfaces.square,
    });
  }

  async #read(): Promise<BotConfig> {
    return parseBotConfig(await this.#readRaw(), this.configPath);
  }

  async #readRaw(): Promise<Record<string, unknown>> {
    const text = await Deno.readTextFile(this.configPath);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError(`${this.configPath}: expected a JSON object`, {
        path: this.configPath,
      });
    }
    return parsed as Record<string, unknown>;
  }

  /** Validates the WHOLE config (not just the rules) before writing, so an
   * edit can never leave the file in a state the worker would refuse to load. */
  async #writeValidated(raw: Record<string, unknown>): Promise<BotConfig> {
    const config = parseBotConfig(raw, this.configPath);
    const tmp = `${this.configPath}.tmp-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(tmp, `${JSON.stringify(raw, null, 2)}\n`);
      await Deno.rename(tmp, this.configPath);
    } catch (err: unknown) {
      await Deno.remove(tmp).catch(() => {});
      throw err;
    }
    return config;
  }
}

const ruleId = (r: unknown): unknown =>
  typeof r === 'object' && r !== null ? (r as Record<string, unknown>)['id'] : undefined;

function asRuleArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

function toRaw(input: RuleInput): Record<string, unknown> {
  return {
    id: input.id,
    priority: input.priority,
    kind: input.kind,
    pattern: input.pattern,
    reply: input.reply,
  };
}
