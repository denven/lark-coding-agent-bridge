import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SESSION = '01a0bdff-d7aa-71d2-adbd-d9e2cc03e9fd';
const WRITER_PID = 14800;

describe('Codex handoff state', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('node:os');
    vi.resetModules();
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  /**
   * A launch mapping plus a fresh Observer heartbeat reporting "Waiting".
   * `writer` decides what probing the recorded Codex PID returns;
   * `mapping` can drop the mapping or its Release Agent.
   */
  async function stateWith(
    writer: 'alive' | 'gone' | 'denied',
    mapping: 'full' | 'none' | 'no-release-agent' = 'full',
  ) {
    const home = await mkdtemp(join(tmpdir(), 'codex-handoff-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });

    const launches = join(home, '.codex-monitor', 'launches');
    await mkdir(launches, { recursive: true });
    if (mapping !== 'none') {
      await writeFile(
        join(launches, 'launch-1.json'),
        JSON.stringify({
          launchId: 'launch-1',
          sessionId: SESSION,
          codexRootPid: WRITER_PID,
          observerPid: 24300,
          ...(mapping === 'full' ? { releaseAgentPid: 22748 } : {}),
          attachedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
    }

    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === WRITER_PID && writer === 'alive') return true;
      const code = pid === WRITER_PID && writer === 'denied' ? 'EPERM' : 'ESRCH';
      throw Object.assign(new Error(code), { code });
    }) as typeof process.kill);

    const { getHandoffState } = await import('../../../src/commands/local-session-state.js');
    return getHandoffState({
      sessionId: SESSION,
      state: 'Waiting',
      observerState: 'Running',
      observerUpdatedAt: new Date().toISOString(),
    });
  }

  it('offers no handoff when the recorded Codex is gone but a stale Observer heartbeats', async () => {
    expect(await stateWith('gone')).toMatchObject({
      code: 'needs-validation',
      // Still blocks /session use: a new unattached codex3 run could be
      // writing this Session while the stale Observer holds its claim.
      windowsActive: true,
      transferable: false,
      reason: 'Codex exited; stale Observer (pid 24300) still running',
    });
  });

  it('stays ready while the recorded Codex is alive', async () => {
    expect(await stateWith('alive')).toMatchObject({ code: 'ready', windowsActive: true });
  });

  it('offers no handoff for a Codex that codex3 never attached (no launch mapping)', async () => {
    // Codex Release Agents are per Session: none exists for it, and
    // Release-CodexSession.ps1 refuses with LAUNCH_MAPPING_NOT_FOUND.
    expect(await stateWith('alive', 'none')).toMatchObject({
      code: 'needs-validation',
      windowsActive: true,
      transferable: false,
      reason: 'Launch mapping unavailable',
    });
  });

  it('offers no handoff when the mapping recorded no Release Agent', async () => {
    expect(await stateWith('alive', 'no-release-agent')).toMatchObject({
      code: 'needs-validation',
      transferable: false,
      reason: 'Release Agent not recorded',
    });
  });

  it('does not mistake an elevated Codex (EPERM) for an exited one', async () => {
    const state = await stateWith('denied');
    expect(state.transferable).toBeUndefined();
    expect(state.code).toBe('ready');
  });
});
