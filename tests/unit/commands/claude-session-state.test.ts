import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** A PID that cannot be alive, so its registry entry must be treated as stale. */
const DEAD_PID = 0x7ffffffc;

describe('Claude session inventory', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.doUnmock('node:os');
    vi.resetModules();
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  async function withHome() {
    const home = await mkdtemp(join(tmpdir(), 'claude-inventory-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const mod = await import('../../../src/commands/claude-session-state.js');
    return { home, ...mod };
  }

  async function writeTranscript(
    home: string,
    projectDir: string,
    sessionId: string,
    lines: object[],
    mtime: string,
  ): Promise<string> {
    const dir = join(home, '.claude', 'projects', projectDir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    await utimes(path, new Date(mtime), new Date(mtime));
    return path;
  }

  async function writeRegistry(home: string, entry: Record<string, unknown>): Promise<void> {
    const dir = join(home, '.claude', 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${entry.pid}.json`), JSON.stringify(entry), 'utf8');
  }

  it('lists transcripts newest first and ignores non-session files', async () => {
    const { home, buildClaudeInventory } = await withHome();

    await writeTranscript(home, 'E--older', A, [{ type: 'user' }], '2026-01-01T00:00:00Z');
    await writeTranscript(home, 'E--newer', B, [{ type: 'user' }], '2026-02-01T00:00:00Z');
    // Neither a UUID transcript nor the same-named sidecar dir is a session.
    await writeFile(join(home, '.claude', 'projects', 'E--older', 'notes.jsonl'), '{}\n');
    await mkdir(join(home, '.claude', 'projects', 'E--older', A), { recursive: true });

    const { items } = buildClaudeInventory();

    expect(items.map((item) => item.sessionId)).toEqual([B, A]);
    expect(items.every((item) => item.handoff.code === 'detached')).toBe(true);
  });

  it('reads cwd from transcript contents, not the lossy project directory name', async () => {
    const { home, buildClaudeInventory, hydrateClaudeItem } = await withHome();

    // `E:\AI_Tools\lark-sessions` encodes to this name; naively decoding the
    // hyphens would yield `E:\AI\Tools\lark\sessions`.
    await writeTranscript(
      home,
      'E--AI-Tools-lark-sessions',
      A,
      [{ type: 'user', cwd: 'E:\\AI_Tools\\lark-sessions', message: { content: 'hi' } }],
      '2026-01-01T00:00:00Z',
    );

    const [item] = buildClaudeInventory().items.map(hydrateClaudeItem);

    expect(item?.cwd).toBe('E:\\AI_Tools\\lark-sessions');
    expect(item?.projectName).toBe('lark-sessions');
  });

  it('prefers custom title, then the latest ai-title, then the first prompt', async () => {
    const { home, buildClaudeInventory, hydrateClaudeItem } = await withHome();

    const prompt = { type: 'user', cwd: 'E:\\p', message: { content: 'first prompt text' } };

    // Session A: only a prompt.
    await writeTranscript(home, 'E--p', A, [prompt], '2026-01-01T00:00:00Z');
    // Session B: ai-title rewritten twice, plus a custom title sidecar.
    const bPath = await writeTranscript(
      home,
      'E--p',
      B,
      [prompt, { type: 'ai-title', aiTitle: 'Early title' }, { type: 'ai-title', aiTitle: 'Final title' }],
      '2026-02-01T00:00:00Z',
    );

    let byId = new Map(buildClaudeInventory().items.map((item) => [item.sessionId, hydrateClaudeItem(item)]));
    expect(byId.get(A)?.threadName).toBe('first prompt text');
    expect(byId.get(B)?.threadName).toBe('Final title');

    const sidecar = bPath.replace(/\.jsonl$/, '');
    await mkdir(sidecar, { recursive: true });
    await writeFile(join(sidecar, 'custom-title.json'), JSON.stringify({ customTitle: 'My name' }));

    byId = new Map(buildClaudeInventory().items.map((item) => [item.sessionId, hydrateClaudeItem(item)]));
    expect(byId.get(B)?.threadName).toBe('My name');
  });

  it('titles a Lark-run session by what the user typed, not the bridge prompt wrapper', async () => {
    const { home, buildClaudeInventory, hydrateClaudeItem } = await withHome();
    const { buildAgentPrompt } = await import('../../../src/agent/prompt.js');

    const wrapped = buildAgentPrompt({
      context: { chatId: 'oc_secret', chatType: 'p2p', senderId: 'ou_secret', source: 'im' },
      instructions: ['internal bridge instruction'],
      userInput: '帮我看看登录页',
    });
    await writeTranscript(
      home,
      'E--p',
      A,
      [{ type: 'user', cwd: 'E:\\p', message: { content: wrapped } }],
      '2026-01-01T00:00:00Z',
    );

    const [item] = buildClaudeInventory().items.map(hydrateClaudeItem);

    expect(item?.threadName).toBe('帮我看看登录页');
  });

  it('marks a session Windows-active from a live registry entry and drops dead ones', async () => {
    const { home, buildClaudeInventory } = await withHome();

    await writeTranscript(home, 'E--p', A, [{ type: 'user' }], '2026-01-01T00:00:00Z');
    await writeTranscript(home, 'E--p', B, [{ type: 'user' }], '2026-01-01T00:00:00Z');

    await writeRegistry(home, {
      pid: process.pid,
      sessionId: A,
      cwd: 'E:\\live',
      name: 'Live session',
      status: 'busy',
      procStart: '134346208663956441',
      updatedAt: Date.now(),
    });
    // Left behind by a hard kill: the PID is gone, so B is not owned.
    await writeRegistry(home, {
      pid: DEAD_PID,
      sessionId: B,
      status: 'idle',
      procStart: '1',
      updatedAt: Date.now(),
    });

    const byId = new Map(buildClaudeInventory().items.map((item) => [item.sessionId, item]));

    expect(byId.get(A)?.handoff).toMatchObject({ code: 'busy', windowsActive: true });
    expect(byId.get(A)?.threadName).toBe('Live session');
    expect(byId.get(A)?.cwd).toBe('E:\\live');
    expect(byId.get(A)?.status?.state).toBe('Working');

    expect(byId.get(B)?.handoff).toMatchObject({ code: 'detached', windowsActive: false });
  });

  it('treats an elevated window the bridge cannot open (EPERM) as running, not detached', async () => {
    const { home, buildClaudeInventory } = await withHome();
    const ELEVATED_PID = 424242;

    await writeTranscript(home, 'E--p', A, [{ type: 'user' }], '2026-01-01T00:00:00Z');
    await writeRegistry(home, {
      pid: ELEVATED_PID,
      sessionId: A,
      entrypoint: 'cli',
      status: 'idle',
      procStart: '1',
      updatedAt: Date.now(),
    });

    // What a non-elevated bridge gets probing a "Run as administrator" process.
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === ELEVATED_PID) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as typeof process.kill);

    try {
      const [item] = buildClaudeInventory().items;
      expect(item?.handoff).toMatchObject({
        code: 'needs-validation',
        windowsActive: true,
        transferable: false,
        reason: 'Running as administrator — Claude release agent not running',
      });
    } finally {
      kill.mockRestore();
    }
  });

  it('lists a running window that has not been sent anything yet', async () => {
    const { home, buildClaudeInventory } = await withHome();

    // No transcript exists until the first prompt, only the registry entry.
    await writeRegistry(home, {
      pid: process.pid,
      sessionId: B,
      cwd: 'E:\\Coding',
      name: 'coding-34',
      entrypoint: 'cli',
      status: 'idle',
      procStart: '1',
      updatedAt: Date.now(),
    });

    const [item] = buildClaudeInventory().items;

    expect(item).toMatchObject({
      sessionId: B,
      threadName: 'coding-34',
      cwd: 'E:\\Coding',
      projectName: 'Coding',
      status: { state: 'Waiting' },
      handoff: {
        windowsActive: true,
        transferable: false,
        reason: 'No conversation yet',
      },
    });
    expect(item?.rolloutPath).toBeUndefined();
  });

  it('does not count a `claude -p` run as a Windows writer', async () => {
    const { home, buildClaudeInventory } = await withHome();

    await writeTranscript(home, 'E--p', A, [{ type: 'user' }], '2026-01-01T00:00:00Z');
    // What the Lark bridge's own run looks like: live, "interactive", sdk-cli.
    await writeRegistry(home, {
      pid: process.pid,
      sessionId: A,
      kind: 'interactive',
      entrypoint: 'sdk-cli',
      status: 'busy',
      procStart: '1',
      updatedAt: Date.now(),
    });

    const [item] = buildClaudeInventory().items;

    expect(item?.handoff).toMatchObject({ code: 'detached', windowsActive: false });
  });
});

describe('claudeHandoffState', () => {
  afterEach(() => {
    vi.resetModules();
  });

  async function state(entry: Record<string, unknown> | undefined) {
    const { claudeHandoffState } = await import('../../../src/commands/claude-session-state.js');
    return claudeHandoffState(entry as any);
  }

  const live = {
    pid: 1,
    sessionId: A,
    entrypoint: 'cli',
    status: 'idle',
    procStart: '134346208663956441',
    updatedAt: Date.now(),
  };

  it('is ready for an idle terminal session with a process identity', async () => {
    expect(await state(live)).toMatchObject({ code: 'ready', windowsActive: true });
  });

  it('stays ready when an idle entry has not been touched for minutes', async () => {
    // updatedAt only moves on activity, so an idle session looks "stale" by
    // design; treating that as unverified would make idle sessions — the
    // only ones safe to hand off — never ready.
    expect(await state({ ...live, updatedAt: Date.now() - 30 * 60_000 })).toMatchObject({
      code: 'ready',
    });
  });

  it('is busy while Claude is working', async () => {
    expect(await state({ ...live, status: 'busy' })).toMatchObject({ code: 'busy' });
  });

  it('never treats an unrecognised status as safe to interrupt', async () => {
    expect(await state({ ...live, status: 'compacting' })).toMatchObject({
      code: 'needs-validation',
      reason: 'Unknown status: compacting',
    });
  });

  it('needs validation outside a terminal window, where it cannot be auto-released', async () => {
    expect(await state({ ...live, entrypoint: 'claude-vscode' })).toMatchObject({
      code: 'needs-validation',
    });
  });

  it('blocks an elevated window unless an elevated release agent is up', async () => {
    const elevatedWindow = { ...live, accessDenied: true };
    expect(await state(elevatedWindow)).toMatchObject({
      code: 'needs-validation',
      transferable: false,
    });

    const { claudeHandoffState } = await import('../../../src/commands/claude-session-state.js');
    expect(claudeHandoffState(elevatedWindow as any, { elevatedAgent: true })).toMatchObject({
      code: 'ready',
    });
  });

  it('needs validation when procStart is missing, since the PID cannot be verified', async () => {
    const { procStart: _omit, ...withoutIdentity } = live;
    expect(await state(withoutIdentity)).toMatchObject({
      code: 'needs-validation',
      reason: 'Process identity unavailable',
    });
  });

  it('is detached with no registry entry', async () => {
    expect(await state(undefined)).toMatchObject({ code: 'detached', windowsActive: false });
  });
});

describe('processState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function probe(code: string | undefined) {
    const { processState } = await import('../../../src/commands/local-session-state.js');
    vi.spyOn(process, 'kill').mockImplementation((() => {
      if (code) throw Object.assign(new Error(code), { code });
      return true;
    }) as typeof process.kill);
    return processState(1234);
  }

  it('reads EPERM as a live process the caller may not open', async () => {
    expect(await probe('EPERM')).toBe('denied');
  });

  it('reads ESRCH as gone and success as alive', async () => {
    expect(await probe('ESRCH')).toBe('gone');
    expect(await probe(undefined)).toBe('alive');
  });
});
