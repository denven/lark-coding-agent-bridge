import { open, stat } from 'node:fs/promises';

const DEFAULT_MAX_CHARS = 5_000;
const INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

export interface CodexLastResponse {
  sessionId: string;
  text: string;
  timestampMs?: number;
  turnId?: string;
  source: 'task_complete' | 'response_item';
  truncated: boolean;
}

export interface ReadLastCodexResponseOptions {
  sessionId: string;
  rolloutPath?: string;
  maxChars?: number;
}

interface Candidate {
  text: string;
  timestampMs?: number;
  turnId?: string;
  source: CodexLastResponse['source'];
}

/**
 * Read the most recent user-visible assistant response from a Codex rollout.
 *
 * This is display-only history. It must never be injected back into the model:
 * the resumed Codex thread already contains this response in its own history.
 *
 * Private reasoning, tool calls, tool outputs and token-usage records are
 * intentionally ignored. Current Codex 0.155.x rollouts expose the completed
 * user-visible response both as event_msg/task_complete.last_agent_message and
 * as response_item/message(role=assistant, phase=final_answer). We prefer the
 * task_complete record and fall back to the final assistant message.
 */
export async function readLastCodexResponse(
  options: ReadLastCodexResponseOptions,
): Promise<CodexLastResponse | undefined> {
  const rolloutPath = options.rolloutPath?.trim();
  if (!rolloutPath) return undefined;

  let size: number;
  try {
    size = (await stat(rolloutPath)).size;
  } catch {
    return undefined;
  }

  if (size <= 0) return undefined;

  let windowBytes = Math.min(size, INITIAL_TAIL_BYTES);

  while (windowBytes > 0) {
    const start = Math.max(0, size - windowBytes);
    const text = await readWindow(rolloutPath, start, size - start);
    if (text === undefined) return undefined;

    const candidate = findLastVisibleResponse(text, start > 0);
    if (candidate) {
      const limited = limitText(candidate.text, options.maxChars ?? DEFAULT_MAX_CHARS);
      return {
        sessionId: options.sessionId,
        text: limited.text,
        ...(candidate.timestampMs !== undefined ? { timestampMs: candidate.timestampMs } : {}),
        ...(candidate.turnId ? { turnId: candidate.turnId } : {}),
        source: candidate.source,
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

function findLastVisibleResponse(text: string, firstLineMayBePartial: boolean): Candidate | undefined {
  const lines = text.split(/\r?\n/);
  if (firstLineMayBePartial && lines.length > 0) lines.shift();

  let finalMessageFallback: Candidate | undefined;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;

    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = record?.payload;

    if (
      record?.type === 'event_msg' &&
      payload?.type === 'task_complete' &&
      typeof payload.last_agent_message === 'string' &&
      payload.last_agent_message.trim()
    ) {
      return {
        text: payload.last_agent_message.trim(),
        timestampMs: parseTimestamp(record.timestamp),
        turnId: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
        source: 'task_complete',
      };
    }

    if (
      !finalMessageFallback &&
      record?.type === 'response_item' &&
      payload?.type === 'message' &&
      payload?.role === 'assistant' &&
      (payload?.phase === 'final_answer' || payload?.phase === undefined)
    ) {
      const responseText = extractAssistantText(payload.content);
      if (responseText) {
        finalMessageFallback = {
          text: responseText,
          timestampMs: parseTimestamp(record.timestamp),
          turnId: readTurnId(payload),
          source: 'response_item',
        };
      }
    }
  }

  return finalMessageFallback;
}

function extractAssistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;

  const parts = content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const value = item as Record<string, unknown>;
      if (value.type !== 'output_text') return '';
      return typeof value.text === 'string' ? value.text : '';
    })
    .filter((part) => part.trim().length > 0);

  const text = parts.join('\n').trim();
  return text || undefined;
}

function readTurnId(payload: any): string | undefined {
  const metadata = payload?.internal_chat_message_metadata_passthrough;
  return typeof metadata?.turn_id === 'string' ? metadata.turn_id : undefined;
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
