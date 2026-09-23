import { open, stat } from 'node:fs/promises';

const DEFAULT_MAX_CHARS = 5_000;
const INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

export interface ClaudeLastResponse {
  sessionId: string;
  text: string;
  timestampMs?: number;
  model?: string;
  truncated: boolean;
}

export interface ReadLastClaudeResponseOptions {
  sessionId: string;
  transcriptPath?: string;
  maxChars?: number;
}

interface Candidate {
  text: string;
  timestampMs?: number;
  model?: string;
}

/**
 * Read the most recent user-visible assistant response from a Claude Code
 * transcript (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`).
 *
 * This is the Claude counterpart of readLastCodexResponse() and carries the
 * same contract: display-only history that must never be injected back into
 * the model, because `claude --resume` already replays it from the same file.
 *
 * Thinking blocks, tool_use, tool_result and sidechain (subagent) lines are
 * intentionally skipped — only the `text` blocks of a main-conversation
 * assistant message are user-visible.
 */
export async function readLastClaudeResponse(
  options: ReadLastClaudeResponseOptions,
): Promise<ClaudeLastResponse | undefined> {
  const transcriptPath = options.transcriptPath?.trim();
  if (!transcriptPath) return undefined;

  let size: number;
  try {
    size = (await stat(transcriptPath)).size;
  } catch {
    return undefined;
  }

  if (size <= 0) return undefined;

  let windowBytes = Math.min(size, INITIAL_TAIL_BYTES);

  while (windowBytes > 0) {
    const start = Math.max(0, size - windowBytes);
    const text = await readWindow(transcriptPath, start, size - start);
    if (text === undefined) return undefined;

    const candidate = findLastVisibleResponse(text, start > 0);
    if (candidate) {
      const limited = limitText(candidate.text, options.maxChars ?? DEFAULT_MAX_CHARS);
      return {
        sessionId: options.sessionId,
        text: limited.text,
        ...(candidate.timestampMs !== undefined ? { timestampMs: candidate.timestampMs } : {}),
        ...(candidate.model ? { model: candidate.model } : {}),
        truncated: limited.truncated,
      };
    }

    if (start === 0 || windowBytes >= Math.min(size, MAX_TAIL_BYTES)) break;
    windowBytes = Math.min(size, Math.min(MAX_TAIL_BYTES, windowBytes * 2));
  }

  return undefined;
}

async function readWindow(
  path: string,
  start: number,
  length: number,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function findLastVisibleResponse(
  text: string,
  firstLineMayBePartial: boolean,
): Candidate | undefined {
  const lines = text.split(/\r?\n/);
  if (firstLineMayBePartial && lines.length > 0) lines.shift();

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;

    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record?.type !== 'assistant') continue;
    // Subagent transcripts are interleaved into the same file; their output is
    // not what the user saw as the session's reply.
    if (record?.isSidechain === true) continue;

    const message = record.message;
    if (!message || message.role !== 'assistant') continue;

    const responseText = extractAssistantText(message.content);
    if (!responseText) continue;

    return {
      text: responseText,
      timestampMs: parseTimestamp(record.timestamp),
      model: typeof message.model === 'string' ? message.model : undefined,
    };
  }

  return undefined;
}

function extractAssistantText(content: unknown): string | undefined {
  // Older/simpler records store a bare string instead of a content-block array.
  if (typeof content === 'string') {
    const text = content.trim();
    return text || undefined;
  }

  if (!Array.isArray(content)) return undefined;

  const parts = content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const value = item as Record<string, unknown>;
      // Only `text` is user-visible: `thinking` is private reasoning and
      // `tool_use` / `tool_result` are machine plumbing.
      if (value.type !== 'text') return '';
      return typeof value.text === 'string' ? value.text : '';
    })
    .filter((part) => part.trim().length > 0);

  const text = parts.join('\n').trim();
  return text || undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function limitText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const limit = Math.max(500, maxChars);

  if (normalized.length <= limit) {
    return { text: normalized, truncated: false };
  }

  // Keep both the opening context and the actual conclusion at the end.
  const marker = '\n\n… [response truncated for Lark] …\n\n';
  const available = Math.max(100, limit - marker.length);
  const head = Math.floor(available * 0.7);
  const tail = available - head;

  return {
    text: `${normalized.slice(0, head)}${marker}${normalized.slice(-tail)}`,
    truncated: true,
  };
}
