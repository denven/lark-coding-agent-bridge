import type { AgentKind } from '../config/profile-schema.js';
import { readLastCodexResponse } from '../session/codex-transcript.js';
import { readLastClaudeResponse } from '../session/claude-transcript.js';
import { buildClaudeInventory, hydrateClaudeItem } from './claude-session-state.js';
import {
  buildSessionInventory,
  hydrateInventoryItem,
  type SessionInventory,
  type SessionInventoryItem,
} from './local-session-state.js';

/** Agent-neutral shape of "the last thing the user saw this Session say". */
export interface ProviderLastResponse {
  sessionId: string;
  text: string;
  timestampMs?: number;
  truncated: boolean;
}

/**
 * Everything the Session control plane needs to know about one agent kind.
 *
 * SessionInventoryItem / HandoffState / LarkBinding are already agent-neutral
 * shapes; only the code that *fills* them was ever Codex-specific. This
 * interface is that seam, so /session list, tail, use and handoff can be
 * written once against both Codex and Claude Code.
 */
export interface SessionProvider {
  readonly agentKind: AgentKind;
  /** Short name used in card titles and messages, e.g. "Codex". */
  readonly label: string;
  /** Legacy command token for this agent, accepted and ignored in args. */
  readonly token: string;
  /**
   * Whether Windows → Lark handoff (releasing a running Windows writer) is
   * implemented. When false, Windows-active Sessions get neither a Handoff tab
   * entry nor a Handoff button, keeping the two in agreement.
   */
  readonly supportsHandoff: boolean;

  buildInventory(): SessionInventory;
  hydrate(item: SessionInventoryItem): SessionInventoryItem;
  readLastResponse(
    item: SessionInventoryItem,
    maxChars: number,
  ): Promise<ProviderLastResponse | undefined>;
  /** What to type on Windows to pick this Session back up. */
  resumeHint(sessionId: string): string;
}

const codexProvider: SessionProvider = {
  agentKind: 'codex',
  label: 'Codex',
  token: 'codex',
  supportsHandoff: true,

  buildInventory: () => buildSessionInventory(),
  hydrate: (item) => hydrateInventoryItem(item),

  readLastResponse: async (item, maxChars) => {
    const rolloutPath = item.rolloutPath ?? item.status?.rolloutPath;
    if (!rolloutPath) return undefined;

    const response = await readLastCodexResponse({
      sessionId: item.sessionId,
      rolloutPath,
      maxChars,
    });
    if (!response) return undefined;

    return {
      sessionId: response.sessionId,
      text: response.text,
      ...(response.timestampMs !== undefined ? { timestampMs: response.timestampMs } : {}),
      truncated: response.truncated,
    };
  },

  resumeHint: (sessionId) => `codex3 resume ${sessionId}`,
};

const claudeProvider: SessionProvider = {
  agentKind: 'claude',
  label: 'Claude Code',
  token: 'claude',
  supportsHandoff: true,

  buildInventory: () => buildClaudeInventory(),
  hydrate: (item) => hydrateClaudeItem(item),

  readLastResponse: async (item, maxChars) => {
    const transcriptPath = item.rolloutPath;
    if (!transcriptPath) return undefined;

    const response = await readLastClaudeResponse({
      sessionId: item.sessionId,
      transcriptPath,
      maxChars,
    });
    if (!response) return undefined;

    return {
      sessionId: response.sessionId,
      text: response.text,
      ...(response.timestampMs !== undefined ? { timestampMs: response.timestampMs } : {}),
      truncated: response.truncated,
    };
  },

  resumeHint: (sessionId) => `claude --resume ${sessionId}`,
};

const AGENT_TOKENS = new Set([codexProvider.token, claudeProvider.token]);

export function providerFor(agentKind: AgentKind | undefined): SessionProvider {
  return agentKind === 'claude' ? claudeProvider : codexProvider;
}

/** The provider for the agent this scope's profile drives. */
export function scopeProvider(ctx: any): SessionProvider {
  return providerFor(contextAgentKind(ctx));
}

/**
 * Drop `codex` / `claude` tokens from command arguments.
 *
 * A profile drives exactly one agent, so the scope's own kind always applies
 * and there is nothing for such a token to select. They are still accepted —
 * and ignored — so commands typed that way, and card buttons already posted
 * with the token in their payload, keep working.
 *
 * `leadingOnly` is for selector commands: only a first token is dropped, and
 * only when more follows, so a Session actually titled "claude" still resolves.
 */
export function withoutAgentTokens(
  args: string,
  { leadingOnly = false }: { leadingOnly?: boolean } = {},
): string {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const isAgent = (token: string) => AGENT_TOKENS.has(token.toLowerCase());

  if (leadingOnly) {
    return tokens.length > 1 && isAgent(tokens[0]!)
      ? tokens.slice(1).join(' ')
      : tokens.join(' ');
  }

  return tokens.filter((token) => !isAgent(token)).join(' ');
}

/**
 * The agent kind this Lark scope drives.
 *
 * A profile carries exactly one agentKind and createRuntimeAgent() builds one
 * adapter from it, so every control-plane command works on that kind only.
 */
export function contextAgentKind(ctx: any): AgentKind {
  const fromProfile = ctx?.controls?.profileConfig?.agentKind;
  if (fromProfile === 'claude' || fromProfile === 'codex') return fromProfile;

  return ctx?.agent?.id === 'claude' ? 'claude' : 'codex';
}
