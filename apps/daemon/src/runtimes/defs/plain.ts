/**
 * Plain-text stream parser — every stdout line becomes a text_delta.
 * Used by qwen / gemini / pi (print mode).
 */

import type { DaemonAgentPayload } from '@remixclip/contracts';

export function createPlainTextParser(): (line: string) => DaemonAgentPayload[] {
  return (line: string): DaemonAgentPayload[] => {
    if (!line) return [];
    return [{ type: 'text_delta', delta: `${line}\n` }];
  };
}
