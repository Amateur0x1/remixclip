/**
 * POST /api/test/connection — real connectivity test (slimmed-down open-design connectionTest).
 *
 * Difference from 'version probing': this spawns the CLI once the same way a run does
 * (injecting agentCliEnv, passing a trivial prompt) and verifies 'it really can talk' —
 * login state, auth, proxy, and model availability all covered. The daemon always returns
 * 200 + ConnectionTestResponse; read ok/kind/detail for the outcome.
 *
 * Categories (aligned with OD classifyVersionProbeFailure semantics):
 * - binary  : executable not found
 * - timeout : process killed on timeout (usually network unreachable / proxy issues)
 * - auth    : non-zero exit code and stderr hits auth keywords
 * - network : stderr hits network keywords
 * - ok      : process exited successfully and actual assistant text was parsed
 *             (an init frame does not count as a successful connection)
 */

import type { Express, Request, Response } from 'express';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConnectionTestResponse } from '@remixclip/contracts';
import { getAgentDef } from '../runtimes/registry.js';
import { agentAuthStatus, agentCapabilities } from '../runtimes/detection.js';
import { resolveAgentExecutable } from '../runtimes/executables.js';
import { readAppConfig, agentCliEnvForAgent } from '../app-config.js';

const TEST_TIMEOUT_MS = 45_000;
const TEST_PROMPT = 'Reply with exactly: ok';
const AUTH_HINTS = [
  'unauthorized', 'authentication', 'api key', 'apikey', 'auth', 'login',
  'credit', 'billing', 'quota', 'permission', 'token', '401', '403',
];
const NETWORK_HINTS = [
  'econnrefused', 'enotfound', 'etimedout', 'econnreset', 'fetch failed',
  'network', 'proxy', 'dns', 'certificate',
];

function classifyStderr(stderr: string): 'auth' | 'network' | null {
  const text = stderr.toLowerCase();
  if (NETWORK_HINTS.some((k) => text.includes(k))) return 'network';
  if (AUTH_HINTS.some((k) => text.includes(k))) return 'auth';
  return null;
}

export function registerConnectionTestRoutes(app: Express): void {
  app.post('/api/test/connection', async (req: Request, res: Response) => {
    const start = Date.now();
    const respond = (body: ConnectionTestResponse) => res.json(body);
    const latency = () => Date.now() - start;

    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : '';
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
    const def = getAgentDef(agentId);
    if (!def) {
      return respond({ ok: false, kind: 'unknown', latencyMs: latency(), detail: `未知 agent：${agentId}` });
    }

    const configuredEnv = agentCliEnvForAgent(readAppConfig(), def.id);
    const spawnEnv = { ...process.env, ...def.env, ...configuredEnv };
    const binPath = resolveAgentExecutable(def, spawnEnv);
    if (!binPath) {
      return respond({
        ok: false,
        kind: 'binary',
        latencyMs: latency(),
        model,
        detail: `未找到 ${def.bin} 可执行文件（可在设置中用 BIN 环境变量指定路径）`,
      });
    }

    // Bidirectional protocols (ACP JSON-RPC / dsh profile stdio) need a full handshake, so
    // this degrades to a 'binary resolvable' level of verification; detail says so honestly.
    if (def.streamFormat === 'acp' || def.streamFormat === 'dsh-profile') {
      return respond({
        ok: true,
        kind: 'ok',
        latencyMs: latency(),
        model,
        detail: `已验证二进制可用（${def.streamFormat === 'acp' ? 'ACP' : 'profile stdio'} 会话协议暂不做逐轮对话级测试）`,
      });
    }

    // Read the probe cache left by /api/agents first (don't re-probe here, to avoid added
    // latency):
    // - authProbe says not logged in → return auth directly, no need to wait 45s timeout;
    // - capability bits are left to buildArgs to decide which flags to pass (same as run path).
    const auth = agentAuthStatus(def.id);
    if (auth?.status === 'unauthenticated') {
      return respond({
        ok: false,
        kind: 'auth',
        latencyMs: latency(),
        model,
        detail: `${auth.detail ? `${auth.detail} · ` : ''}请先在终端运行 ${def.bin} 完成登录`,
      });
    }

    // promptViaFile adapters: write the trivial prompt into a temp file, clean up after run
    let promptFilePath: string | undefined;
    if (def.promptViaFile) {
      promptFilePath = path.join(tmpdir(), `remixclip-conn-${randomUUID()}.txt`);
      writeFileSync(promptFilePath, TEST_PROMPT, 'utf8');
    }

    let args: string[];
    try {
      args = def.buildArgs({
        model: model ?? null,
        resumeSessionId: null,
        prompt: TEST_PROMPT,
        promptFilePath,
        cwd: process.env.HOME ?? process.cwd(),
        capabilities: agentCapabilities(def.id),
      });
    } catch (error) {
      if (promptFilePath) rmSync(promptFilePath, { force: true });
      return respond({
        ok: false,
        kind: 'unknown',
        latencyMs: latency(),
        model,
        detail: error instanceof Error ? error.message : '构造启动参数失败',
      });
    }

    return new Promise<void>((resolve) => {
      const child = spawn(binPath, args, {
        cwd: process.env.HOME ?? process.cwd(),
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const parseLine = def.createParser?.() ?? null;
      let stdoutBuffer = '';
      let assistantOutput = false;
      let errorDetail = '';
      let stderrTail = '';
      let settled = false;

      const finish = (body: ConnectionTestResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        if (promptFilePath) {
          try { rmSync(promptFilePath, { force: true }); } catch { /* best effort */ }
        }
        respond(body);
        resolve();
      };

      const timer = setTimeout(
        () => finish({
          ok: false,
          kind: 'timeout',
          latencyMs: latency(),
          model,
          detail: `${TEST_TIMEOUT_MS / 1000}s 内无响应（常为网络不通或代理问题）`,
        }),
        TEST_TIMEOUT_MS,
      );

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const payloads = parseLine?.(line) ?? [];
          if (payloads.some((p) => p.type === 'text_delta' && p.delta.trim())) {
            assistantOutput = true;
          }
          const status = payloads.find((p) => p.type === 'status' && p.label === 'agent 错误');
          if (status && status.type === 'status' && status.detail) {
            errorDetail = status.detail;
          }
          // explicit error in claude/codex compatibility frames
          try {
            const frame = JSON.parse(line) as { type?: string; is_error?: boolean; result?: string; error?: unknown };
            if (frame.type === 'result' && frame.is_error) errorDetail = frame.result ?? 'agent 返回错误';
            if (frame.type === 'error' && typeof frame.error === 'string') errorDetail = frame.error;
          } catch { /* skip non-JSON lines */ }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-2000);
      });

      child.on('error', (err) => {
        finish({ ok: false, kind: 'network', latencyMs: latency(), model, detail: String(err) });
      });

      child.on('close', (code) => {
        if (code === 0 && assistantOutput && !errorDetail) {
          finish({ ok: true, kind: 'ok', latencyMs: latency(), model });
          return;
        }
        const kind = classifyStderr(`${stderrTail} ${errorDetail}`) ?? 'unknown';
        finish({
          ok: false,
          kind,
          latencyMs: latency(),
          model,
          detail: (errorDetail || stderrTail.trim()).split('\n').slice(-3).join('\n') || `进程退出码 ${code}，未收到有效回复`,
        });
      });

      // prompt delivery: stdin (encoded per adapter when needed) / file / already in argv
      if (def.promptViaStdin && !def.promptViaFile) {
        const payload = def.encodeStdinPrompt ? def.encodeStdinPrompt(TEST_PROMPT) : TEST_PROMPT;
        child.stdin?.end(payload);
      } else {
        child.stdin?.end();
      }
    });
  });
}
