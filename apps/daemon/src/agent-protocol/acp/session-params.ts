/** @module agent-protocol/acp/session-params
 * Ported verbatim from open-design acp/session-params.ts — build session/new params and prompt blocks.
 */

import path from 'node:path';

export interface AcpMcpServerInput {
  type?: unknown;
  name?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

export interface AcpSessionNewOptions {
  mcpServers?: AcpMcpServerInput[];
  /** Wire format of the env field: 'array' → [{name,value}] (Hermes/Kimi); 'map' → {KEY:val}. */
  envFormat?: 'array' | 'map';
}

/**
 * Build the session/new params. cwd is normalized to an absolute path; the env of each MCP server entry
 * is normalized between the array/map wire formats. MCP is optional — no mcpServers means none included.
 */
export function buildAcpSessionNewParams(
  cwd: string,
  { mcpServers, envFormat = 'array' }: AcpSessionNewOptions = {},
) {
  const servers = Array.isArray(mcpServers) ? mcpServers : [];
  const wantsMap = envFormat === 'map';
  return {
    cwd: path.resolve(cwd),
    mcpServers: servers.map((s) => {
      const rawEnv = s?.env;
      const isPlainObject = rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv);
      if (wantsMap && isPlainObject) {
        return {
          type: typeof s?.type === 'string' ? s.type : 'stdio',
          name: typeof s?.name === 'string' ? s.name : '',
          command: typeof s?.command === 'string' ? s.command : '',
          args: Array.isArray(s?.args) ? s.args : [],
          env: rawEnv,
        };
      }
      const envArr = Array.isArray(rawEnv) ? rawEnv : [];
      const env = wantsMap
        ? Object.fromEntries(
            envArr.map((e) => {
              const entry = e as { name?: unknown; value?: unknown } | null;
              return [String(entry?.name ?? ''), String(entry?.value ?? '')];
            }),
          )
        : isPlainObject
          ? Object.entries(rawEnv as Record<string, string>).map(([name, value]) => ({
              name,
              value,
            }))
          : envArr;
      return {
        type: typeof s?.type === 'string' ? s.type : 'stdio',
        name: typeof s?.name === 'string' ? s.name : '',
        command: typeof s?.command === 'string' ? s.command : '',
        args: Array.isArray(s?.args) ? s.args : [],
        env,
      };
    }),
  };
}

/**
 * Assemble the prompt array for session/prompt: a leading { type:'text', text } block,
 * followed by one { type:'resource_link', uri } block per non-empty attachment path.
 */
export function buildPromptBlocks(
  prompt: string,
  resourcePaths: string[],
): Array<Record<string, string>> {
  const blocks: Array<Record<string, string>> = [{ type: 'text', text: prompt }];
  for (const resourcePath of resourcePaths) {
    if (typeof resourcePath !== 'string' || resourcePath.trim().length === 0) continue;
    blocks.push({ type: 'resource_link', uri: resourcePath });
  }
  return blocks;
}
