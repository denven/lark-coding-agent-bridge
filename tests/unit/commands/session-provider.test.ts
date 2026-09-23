import { describe, expect, it } from 'vitest';
import {
  providerFor,
  scopeProvider,
  withoutAgentTokens,
} from '../../../src/commands/session-provider.js';

describe('scopeProvider', () => {
  it('follows the profile agentKind, which a profile has exactly one of', () => {
    expect(scopeProvider({ controls: { profileConfig: { agentKind: 'claude' } } })).toBe(
      providerFor('claude'),
    );
    expect(scopeProvider({ controls: { profileConfig: { agentKind: 'codex' } } })).toBe(
      providerFor('codex'),
    );
  });
});

describe('withoutAgentTokens', () => {
  it('drops agent words anywhere in /session list arguments', () => {
    expect(withoutAgentTokens('claude handoff')).toBe('handoff');
    expect(withoutAgentTokens('handoff CODEX')).toBe('handoff');
    expect(withoutAgentTokens('claude')).toBe('');
    expect(withoutAgentTokens('booking platform')).toBe('booking platform');
  });

  it('drops only a leading agent word from a selector, keeping old card payloads working', () => {
    // What pre-simplification Last Response buttons carry.
    expect(
      withoutAgentTokens('claude 074f6f2e-e77b-4349-9a5b-7baed6a4c40e', { leadingOnly: true }),
    ).toBe('074f6f2e-e77b-4349-9a5b-7baed6a4c40e');
    expect(withoutAgentTokens('Web-Forms claude', { leadingOnly: true })).toBe('Web-Forms claude');
  });

  it('keeps a selector that is only the agent word, so a Session titled "claude" resolves', () => {
    expect(withoutAgentTokens('claude', { leadingOnly: true })).toBe('claude');
  });
});
