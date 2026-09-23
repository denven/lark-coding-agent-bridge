import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity.js';
import type { AgentKind } from '../config/profile-schema.js';
import type { SessionCatalogIdentity } from '../session/catalog.js';

/*
 * How a Lark scope comes to "own" a Session, for the control-plane commands.
 *
 * run-flow.ts resolves what to resume in this order:
 *   1. sessionCatalog.activeFor(scope, agent, cwdRealpath, policyFingerprint)
 *   2. Claude only: sessions.resumeFor(scope, cwdRealpath)
 *
 * So writing sessions.json alone is not a binding. For Codex it is ignored
 * outright; for Claude any active catalog entry for the same scope and cwd
 * silently wins. These helpers write both stores, mirroring upstream's
 * applyResume() (bind) and /new (unbind).
 */

/**
 * Catalog identity for the scope's cwd *as it is now*.
 *
 * ctx.sessionCatalogIdentity was computed before the command ran, so it is
 * stale as soon as a command switches the scope's cwd — and both cwdRealpath
 * and policyFingerprint (which hashes cwdRealpath) are part of the catalog key.
 *
 * The access decision passed here is synthetic but not a bypass:
 * ctx.sessionCatalogIdentity only exists if the real decision was allowed
 * (commandSessionCatalogIdentity returns undefined otherwise), and for IM
 * scopes the decision only gates evaluation; it never enters the fingerprint.
 */
async function identityForCurrentCwd(ctx: any): Promise<SessionCatalogIdentity | undefined> {
  if (!ctx.sessionCatalog || !ctx.sessionCatalogIdentity) return undefined;

  return commandSessionCatalogIdentity({
    msg: ctx.msg,
    scope: ctx.scope,
    mode: ctx.chatMode,
    workspaces: ctx.workspaces,
    controls: ctx.controls,
    access: { ok: true, reason: 'allowed-chat' },
  });
}

async function flushAll(ctx: any): Promise<void> {
  await Promise.all([
    typeof ctx.workspaces?.flush === 'function' ? ctx.workspaces.flush() : undefined,
    typeof ctx.sessions?.flush === 'function' ? ctx.sessions.flush() : undefined,
    typeof ctx.sessionCatalog?.flush === 'function' ? ctx.sessionCatalog.flush() : undefined,
  ]);
}

export interface BindResult {
  /** False when no catalog is configured, so resume relies on sessions.json. */
  catalogBound: boolean;
}

/**
 * Make the next message in this scope resume `sessionId` in `cwd`.
 *
 * Callers must already have checked that `agentKind` matches the scope's own
 * agent; the catalog would otherwise record an id the adapter cannot resume.
 */
export async function bindScopeToSession(
  ctx: any,
  agentKind: AgentKind,
  sessionId: string,
  cwd: string,
): Promise<BindResult> {
  ctx.workspaces.setCwd(ctx.scope, cwd);

  const identity = await identityForCurrentCwd(ctx);

  if (identity) {
    if (identity.agentId !== agentKind) {
      throw new Error(
        `refusing to bind a ${agentKind} Session into a ${identity.agentId} scope`,
      );
    }

    ctx.sessionCatalog.upsertActive(
      agentKind === 'codex'
        ? { ...identity, threadId: sessionId }
        : { ...identity, sessionId },
    );
  }

  /*
   * Kept for both agents: listLarkBindings() reads sessions.json to show which
   * scope owns which Session. Store the realpath, because Claude's fallback
   * resumeFor() compares against it and the transcript's own cwd spelling may
   * differ in case.
   */
  ctx.sessions.set(ctx.scope, sessionId, identity?.cwdRealpath ?? cwd);

  await flushAll(ctx);
  return { catalogBound: Boolean(identity) };
}

/**
 * Stop this scope from resuming its bound Session.
 *
 * Archiving the catalog entry is what actually matters: without it, the next
 * message would resume the Session from the catalog even though sessions.json
 * was cleared — two writers on one Session after a handback.
 */
export async function unbindScope(ctx: any): Promise<void> {
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    ctx.sessionCatalog.archiveActive({
      ...ctx.sessionCatalogIdentity,
      now: Date.now(),
    });
  }

  ctx.sessions.clear(ctx.scope);

  await flushAll(ctx);
}
