/**
 * [INPUT]: The library dialog's optional "补充要求" from a run request (`body.guidance`).
 * [OUTPUT]: This turn's guidance prompt section, or '' when there is nothing to inject.
 * [POS]: The single owner of the "injected, never in the transcript" rule for turn guidance.
 *
 * Why this is a request field instead of message text: the web client used to append the dialog's
 * requirements to the brief it sent, which made the chat transcript show a prompt the user never
 * typed and replayed that block on every later turn of the same conversation. Passing it
 * separately keeps the agent's priority (it still reads as the last section above the message)
 * while history stores exactly what the user wrote.
 */

/**
 * Upper bound for the injected block. The dialog takes a few sentences in practice; the cap keeps
 * a pasted document from turning every subsequent turn's prompt into a payload.
 */
export const MAX_TURN_GUIDANCE_CHARS = 4000;

export function buildTurnGuidancePrompt(guidance: unknown): string {
  if (typeof guidance !== 'string') return '';
  // Trim first, then cap: trailing whitespace should not eat into the budget.
  const text = guidance.trim().slice(0, MAX_TURN_GUIDANCE_CHARS).trimEnd();
  if (!text) return '';
  return `## 补充要求（优先满足）\n\n${text}`;
}
