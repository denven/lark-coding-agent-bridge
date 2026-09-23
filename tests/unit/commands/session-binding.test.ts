import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';

/*
 * The real identity builder evaluates the full run policy. Replace it with one
 * that keeps the property that matters: both cwdRealpath and the fingerprint
 * change with the scope's cwd, exactly as policyFingerprint() hashes the cwd.
 */
vi.mock('../../../src/bot/session-catalog-identity.js', () => ({
  commandSessionCatalogIdentity: async (input: any) => identityFor(
    input.scope,
    input.controls.profileConfig.agentKind,
    input.workspaces.cwdFor(input.scope),
  ),
}));

const { bindScopeToSession, unbindScope } = await import(
  '../../../src/commands/session-binding.js'
);

const SCOPE = 'oc_group';
const OLD_CWD = 'E:\\old';
const NEW_CWD = 'E:\\AI_Tools\\lark-sessions';

function identityFor(scopeId: string, agentId: 'claude' | 'codex', cwd: string): SessionCatalogIdentity {
  return { scopeId, agentId, cwdRealpath: cwd, policyFingerprint: `fp:${cwd}` };
}

describe('session binding', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  async function context(agentKind: 'claude' | 'codex', { catalog = true } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'session-binding-'));
    cleanup.push(dir);

    const cwds = new Map<string, string>([[SCOPE, OLD_CWD]]);
    const sessions = new SessionStore(join(dir, 'sessions.json'));
    const sessionCatalog = catalog ? new SessionCatalog(join(dir, 'catalog.json')) : undefined;

    const ctx = {
      scope: SCOPE,
      chatMode: 'group',
      msg: { chatId: SCOPE, senderId: 'ou_user', messageId: 'om_1' },
      controls: { profileConfig: { agentKind } },
      workspaces: {
        cwdFor: (scope: string) => cwds.get(scope),
        setCwd: (scope: string, cwd: string) => cwds.set(scope, cwd),
        flush: async () => {},
      },
      sessions,
      sessionCatalog,
      // Computed before the command ran, i.e. for the scope's *old* cwd.
      ...(catalog ? { sessionCatalogIdentity: identityFor(SCOPE, agentKind, OLD_CWD) } : {}),
    };

    return { ctx, sessions, sessionCatalog: sessionCatalog!, cwds };
  }

  it('binds Codex through the catalog under the new cwd, which is all run-flow reads', async () => {
    const { ctx, sessionCatalog, cwds } = await context('codex');

    const result = await bindScopeToSession(ctx, 'codex', 'thread-new', NEW_CWD);

    expect(result.catalogBound).toBe(true);
    expect(cwds.get(SCOPE)).toBe(NEW_CWD);
    // run-flow's lookup, keyed by the cwd the next run will actually use:
    expect(sessionCatalog.activeFor(identityFor(SCOPE, 'codex', NEW_CWD))?.threadId).toBe(
      'thread-new',
    );
    // Writing under the stale pre-command identity would never be found.
    expect(sessionCatalog.activeFor(identityFor(SCOPE, 'codex', OLD_CWD))).toBeUndefined();
  });

  it('makes a Claude binding win over a stale active catalog entry', async () => {
    const { ctx, sessions, sessionCatalog } = await context('claude');
    const newIdentity = identityFor(SCOPE, 'claude', NEW_CWD);
    // An earlier run in this scope and cwd left an active entry behind.
    sessionCatalog.upsertActive({ ...newIdentity, sessionId: 'stale-session' });

    await bindScopeToSession(ctx, 'claude', 'wanted-session', NEW_CWD);

    // Catalog first, then the sessions.json fallback — both must agree.
    expect(sessionCatalog.activeFor(newIdentity)?.sessionId).toBe('wanted-session');
    expect(sessions.resumeFor(SCOPE, NEW_CWD)).toBe('wanted-session');
  });

  it('refuses to bind a Session of the other agent kind', async () => {
    const { ctx, sessions, sessionCatalog } = await context('codex');

    await expect(bindScopeToSession(ctx, 'claude', 'claude-session', NEW_CWD)).rejects.toThrow(
      /claude Session into a codex scope/,
    );
    expect(sessionCatalog.entries()).toEqual([]);
    expect(sessions.getRaw(SCOPE)).toBeUndefined();
  });

  it('archives the catalog entry on unbind so the scope stops resuming it', async () => {
    const { ctx, sessions, sessionCatalog } = await context('claude');
    await bindScopeToSession(ctx, 'claude', 'bound-session', NEW_CWD);

    // A later /session handback computes its identity from the bound cwd.
    const boundIdentity = identityFor(SCOPE, 'claude', NEW_CWD);
    await unbindScope({ ...ctx, sessionCatalogIdentity: boundIdentity });

    expect(sessionCatalog.activeFor(boundIdentity)).toBeUndefined();
    expect(sessions.getRaw(SCOPE)).toBeUndefined();
    expect(sessions.resumeFor(SCOPE, NEW_CWD)).toBeUndefined();
  });

  it('reports an unbound catalog when none is configured', async () => {
    const { ctx, sessions } = await context('claude', { catalog: false });

    const result = await bindScopeToSession(ctx, 'claude', 'solo-session', NEW_CWD);

    expect(result.catalogBound).toBe(false);
    expect(sessions.resumeFor(SCOPE, NEW_CWD)).toBe('solo-session');
  });
});
