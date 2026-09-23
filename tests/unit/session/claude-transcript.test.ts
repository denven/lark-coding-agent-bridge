import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLastClaudeResponse } from '../../../src/session/claude-transcript.js';

const SESSION_ID = '440a8200-5fe8-45a1-8355-14d2e6bd08d1';

function assistant(content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: '2026-09-22T09:10:23.561Z',
    message: { role: 'assistant', model: 'claude-opus-5', content },
    ...extra,
  });
}

function user(content: unknown): string {
  return JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content } });
}

describe('readLastClaudeResponse', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  async function transcript(lines: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'claude-transcript-'));
    cleanup.push(dir);
    const path = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
    return path;
  }

  it('returns only the text blocks of the last assistant message', async () => {
    const path = await transcript([
      user('first question'),
      assistant([{ type: 'text', text: 'old answer' }]),
      user('second question'),
      assistant([
        { type: 'thinking', thinking: 'private reasoning', signature: 'x' },
        { type: 'text', text: 'the real answer' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
      ]),
    ]);

    const response = await readLastClaudeResponse({ sessionId: SESSION_ID, transcriptPath: path });

    expect(response).toEqual({
      sessionId: SESSION_ID,
      text: 'the real answer',
      timestampMs: Date.parse('2026-09-22T09:10:23.561Z'),
      model: 'claude-opus-5',
      truncated: false,
    });
  });

  it('skips trailing tool-only assistant turns to reach the last visible reply', async () => {
    const path = await transcript([
      assistant([{ type: 'text', text: 'visible reply' }]),
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }]),
      assistant([{ type: 'thinking', thinking: 'still thinking', signature: 'x' }]),
    ]);

    const response = await readLastClaudeResponse({ sessionId: SESSION_ID, transcriptPath: path });

    expect(response?.text).toBe('visible reply');
  });

  it('ignores sidechain (subagent) assistant lines', async () => {
    const path = await transcript([
      assistant([{ type: 'text', text: 'main conversation reply' }]),
      assistant([{ type: 'text', text: 'subagent report' }], { isSidechain: true }),
    ]);

    const response = await readLastClaudeResponse({ sessionId: SESSION_ID, transcriptPath: path });

    expect(response?.text).toBe('main conversation reply');
  });

  it('accepts a bare string as message content', async () => {
    const path = await transcript([assistant('plain string reply')]);

    const response = await readLastClaudeResponse({ sessionId: SESSION_ID, transcriptPath: path });

    expect(response?.text).toBe('plain string reply');
  });

  it('keeps head and tail of a long reply and flags truncation', async () => {
    const long = `START ${'x'.repeat(4_000)} END`;
    const path = await transcript([assistant([{ type: 'text', text: long }])]);

    const response = await readLastClaudeResponse({
      sessionId: SESSION_ID,
      transcriptPath: path,
      maxChars: 1_000,
    });

    expect(response?.truncated).toBe(true);
    expect(response?.text.startsWith('START')).toBe(true);
    expect(response?.text.endsWith('END')).toBe(true);
    expect(response?.text).toContain('[response truncated for Lark]');
    expect(response!.text.length).toBeLessThanOrEqual(1_000);
  });

  it('returns undefined when there is no transcript or no visible reply', async () => {
    await expect(
      readLastClaudeResponse({ sessionId: SESSION_ID, transcriptPath: join(tmpdir(), 'missing.jsonl') }),
    ).resolves.toBeUndefined();

    const path = await transcript([user('only a question')]);
    await expect(
      readLastClaudeResponse({ sessionId: SESSION_ID, transcriptPath: path }),
    ).resolves.toBeUndefined();
  });
});
