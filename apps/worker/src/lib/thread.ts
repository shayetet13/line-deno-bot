/**
 * A name for the thread this module instance runs on. Every Worker gets its
 * own copy of this module, so a bot shard labels itself once at startup and
 * everything it reports carries that label; the main thread stays unlabelled.
 */
let label: string | undefined;

export function setThreadLabel(next: string): void {
  label = next;
}

export function threadLabel(): string | undefined {
  return label;
}
