import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SESSION = '074f6f2e-e77b-4349-9a5b-7baed6a4c40e';

describe('Claude Release Agent protocol', () => {
  const cleanup: string[] = [];
  const timers: NodeJS.Timeout[] = [];

  afterEach(async () => {
    timers.splice(0).forEach(clearInterval);
    vi.doUnmock('node:os');
    vi.resetModules();
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  async function setup({ agentUp = true, elevated = true } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'claude-agent-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });

    const monitorHome = join(home, '.claude-monitor');
    await mkdir(join(monitorHome, 'requests'), { recursive: true });
    await mkdir(join(monitorHome, 'results'), { recursive: true });
    if (agentUp) {
      await writeFile(
        join(monitorHome, 'agent.json'),
        JSON.stringify({ pid: 1, elevated, updatedAt: Date.now() }),
      );
    }

    const handoff = await import('../../../src/commands/claude-handoff.js');
    const state = await import('../../../src/commands/claude-session-state.js');
    return { monitorHome, ...handoff, ...state };
  }

  /** Stand-in for Watch-ClaudeRelease.ps1: answer each request with `output`. */
  function fakeAgent(monitorHome: string, respond: (request: any) => string, seen: any[] = []) {
    const requests = join(monitorHome, 'requests');
    const timer = setInterval(async () => {
      for (const name of await readdir(requests).catch(() => [])) {
        if (!name.endsWith('.json')) continue;
        const path = join(requests, name);
        const request = JSON.parse(await readFile(path, 'utf8').catch(() => 'null'));
        if (!request) continue;
        await rm(path, { force: true });
        seen.push(request);
        await writeFile(
          join(monitorHome, 'results', `release-${request.requestId}.json`),
          JSON.stringify({ requestId: request.requestId, output: respond(request) }),
        );
      }
    }, 20);
    timers.push(timer);
    return seen;
  }

  it('reports the agent from its heartbeat, and treats a stale beat as down', async () => {
    const { readReleaseAgentStatus } = await setup({ agentUp: true, elevated: true });

    expect(readReleaseAgentStatus()).toEqual({ running: true, elevated: true });
    expect(readReleaseAgentStatus(Date.now() + 60_000)).toEqual({ running: false, elevated: false });
  });

  it('routes the release through the agent and parses its verdict', async () => {
    const { monitorHome, requestClaudeRelease } = await setup();
    const seen = fakeAgent(monitorHome, (r) => `OK|RELEASED|${r.sessionId}|25180`);

    const result = await requestClaudeRelease(SESSION, { timeoutMs: 5_000 });

    expect(result).toEqual({ ok: true, sessionId: SESSION, writerPid: 25180 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: SESSION });
    // The agent must refuse the request after the bridge stops waiting.
    expect(seen[0].expiresAt).toBeLessThan(Date.now() + 5_000);
    // Result files are consumed, not left to pile up.
    expect(await readdir(join(monitorHome, 'results'))).toEqual([]);
  });

  it('passes an agent refusal through unchanged', async () => {
    const { monitorHome, requestClaudeRelease } = await setup();
    fakeAgent(monitorHome, (r) => `ERROR|SESSION_NOT_IDLE|${r.sessionId}|3680|busy`);

    await expect(requestClaudeRelease(SESSION, { timeoutMs: 5_000 })).resolves.toEqual({
      ok: false,
      code: 'SESSION_NOT_IDLE',
      detail: `${SESSION}|3680|busy`,
    });
  });

  it('withdraws an unclaimed request on timeout so it cannot fire later', async () => {
    const { monitorHome, requestClaudeRelease } = await setup();

    const result = await requestClaudeRelease(SESSION, { timeoutMs: 400 });

    expect(result).toEqual({ ok: false, code: 'AGENT_TIMEOUT', detail: '' });
    expect(await readdir(join(monitorHome, 'requests'))).toEqual([]);
  });
});
