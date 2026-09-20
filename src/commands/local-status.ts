import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MONITOR_HOME = join(
  homedir(),
  '.codex-monitor',
);

interface LocalStatus {
  version?: number;
  sessionId?: string;
  cwd?: string;
  rolloutPath?: string;

  state?: string;
  lastActivity?: string;
  lastEventType?: string;
  lastEventTime?: string;

  observerPid?: number;
  observerState?: string;
  observerUpdatedAt?: string;
}

interface StatusEntry {
  fileName: string;
  status: LocalStatus;
  updatedAt: number;
}

function clean(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).replace(/`/g, "'");
}

function parseTime(value?: string): number {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();

  return Number.isNaN(time)
    ? 0
    : time;
}

function formatTime(value?: string): string {
  const time = parseTime(value);

  if (!time) {
    return '—';
  }

  return new Date(time).toLocaleString();
}

function formatAge(value?: string): string {
  const time = parseTime(value);

  if (!time) {
    return 'unknown';
  }

  const seconds = Math.max(
    0,
    Math.floor(
      (Date.now() - time) / 1000,
    ),
  );

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(
    seconds / 60,
  );

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(
    minutes / 60,
  );

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(
    hours / 24,
  );

  return `${days}d ago`;
}

function stateIcon(
  state?: string,
): string {
  switch (
    (state ?? '').toLowerCase()
  ) {
    case 'running':
      return '🔵';

    case 'waiting':
      return '🟢';

    case 'exited':
      return '⚫';

    default:
      return '⚪';
  }
}

function stateRank(
  state?: string,
): number {
  switch (
    (state ?? '').toLowerCase()
  ) {
    case 'running':
      return 0;

    case 'waiting':
      return 1;

    case 'exited':
      return 2;

    default:
      return 3;
  }
}

function observerText(
  status: LocalStatus,
): string {
  const state =
    status.observerState ??
    'Unknown';

  if (
    state.toLowerCase() ===
    'running'
  ) {
    return (
      `🟢 Running · heartbeat ` +
      formatAge(
        status.observerUpdatedAt,
      )
    );
  }

  if (
    state.toLowerCase() ===
    'stopped'
  ) {
    return '⚫ Stopped';
  }

  return state;
}

async function readStatuses():
Promise<StatusEntry[]> {
  let files;

  try {
    files = await readdir(
      MONITOR_HOME,
      {
        withFileTypes: true,
      },
    );
  }
  catch {
    return [];
  }

  const entries:
    StatusEntry[] = [];

  for (const file of files) {
    if (!file.isFile()) {
      continue;
    }

    if (
      !file.name.startsWith(
        'status-',
      ) ||
      !file.name.endsWith(
        '.json',
      )
    ) {
      continue;
    }

    const path = join(
      MONITOR_HOME,
      file.name,
    );

    try {
      let raw =
        await readFile(
          path,
          'utf8',
        );

      raw = raw
        .replace(/^\uFEFF/, '')
        .trim();

      if (!raw) {
        continue;
      }

      const status =
        JSON.parse(
          raw,
        ) as LocalStatus;

      if (!status.sessionId) {
        continue;
      }

      const updatedAt =
        Math.max(
          parseTime(
            status.observerUpdatedAt,
          ),
          parseTime(
            status.lastEventTime,
          ),
        );

      entries.push({
        fileName: file.name,
        status,
        updatedAt,
      });
    }
    catch {
      // Ignore broken or partially written
      // historical status files.
    }
  }

  entries.sort(
    (a, b) => {
      const rankDiff =
        stateRank(
          a.status.state,
        ) -
        stateRank(
          b.status.state,
        );

      if (rankDiff !== 0) {
        return rankDiff;
      }

      return (
        b.updatedAt -
        a.updatedAt
      );
    },
  );

  return entries;
}

function formatSummary(
  entries: StatusEntry[],
): string {
  if (entries.length === 0) {
    return [
      '🖥 **Windows Codex Sessions**',
      '',
      '当前没有找到本地 Codex monitor 状态。',
    ].join('\n');
  }

  const lines: string[] = [
    '🖥 **Windows Codex Sessions**',
    '',
    `发现 **${entries.length}** 个本地 Session：`,
    '',
  ];

  entries.forEach(
    (entry, index) => {
      const status =
        entry.status;

      const state =
        status.state ??
        'Unknown';

      lines.push(
        `${index + 1}. ` +
        `${stateIcon(state)} ` +
        `**${clean(state)}**`,
      );

      lines.push(
        `   🔗 \`${clean(
          status.sessionId,
        )}\``,
      );

      if (status.cwd) {
        lines.push(
          `   📁 \`${clean(
            status.cwd,
          )}\``,
        );
      }

      lines.push(
        `   👁 ${observerText(
          status,
        )}`,
      );

      if (
        status.lastActivity
      ) {
        lines.push(
          `   ⚙️ ${clean(
            status.lastActivity,
          )}`,
        );
      }

      lines.push('');
    },
  );

  lines.push(
    '查看某个 Session 的详细状态：',
  );

  lines.push('');

  lines.push(
    '`/local-status <Session-ID前缀>`',
  );

  return lines.join('\n');
}

function formatDetail(
  status: LocalStatus,
): string {
  const state =
    status.state ??
    'Unknown';

  const lines = [
    '🖥 **Windows Codex Session**',
    '',
    `${stateIcon(state)} **State:** ${clean(state)}`,
    '',
    `🔗 **Session:** \`${clean(
      status.sessionId,
    )}\``,
  ];

  if (status.cwd) {
    lines.push(
      '',
      `📁 **CWD:** \`${clean(
        status.cwd,
      )}\``,
    );
  }

  if (status.lastActivity) {
    lines.push(
      '',
      `⚙️ **Activity:** ${clean(
        status.lastActivity,
      )}`,
    );
  }

  lines.push(
    '',
    `👁 **Observer:** ${observerText(
      status,
    )}`,
  );

  if (status.observerPid) {
    lines.push(
      '',
      `🔧 **Observer PID:** \`${status.observerPid}\``,
    );
  }

  if (status.lastEventType) {
    lines.push(
      '',
      `📡 **Last event:** \`${clean(
        status.lastEventType,
      )}\``,
    );
  }

  if (status.lastEventTime) {
    lines.push(
      '',
      `🕒 **Last Codex event:** ${formatTime(
        status.lastEventTime,
      )}`,
    );
  }

  if (
    status.observerUpdatedAt
  ) {
    lines.push(
      '',
      `💓 **Observer updated:** ${formatTime(
        status.observerUpdatedAt,
      )}`,
    );
  }

  if (status.rolloutPath) {
    lines.push(
      '',
      `📄 **Rollout:** \`${clean(
        status.rolloutPath,
      )}\``,
    );
  }

  return lines.join('\n');
}

export async function handleLocalStatus(
  args: string,
): Promise<string> {
  const query =
    args.trim();

  const entries =
    await readStatuses();

  /*
   * No argument:
   *
   * /local-status
   *
   * Show all Sessions.
   *
   * "all" is an explicit alias:
   *
   * /local-status all
   */
  if (
    !query ||
    query.toLowerCase() ===
      'all'
  ) {
    return formatSummary(
      entries,
    );
  }

  const prefix =
    query.toLowerCase();

  const matches =
    entries.filter(
      (entry) =>
        entry.status.sessionId
          ?.toLowerCase()
          .startsWith(prefix),
    );

  if (matches.length === 0) {
    return [
      '❌ **没有找到对应的 Windows Codex Session。**',
      '',
      `Session 前缀：\`${clean(
        query,
      )}\``,
      '',
      '使用 `/local-status` 查看所有本地 Session。',
    ].join('\n');
  }

  if (matches.length > 1) {
    const lines = [
      '⚠️ **Session ID 前缀不唯一。**',
      '',
      '匹配到：',
      '',
    ];

    for (
      const match
      of matches
    ) {
      lines.push(
        `- \`${clean(
          match.status.sessionId,
        )}\` · ` +
        `${clean(
          match.status.state ??
          'Unknown',
        )}`,
      );
    }

    lines.push(
      '',
      '请提供更多位 Session ID。',
    );

    return lines.join('\n');
  }

  const match = matches[0];

  if (!match) {
    return [
      '❌ **没有找到对应的 Windows Codex Session。**',
      '',
      '使用 `/local-status` 查看所有本地 Session。',
    ].join('\n');
  }

  return formatDetail(
    match.status,
  );
}