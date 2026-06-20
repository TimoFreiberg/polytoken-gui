import type {
  SessionMessageDeliveryMode,
  SessionQueuedMessage,
} from "@pilot/protocol";

function textHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Convert pi's full text-only queue snapshot into Pilot's stable, JSON-safe rows. */
export function queueMessages(
  steering: readonly string[],
  followUp: readonly string[],
  timestamp: string,
): SessionQueuedMessage[] {
  const groups: readonly [
    SessionMessageDeliveryMode,
    readonly string[],
  ][] = [
    ["steer", steering],
    ["followUp", followUp],
  ];
  return groups.flatMap(([mode, messages]) =>
    messages.map((text, index) => ({
      id: `queue-${mode}-${index}-${textHash(text)}`,
      mode,
      text,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  );
}
