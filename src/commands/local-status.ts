import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from './index';

interface LocalMonitorStatus {
  version?: number;
  sessionId?: string;
  cwd?: string;

  state?: string;
  lastActivity?: string;
  lastEventType?: string;
  lastEventTime?: string;

  observerPid?: number;
  observerState?: string;
  observerUpdatedAt?: string;
}

interface MonitorEntry {
  path: string;
  status: LocalMonitorStatus;
  updatedMs: number;
}

const MONITOR_HOME = join(homedir(), '.codex-monitor');

function escapeMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(value: string): string {
  return value.replace(/`/g, "'");
}

function replyOptions(
  ctx: CommandContext,
): {
  replyTo: string;
  replyInThread?: true;
} {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId
      ? { replyInThread: true as const }
      : {}),
  };
}

async function reply(
  ctx: CommandContext,
  markdown: string,
): Promise<void> {
  await ctx.channel.send(
    ctx.msg.chatId,
    { markdown },
    replyOptions(ctx),
  );
}

function parseTime(value?: string): number {
  if (!value) return 0;

  const result = Date.parse(value);

  return Number.isFinite(result)
    ? result
    : 0;
}

function formatTime(value?: string): string {
  const ms = parseTime(value);

  if (!ms) return 'unknown';

  return new Date(ms).toLocaleString();
}

function stateIcon(state?: string): string {
  switch ((state ?? '').toLowerCase()) {
    case 'running':
      return '🔵';

    case 'waiting':
      return '✅';

    case 'interrupted':
      return '🔴';

    case 'exited':
      return '⚪';

    default:
      return '🟡';
  }
}

async function readMonitorEntries(): Promise<MonitorEntry[]> {
  let files: string[];

  try {
    files = await readdir(MONITOR_HOME);
  } catch (error) {
    console.error(
      `[local-status] Cannot read monitor directory ${MONITOR_HOME}:`,
      error,
    );

    return [];
  }

  const statusFiles = files.filter(
    (name) =>
      name.startsWith('status-') &&
      name.endsWith('.json'),
  );

  const entries = await Promise.all(
    statusFiles.map(async (name): Promise<MonitorEntry | undefined> => {
      const path = join(MONITOR_HOME, name);

      try {
        const raw = await readFile(path, 'utf8');

        // Windows PowerShell 5.x may write UTF-8 JSON with BOM.
        const cleanRaw = raw.replace(/^\uFEFF/, '').trim();

        const status =
          JSON.parse(cleanRaw) as LocalMonitorStatus;

        return {
          path,
          status,
          updatedMs: parseTime(status.observerUpdatedAt),
        };
      } catch (error) {
        console.error(
          `[local-status] Failed to read ${path}:`,
          error,
        );

        return undefined;
      }
    }),
  );

  return entries.filter(
    (entry): entry is MonitorEntry =>
      entry !== undefined,
  );
}

export async function handleLocalStatus(
  args: string,
  ctx: CommandContext,
): Promise<void> {
  const query = args.trim().toLowerCase();

  let entries =
    await readMonitorEntries();

  if (entries.length === 0) {
    await reply(
      ctx,
      [
        '⚠️ **没有发现 Windows Codex Observer 状态。**',
        '',
        `监控目录：\`${escapeCode(MONITOR_HOME)}\``,
        '',
        '请确认 `Watch-CodexSession.ps1` 正在运行。',
      ].join('\n'),
    );

    return;
  }

  if (query) {
    entries = entries.filter((entry) => {
      const sessionId =
        entry.status.sessionId ??
        '';

      return sessionId
        .toLowerCase()
        .startsWith(query);
    });

    if (entries.length === 0) {
      await reply(
        ctx,
        `未找到 Session：\`${escapeCode(args.trim())}\``,
      );

      return;
    }
  }

  entries.sort(
    (a, b) =>
      b.updatedMs - a.updatedMs,
  );

  const selected = entries[0];

  if (!selected) {
    await reply(
      ctx,
      '未找到可用的 Windows Codex Session 状态。',
    );

    return;
  }

  const status = selected.status;

  const now = Date.now();

  const heartbeatAgeSeconds =
    selected.updatedMs > 0
      ? Math.max(
          0,
          Math.floor(
            (now - selected.updatedMs) / 1000,
          ),
        )
      : undefined;

  const observerFresh =
    status.observerState === 'Running' &&
    heartbeatAgeSeconds !== undefined &&
    heartbeatAgeSeconds <= 20;

  const observerText =
    observerFresh
      ? `🟢 Running · heartbeat ${heartbeatAgeSeconds}s ago`
      : status.observerState === 'Running'
        ? `🟠 stale · last heartbeat ${
            heartbeatAgeSeconds ?? '?'
          }s ago`
        : `⚪ ${
            status.observerState ??
            'Unknown'
          }`;

  const sessionId =
    status.sessionId ??
    'unknown';

  const shortSession =
    sessionId.length > 12
      ? `${sessionId.slice(0, 12)}…`
      : sessionId;

  const state =
    status.state ??
    'Unknown';

  const activity =
    status.lastActivity ??
    'Unknown';

  const cwd =
    status.cwd ??
    'Unknown';

  const lines = [
    '🖥 **Windows Codex Session**',
    '',
    `${stateIcon(state)} **State:** ${escapeMd(state)}`,
    `🔗 **Session:** \`${escapeCode(shortSession)}\``,
    `📁 **CWD:** \`${escapeCode(cwd)}\``,
    `⚙️ **Activity:** ${escapeMd(activity)}`,
    `👁 **Observer:** ${escapeMd(observerText)}`,
    `🕒 **Last Codex event:** ${escapeMd(
      formatTime(status.lastEventTime),
    )}`,
    `💓 **Observer updated:** ${escapeMd(
      formatTime(status.observerUpdatedAt),
    )}`,
  ];

  if (!query && entries.length > 1) {
    lines.push(
      '',
      `发现 ${entries.length} 个 monitor 状态文件。`,
      '当前显示最近更新的一个。',
      '',
      '可使用：',
      '`/local-status <Session-ID前几位>`',
    );
  }

  await reply(
    ctx,
    lines.join('\n'),
  );
}