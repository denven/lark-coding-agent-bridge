import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

const MONITOR_HOME = join(
  homedir(),
  '.codex-monitor',
);

const ACTIVE_HEARTBEAT_SECONDS = 30;
const RECENT_EXITED_LIMIT = 5;
const HISTORY_LIMIT = 20;

interface TokenUsage {
  total?: number | null;
  input?: number | null;
  cachedInput?: number | null;
  output?: number | null;
  reasoningOutput?: number | null;
}

interface ContextWindow {
  used?: number | null;
  total?: number | null;
  percentLeft?: number | null;
}

interface LocalStatus {
  version?: number;

  sessionId?: string;
  threadName?: string;
  threadNameUpdatedAt?: string;

  projectName?: string;
  cwd?: string;
  rolloutPath?: string;

  cliVersion?: string;

  model?: string;
  reasoningEffort?: string;
  modelProvider?: string;

  permissions?: string;
  approvalPolicy?: string;
  collaborationMode?: string;
  personality?: string;

  tokenUsage?: TokenUsage;
  contextWindow?: ContextWindow;

  state?: string;
  lastActivity?: string;
  lastEventType?: string;
  lastEventTime?: string;

  observerPid?: number;
  observerState?: string;
  observerStartedAt?: string;
  observerUpdatedAt?: string;
}

interface StatusEntry {
  fileName: string;
  status: LocalStatus;
  updatedAt: number;
}

function clean(value: unknown): string {
  if (
    value === undefined ||
    value === null
  ) {
    return '';
  }

  return String(value)
    .replace(/`/g, "'");
}

function parseTime(
  value?: string,
): number {
  if (!value) {
    return 0;
  }

  const time =
    new Date(value).getTime();

  return Number.isNaN(time)
    ? 0
    : time;
}

function formatTime(
  value?: string,
): string {
  const time =
    parseTime(value);

  if (!time) {
    return '—';
  }

  return new Date(
    time,
  ).toLocaleString();
}

function ageSeconds(
  value?: string,
): number | null {
  const time =
    parseTime(value);

  if (!time) {
    return null;
  }

  return Math.max(
    0,
    Math.floor(
      (Date.now() - time) / 1000,
    ),
  );
}

function formatAge(
  value?: string,
): string {
  const seconds =
    ageSeconds(value);

  if (seconds === null) {
    return 'unknown';
  }

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes =
    Math.floor(
      seconds / 60,
    );

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours =
    Math.floor(
      minutes / 60,
    );

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days =
    Math.floor(
      hours / 24,
    );

  return `${days}d ago`;
}

function stateIcon(
  state?: string,
): string {
  switch (
    (state ?? '')
      .toLowerCase()
  ) {
    case 'running':
      return '🔵';

    case 'waiting':
      return '🟢';

    case 'starting':
      return '🟡';

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
    (state ?? '')
      .toLowerCase()
  ) {
    case 'running':
      return 0;

    case 'waiting':
      return 1;

    case 'starting':
      return 2;

    case 'exited':
      return 9;

    default:
      return 5;
  }
}

function observerIsFresh(
  status: LocalStatus,
): boolean {
  if (
    (status.observerState ?? '')
      .toLowerCase() !==
    'running'
  ) {
    return false;
  }

  const age =
    ageSeconds(
      status.observerUpdatedAt,
    );

  return (
    age !== null &&
    age <= ACTIVE_HEARTBEAT_SECONDS
  );
}

function isActive(
  status: LocalStatus,
): boolean {
  if (
    (status.state ?? '')
      .toLowerCase() ===
    'exited'
  ) {
    return false;
  }

  return observerIsFresh(
    status,
  );
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
    const age =
      ageSeconds(
        status.observerUpdatedAt,
      );

    if (
      age !== null &&
      age >
        ACTIVE_HEARTBEAT_SECONDS
    ) {
      return (
        '🟠 Stale · heartbeat ' +
        formatAge(
          status.observerUpdatedAt,
        )
      );
    }

    return (
      '🟢 Running · heartbeat ' +
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

  return clean(state);
}

function projectName(
  status: LocalStatus,
): string {
  if (status.projectName) {
    return status.projectName;
  }

  if (status.cwd) {
    return win32.basename(
      status.cwd,
    );
  }

  return 'Unknown Project';
}

function shortSessionId(
  sessionId?: string,
): string {
  if (!sessionId) {
    return 'unknown';
  }

  if (sessionId.length <= 13) {
    return sessionId;
  }

  return (
    sessionId.slice(0, 13) +
    '…'
  );
}

function formatCompactNumber(
  value?: number | null,
): string {
  if (
    value === undefined ||
    value === null ||
    !Number.isFinite(value)
  ) {
    return '—';
  }

  const absolute =
    Math.abs(value);

  if (absolute >= 1000000) {
    return (
      `${Number(
        (value / 1000000)
          .toFixed(2),
      )}M`
    );
  }

  if (absolute >= 1000) {
    return (
      `${Number(
        (value / 1000)
          .toFixed(1),
      )}K`
    );
  }

  return String(
    Math.round(value),
  );
}

function modelSummary(
  status: LocalStatus,
): string | null {
  const parts: string[] = [];

  if (status.model) {
    parts.push(
      clean(status.model),
    );
  }

  if (status.reasoningEffort) {
    parts.push(
      clean(
        status.reasoningEffort,
      ),
    );
  }

  if (status.modelProvider) {
    parts.push(
      clean(
        status.modelProvider,
      ),
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' · ');
}

function contextSummary(
  status: LocalStatus,
): string | null {
  const context =
    status.contextWindow;

  if (!context) {
    return null;
  }

  const parts: string[] = [];

  if (
    context.percentLeft !==
      undefined &&
    context.percentLeft !== null
  ) {
    parts.push(
      `${Math.round(
        context.percentLeft,
      )}% left`,
    );
  }

  if (
    context.used !== undefined &&
    context.used !== null &&
    context.total !== undefined &&
    context.total !== null
  ) {
    parts.push(
      `${formatCompactNumber(
        context.used,
      )} / ${formatCompactNumber(
        context.total,
      )}`,
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' · ');
}

function tokenSummary(
  status: LocalStatus,
): string | null {
  const usage =
    status.tokenUsage;

  if (!usage) {
    return null;
  }

  const parts: string[] = [];

  if (
    usage.total !== undefined &&
    usage.total !== null
  ) {
    parts.push(
      `${formatCompactNumber(
        usage.total,
      )} total`,
    );
  }

  const io: string[] = [];

  if (
    usage.input !== undefined &&
    usage.input !== null
  ) {
    io.push(
      `${formatCompactNumber(
        usage.input,
      )} input`,
    );
  }

  if (
    usage.output !== undefined &&
    usage.output !== null
  ) {
    io.push(
      `${formatCompactNumber(
        usage.output,
      )} output`,
    );
  }

  if (io.length > 0) {
    parts.push(
      io.join(' + '),
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' · ');
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

    const path =
      join(
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
          parseTime(
            status.threadNameUpdatedAt,
          ),
        );

      entries.push({
        fileName: file.name,
        status,
        updatedAt,
      });
    }
    catch {
      // Ignore broken or partially
      // written historical files.
    }
  }

  entries.sort(
    (a, b) => {
      const aActive =
        isActive(a.status);

      const bActive =
        isActive(b.status);

      if (aActive !== bActive) {
        return aActive
          ? -1
          : 1;
      }

      const rankDifference =
        stateRank(
          a.status.state,
        ) -
        stateRank(
          b.status.state,
        );

      if (
        rankDifference !== 0
      ) {
        return rankDifference;
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
  title:
    | 'active'
    | 'all'
    | 'history',
): string {
  let heading =
    '🖥 **Windows Codex Sessions**';

  if (title === 'history') {
    heading =
      '🕘 **Windows Codex Session History**';
  }

  if (entries.length === 0) {
    if (title === 'active') {
      return [
        heading,
        '',
        '当前没有发现活跃的 Windows Codex Session。',
        '',
        '使用 `/local-status all` 查看最近的历史 Session。',
      ].join('\n');
    }

    return [
      heading,
      '',
      '没有找到对应的 Session。',
    ].join('\n');
  }

  const lines: string[] = [
    heading,
    '',
  ];

  if (title === 'active') {
    lines.push(
      `当前有 **${entries.length}** 个活跃 Session：`,
      '',
    );
  }
  else {
    lines.push(
      `显示 **${entries.length}** 个 Session：`,
      '',
    );
  }

  entries.forEach(
    (entry, index) => {
      const status =
        entry.status;

      const state =
        status.state ??
        'Unknown';

      const thread =
        status.threadName;

      lines.push(
        `${index + 1}. ` +
        `${stateIcon(state)} ` +
        `**${clean(state)}**`,
      );

      if (thread) {
        lines.push(
          `   🏷 **${clean(
            thread,
          )}**`,
        );
      }

      lines.push(
        `   📁 ${clean(
          projectName(status),
        )}`,
      );

      const model =
        modelSummary(status);

      if (model) {
        lines.push(
          `   🤖 ${model}`,
        );
      }

      const context =
        contextSummary(status);

      if (context) {
        lines.push(
          `   🧠 Context: ${context}`,
        );
      }

      lines.push(
        `   🔗 \`${clean(
          shortSessionId(
            status.sessionId,
          ),
        )}\``,
      );

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
    '查看详细状态：',
    '',
    '`/local-status <Thread名称或Session-ID前缀>`',
  );

  if (title === 'active') {
    lines.push(
      '',
      '查看最近历史： `/local-status all`',
    );
  }

  return lines.join('\n');
}

function formatDetail(
  status: LocalStatus,
): string {
  const state =
    status.state ??
    'Unknown';

  const lines: string[] = [
    '🖥 **Windows Codex Session**',
    '',
    `${stateIcon(state)} **State:** ${clean(
      state,
    )}`,
  ];

  if (status.threadName) {
    lines.push(
      '',
      `🏷 **Thread:** ${clean(
        status.threadName,
      )}`,
    );
  }

  lines.push(
    '',
    `📁 **Project:** ${clean(
      projectName(status),
    )}`,
  );

  if (status.cwd) {
    lines.push(
      `📂 **Directory:** \`${clean(
        status.cwd,
      )}\``,
    );
  }

  if (status.model) {
    lines.push(
      '',
      `🤖 **Model:** ${clean(
        status.model,
      )}`,
    );
  }

  if (status.reasoningEffort) {
    lines.push(
      `🧠 **Reasoning:** ${clean(
        status.reasoningEffort,
      )}`,
    );
  }

  if (status.modelProvider) {
    lines.push(
      `🔌 **Provider:** ${clean(
        status.modelProvider,
      )}`,
    );
  }

  if (status.cliVersion) {
    lines.push(
      `📦 **Codex:** v${clean(
        status.cliVersion,
      )}`,
    );
  }

  if (
    status.permissions ||
    status.approvalPolicy ||
    status.collaborationMode ||
    status.personality
  ) {
    lines.push('');
  }

  if (status.permissions) {
    lines.push(
      `🔐 **Permissions:** ${clean(
        status.permissions,
      )}`,
    );
  }

  if (status.approvalPolicy) {
    lines.push(
      `✅ **Approval:** ${clean(
        status.approvalPolicy,
      )}`,
    );
  }

  if (status.collaborationMode) {
    lines.push(
      `🤝 **Collaboration:** ${clean(
        status.collaborationMode,
      )}`,
    );
  }

  if (status.personality) {
    lines.push(
      `🎛 **Personality:** ${clean(
        status.personality,
      )}`,
    );
  }

  const tokens =
    tokenSummary(status);

  if (tokens) {
    lines.push(
      '',
      `📊 **Tokens:** ${tokens}`,
    );
  }

  const context =
    contextSummary(status);

  if (context) {
    lines.push(
      `🧠 **Context:** ${context}`,
    );
  }

  lines.push(
    '',
    `🔗 **Session:** \`${clean(
      status.sessionId,
    )}\``,
  );

  lines.push(
    '',
    `👁 **Observer:** ${observerText(
      status,
    )}`,
  );

  if (status.observerPid) {
    lines.push(
      `🔧 **Observer PID:** \`${status.observerPid}\``,
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

  if (status.lastEventType) {
    lines.push(
      `📡 **Last event:** \`${clean(
        status.lastEventType,
      )}\``,
    );
  }

  if (status.lastEventTime) {
    lines.push(
      `🕒 **Last Codex event:** ${formatTime(
        status.lastEventTime,
      )}`,
    );
  }

  if (
    status.observerUpdatedAt
  ) {
    lines.push(
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

function findMatches(
  entries: StatusEntry[],
  query: string,
): StatusEntry[] {
  const normalized =
    query.trim()
      .toLowerCase();

  if (!normalized) {
    return [];
  }

  // Exact match has highest priority.
  const exact =
    entries.filter(
      (entry) => {
        const status =
          entry.status;

        return (
          status.sessionId
            ?.toLowerCase() ===
            normalized ||
          status.threadName
            ?.toLowerCase() ===
            normalized ||
          projectName(status)
            .toLowerCase() ===
            normalized
        );
      },
    );

  if (exact.length > 0) {
    return exact;
  }

  // Then allow prefixes.
  return entries.filter(
    (entry) => {
      const status =
        entry.status;

      return (
        status.sessionId
          ?.toLowerCase()
          .startsWith(
            normalized,
          ) ||
        status.threadName
          ?.toLowerCase()
          .startsWith(
            normalized,
          ) ||
        projectName(status)
          .toLowerCase()
          .startsWith(
            normalized,
          )
      );
    },
  );
}

function formatAmbiguous(
  query: string,
  matches: StatusEntry[],
): string {
  const lines: string[] = [
    '⚠️ **匹配到多个 Windows Codex Session。**',
    '',
    `查询：\`${clean(
      query,
    )}\``,
    '',
  ];

  for (const entry of matches) {
    const status =
      entry.status;

    lines.push(
      `- ${stateIcon(
        status.state,
      )} ` +
      `${status.threadName
        ? `**${clean(
            status.threadName,
          )}** · `
        : ''}` +
      `${clean(
        projectName(status),
      )} · ` +
      `\`${clean(
        shortSessionId(
          status.sessionId,
        ),
      )}\``,
    );
  }

  lines.push(
    '',
    '请使用更完整的 Thread 名称或 Session ID 前缀。',
  );

  return lines.join('\n');
}

export async function handleLocalStatus(
  args: string,
): Promise<string> {
  const query =
    args.trim();

  const entries =
    await readStatuses();

  // ----------------------------------------------------------
  // /local-status
  //
  // Only active local Sessions.
  // Historical/stale status files are hidden.
  // ----------------------------------------------------------

  if (!query) {
    const active =
      entries.filter(
        (entry) =>
          isActive(
            entry.status,
          ),
      );

    return formatSummary(
      active,
      'active',
    );
  }

  // ----------------------------------------------------------
  // /local-status all
  //
  // Active Sessions + most recent historical Sessions.
  // ----------------------------------------------------------

  if (
    query.toLowerCase() ===
    'all'
  ) {
    const active =
      entries.filter(
        (entry) =>
          isActive(
            entry.status,
          ),
      );

    const historical =
      entries
        .filter(
          (entry) =>
            !isActive(
              entry.status,
            ),
        )
        .sort(
          (a, b) =>
            b.updatedAt -
            a.updatedAt,
        )
        .slice(
          0,
          RECENT_EXITED_LIMIT,
        );

    return formatSummary(
      [
        ...active,
        ...historical,
      ],
      'all',
    );
  }

  // ----------------------------------------------------------
  // /local-status history
  // ----------------------------------------------------------

  if (
    query.toLowerCase() ===
    'history'
  ) {
    const historical =
      entries
        .filter(
          (entry) =>
            !isActive(
              entry.status,
            ),
        )
        .sort(
          (a, b) =>
            b.updatedAt -
            a.updatedAt,
        )
        .slice(
          0,
          HISTORY_LIMIT,
        );

    return formatSummary(
      historical,
      'history',
    );
  }

  // ----------------------------------------------------------
  // Search by:
  //
  // Session ID
  // Session ID prefix
  // exact Thread name
  // Thread-name prefix
  // Project name
  // ----------------------------------------------------------

  const matches =
    findMatches(
      entries,
      query,
    );

  if (matches.length === 0) {
    return [
      '❌ **没有找到对应的 Windows Codex Session。**',
      '',
      `查询：\`${clean(
        query,
      )}\``,
      '',
      '使用 `/local-status` 查看当前活跃 Session。',
      '',
      '使用 `/local-status all` 查看最近历史 Session。',
    ].join('\n');
  }

  if (matches.length > 1) {
    return formatAmbiguous(
      query,
      matches,
    );
  }

  const match =
    matches[0];

  if (!match) {
    return [
      '❌ **没有找到对应的 Windows Codex Session。**',
      '',
      '使用 `/local-status` 查看当前活跃 Session。',
    ].join('\n');
  }

  return formatDetail(
    match.status,
  );
}