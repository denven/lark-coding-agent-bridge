import {
  formatHandoffState,
  getHandoffState,
  readMonitorStatuses,
  type LocalStatus,
} from './local-session-state.js';
import { actions, divMd, shell, type ButtonSpec } from '../card/templates.js';

const ACTIVE_HEARTBEAT_MS =
  45_000;

const DEFAULT_HISTORY_LIMIT =
  10;

function clean(
  value: unknown,
): string {
  if (
    value === undefined ||
    value === null
  ) {
    return '';
  }

  return String(value)
    .replace(
      /`/g,
      "'",
    );
}

function toTime(
  value: unknown,
): number {
  if (
    typeof value !== 'string' ||
    !value
  ) {
    return 0;
  }

  const parsed =
    Date.parse(value);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}

function statusTimestamp(
  status: LocalStatus,
): number {
  return Math.max(
    toTime(
      status.observerUpdatedAt,
    ),
    toTime(
      status.lastEventTime,
    ),
    toTime(
      status.threadNameUpdatedAt,
    ),
  );
}

function heartbeatAgeMs(
  status: LocalStatus,
): number | undefined {
  const time =
    toTime(
      status.observerUpdatedAt,
    );

  if (!time) {
    return undefined;
  }

  return Math.max(
    0,
    Date.now() -
      time,
  );
}

function formatDuration(
  milliseconds: number,
): string {
  const seconds =
    Math.max(
      0,
      Math.floor(
        milliseconds /
        1000,
      ),
    );

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes =
    Math.floor(
      seconds /
      60,
    );

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours =
    Math.floor(
      minutes /
      60,
    );

  if (hours < 24) {
    return `${hours}h`;
  }

  const days =
    Math.floor(
      hours /
      24,
    );

  return `${days}d`;
}

function formatHeartbeat(
  status: LocalStatus,
): string {
  if (
    !status.observerUpdatedAt
  ) {
    return 'unknown';
  }

  const age =
    heartbeatAgeMs(
      status,
    );

  if (
    age === undefined
  ) {
    return 'unknown';
  }

  return `${formatDuration(
    age,
  )} ago`;
}

function formatNumber(
  value: number,
): string {
  if (
    value >= 1_000_000
  ) {
    return `${(
      value /
      1_000_000
    ).toFixed(1)}M`;
  }

  if (
    value >= 1_000
  ) {
    return `${(
      value /
      1_000
    ).toFixed(1)}K`;
  }

  return String(
    value,
  );
}

function observerIsFresh(
  status: LocalStatus,
): boolean {
  if (
    status.observerState !==
    'Running'
  ) {
    return false;
  }

  const age =
    heartbeatAgeMs(
      status,
    );

  if (
    age === undefined
  ) {
    return false;
  }

  return (
    age <=
    ACTIVE_HEARTBEAT_MS
  );
}

function isActiveStatus(
  status: LocalStatus,
): boolean {
  /*
   * Primary signal:
   *
   * a live/fresh Observer means that the Windows
   * codex3 lifecycle is currently active.
   */
  if (
    observerIsFresh(
      status,
    )
  ) {
    return true;
  }

  /*
   * Older status schemas may not contain the
   * complete Observer metadata.
   *
   * Do not treat explicitly exited sessions
   * as active.
   */
  const observerState =
    String(
      status.observerState ??
      '',
    ).toLowerCase();

  const state =
    String(
      status.state ??
      '',
    ).toLowerCase();

  if (
    observerState ===
      'stopped' ||
    observerState ===
      'exited' ||
    state ===
      'exited' ||
    state ===
      'stopped'
  ) {
    return false;
  }

  return false;
}

function stateIcon(
  status: LocalStatus,
): string {
  const state =
    String(
      status.state ??
      '',
    ).toLowerCase();

  switch (state) {
    case 'waiting':
      return '🟢';

    case 'working':
    case 'running':
    case 'active':
      return '🔵';

    case 'error':
    case 'failed':
      return '🔴';

    case 'exited':
    case 'stopped':
      return '⚪';

    default:
      return '⚪';
  }
}

function displayState(
  status: LocalStatus,
): string {
  if (
    status.state
  ) {
    return status.state;
  }

  if (
    observerIsFresh(
      status,
    )
  ) {
    return 'Active';
  }

  return 'Unknown';
}

function formatModel(
  status: LocalStatus,
): string | undefined {
  const parts: string[] = [];

  if (
    status.model
  ) {
    parts.push(
      status.model,
    );
  }

  if (
    status.reasoningEffort
  ) {
    parts.push(
      status.reasoningEffort,
    );
  }

  if (
    status.modelProvider
  ) {
    parts.push(
      status.modelProvider,
    );
  }

  if (
    parts.length === 0
  ) {
    return undefined;
  }

  return parts.join(
    ' · ',
  );
}

function formatContext(
  status: LocalStatus,
): string | undefined {
  const context =
    status.contextWindow;

  if (!context) {
    return undefined;
  }

  const used =
    typeof context.used ===
      'number'
      ? context.used
      : undefined;

  const total =
    typeof context.total ===
      'number'
      ? context.total
      : undefined;

  const percentLeft =
    typeof context.percentLeft ===
      'number'
      ? context.percentLeft
      : undefined;

  const parts: string[] = [];

  if (
    percentLeft !== undefined
  ) {
    parts.push(
      `${percentLeft}% left`,
    );
  }

  if (
    used !== undefined &&
    total !== undefined
  ) {
    parts.push(
      `${formatNumber(
        used,
      )} / ${formatNumber(
        total,
      )}`,
    );
  }
  else if (
    used !== undefined
  ) {
    parts.push(
      `${formatNumber(
        used,
      )} used`,
    );
  }

  if (
    parts.length === 0
  ) {
    return undefined;
  }

  return parts.join(
    ' · ',
  );
}

function formatTokenUsage(
  status: LocalStatus,
): string | undefined {
  const usage =
    status.tokenUsage;

  if (!usage) {
    return undefined;
  }

  const parts: string[] = [];

  if (
    typeof usage.total ===
      'number'
  ) {
    parts.push(
      `Total ${formatNumber(
        usage.total,
      )}`,
    );
  }

  if (
    typeof usage.input ===
      'number'
  ) {
    parts.push(
      `In ${formatNumber(
        usage.input,
      )}`,
    );
  }

  if (
    typeof usage.output ===
      'number'
  ) {
    parts.push(
      `Out ${formatNumber(
        usage.output,
      )}`,
    );
  }

  if (
    parts.length === 0
  ) {
    return undefined;
  }

  return parts.join(
    ' · ',
  );
}

function shortSessionId(
  sessionId: string,
): string {
  if (
    sessionId.length <=
    16
  ) {
    return sessionId;
  }

  return `${sessionId.slice(
    0,
    12,
  )}…`;
}

function formatObserver(
  status: LocalStatus,
): string {
  const observerState =
    status.observerState ??
    'Unknown';

  const heartbeat =
    formatHeartbeat(
      status,
    );

  if (
    status.observerPid
  ) {
    return `${observerState} · PID ${status.observerPid} · heartbeat ${heartbeat}`;
  }

  return `${observerState} · heartbeat ${heartbeat}`;
}

function formatStatusCard(
  status: LocalStatus,
  index?: number,
): string {
  const lines: string[] = [];

  const state =
    displayState(
      status,
    );

  const prefix =
    index !== undefined
      ? `${index}. `
      : '';

  lines.push(
    `${prefix}${stateIcon(
      status,
    )} **${clean(
      state,
    )}**`,
  );

  if (
    status.threadName
  ) {
    lines.push(
      `   🏷 ${clean(
        status.threadName,
      )}`,
    );
  }

  if (
    status.projectName
  ) {
    lines.push(
      `   📁 ${clean(
        status.projectName,
      )}`,
    );
  }
  else if (
    status.cwd
  ) {
    lines.push(
      `   📂 ${clean(
        status.cwd,
      )}`,
    );
  }

  const model =
    formatModel(
      status,
    );

  if (model) {
    lines.push(
      `   🤖 ${clean(
        model,
      )}`,
    );
  }

  const context =
    formatContext(
      status,
    );

  if (context) {
    lines.push(
      `   🧠 Context: ${clean(
        context,
      )}`,
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
    `   👁 Observer: ${clean(
      formatObserver(
        status,
      ),
    )}`,
  );

  /*
   * This is the new ownership/readiness line.
   *
   * Ready requires:
   *
   * - Windows writer alive
   * - Observer alive
   * - fresh Observer heartbeat
   * - Session state = Waiting
   * - launch mapping exists
   * - Release Agent alive
   */
  lines.push(
    `   🔄 Handoff: ${clean(
      formatHandoffState(
        getHandoffState(
          status,
        ),
      ),
    )}`,
  );

  if (
    status.lastActivity
  ) {
    lines.push(
      `   ⚙ ${clean(
        status.lastActivity,
      )}`,
    );
  }

  return lines.join(
    '\n',
  );
}

function selectorMatches(
  status: LocalStatus,
  selector: string,
): boolean {
  const input =
    selector
      .trim()
      .toLowerCase();

  if (!input) {
    return false;
  }

  if (
    status.sessionId
      .toLowerCase()
      .startsWith(
        input,
      )
  ) {
    return true;
  }

  if (
    status.threadName
      ?.toLowerCase()
      .startsWith(
        input,
      )
  ) {
    return true;
  }

  if (
    status.projectName
      ?.toLowerCase() ===
      input
  ) {
    return true;
  }

  return false;
}

function resolveSelector(
  statuses: LocalStatus[],
  selector: string,
):
  | {
      ok: true;
      status: LocalStatus;
    }
  | {
      ok: false;
      message: string;
    } {
  const input =
    selector.trim();

  const lower =
    input.toLowerCase();

  /*
   * Priority:
   *
   * 1. exact full Session ID
   * 2. unique Session ID prefix
   * 3. exact Thread name
   * 4. unique Thread-name prefix
   * 5. exact Project name
   */

  const exactId =
    statuses.filter(
      (status) =>
        status.sessionId
          .toLowerCase() ===
        lower,
    );

  if (
    exactId.length === 1
  ) {
    return {
      ok: true,
      status: exactId[0]!,
    };
  }

  const idPrefix =
    statuses.filter(
      (status) =>
        status.sessionId
          .toLowerCase()
          .startsWith(
            lower,
          ),
    );

  if (
    idPrefix.length === 1
  ) {
    return {
      ok: true,
      status: idPrefix[0]!,
    };
  }

  if (
    idPrefix.length > 1
  ) {
    return {
      ok: false,

      message: [
        '⚠️ **Session ID 前缀匹配到多个 Session。**',
        '',
        ...idPrefix
          .slice(
            0,
            10,
          )
          .map(
            (status) =>
              `- \`${clean(
                status.sessionId,
              )}\`${
                status.threadName
                  ? ` — ${clean(
                      status.threadName,
                    )}`
                  : ''
              }`,
          ),
      ].join('\n'),
    };
  }

  const exactThread =
    statuses.filter(
      (status) =>
        status.threadName
          ?.toLowerCase() ===
        lower,
    );

  if (
    exactThread.length === 1
  ) {
    return {
      ok: true,
      status: exactThread[0]!,
    };
  }

  if (
    exactThread.length > 1
  ) {
    return {
      ok: false,

      message: [
        '⚠️ **Thread 名称匹配到多个 Session。**',
        '',
        ...exactThread
          .slice(
            0,
            10,
          )
          .map(
            (status) =>
              `- \`${clean(
                status.sessionId,
              )}\``,
          ),
      ].join('\n'),
    };
  }

  const threadPrefix =
    statuses.filter(
      (status) =>
        status.threadName
          ?.toLowerCase()
          .startsWith(
            lower,
          ),
    );

  if (
    threadPrefix.length === 1
  ) {
    return {
      ok: true,
      status:
        threadPrefix[0]!,
    };
  }

  if (
    threadPrefix.length > 1
  ) {
    return {
      ok: false,

      message: [
        '⚠️ **Thread 名称前缀匹配到多个 Session。**',
        '',
        ...threadPrefix
          .slice(
            0,
            10,
          )
          .map(
            (status) =>
              `- ${clean(
                status.threadName,
              )} · \`${clean(
                status.sessionId,
              )}\``,
          ),
      ].join('\n'),
    };
  }

  const projectMatches =
    statuses.filter(
      (status) =>
        status.projectName
          ?.toLowerCase() ===
        lower,
    );

  if (
    projectMatches.length ===
    1
  ) {
    return {
      ok: true,
      status:
        projectMatches[0]!,
    };
  }

  if (
    projectMatches.length >
    1
  ) {
    return {
      ok: false,

      message: [
        `⚠️ **Project \`${clean(
          input,
        )}\` 中存在多个 Session。**`,
        '',
        '请使用 Thread 名称或 Session ID：',
        '',
        ...projectMatches
          .slice(
            0,
            10,
          )
          .map(
            (status) =>
              `- ${
                status.threadName
                  ? `${clean(
                      status.threadName,
                    )} · `
                  : ''
              }\`${clean(
                status.sessionId,
              )}\``,
          ),
      ].join('\n'),
    };
  }

  return {
    ok: false,

    message:
      `❌ 没有找到 Session：\`${clean(
        input,
      )}\``,
  };
}

function sortNewestFirst(
  statuses: LocalStatus[],
): LocalStatus[] {
  return [
    ...statuses,
  ].sort(
    (
      a,
      b,
    ) =>
      statusTimestamp(b) -
      statusTimestamp(a),
  );
}

function renderList(
  title: string,
  statuses: LocalStatus[],
): string {
  const lines: string[] = [
    `## ${title}`,
    '',
  ];

  let index = 0;

  for (
    const status of statuses
  ) {
    index += 1;

    lines.push(
      formatStatusCard(
        status,
        index,
      ),
      '',
    );
  }

  return lines
    .join('\n')
    .trim();
}

function usageText(): string {
  return [
    '## Windows Codex Sessions',
    '',
    '没有找到匹配的 Session。',
    '',
    '用法：',
    '',
    '- `/windows status` — 当前 Windows 活跃 Session',
    '- `/windows status all` — 活跃 + 历史 Session',
    '- `/windows status history` — 历史 Session',
    '- `/windows status <Thread名称>` — 查看指定 Session',
    '- `/windows status <Session-ID前缀>` — 查看指定 Session',
    '- `/windows status <Project名称>` — Project 中仅有一个匹配时显示详情',
  ].join('\n');
}

export async function handleLocalStatus(
  args: string,
): Promise<string> {
  const input =
    args.trim();

  const statuses =
    sortNewestFirst(
      readMonitorStatuses(),
    );

  if (
    statuses.length === 0
  ) {
    return [
      '## Windows Codex Sessions',
      '',
      '当前 `.codex-monitor` 中没有 Session 状态记录。',
    ].join('\n');
  }

  const active =
    statuses.filter(
      isActiveStatus,
    );

  const history =
    statuses.filter(
      (status) =>
        !isActiveStatus(
          status,
        ),
    );

  /*
   * Default:
   *
   * show active Windows sessions only.
   */
  if (!input) {
    if (
      active.length === 0
    ) {
      return [
        '## Windows Codex Sessions',
        '',
        '当前没有活跃的 Windows Codex Session。',
        '',
        `历史记录：${history.length}`,
        '',
        '使用 **/windows status history** 或 **/windows status all** 查看历史。',
      ].join('\n');
    }

    return renderList(
      'Windows Codex Sessions',
      active,
    );
  }

  const mode =
    input.toLowerCase();

  if (
    mode === 'all'
  ) {
    return renderList(
      'Windows Codex Sessions · All',
      statuses,
    );
  }

  if (
    mode === 'history'
  ) {
    if (
      history.length === 0
    ) {
      return [
        '## Windows Codex Sessions · History',
        '',
        '当前没有历史 Session。',
      ].join('\n');
    }

    return renderList(
      'Windows Codex Sessions · History',
      history.slice(
        0,
        DEFAULT_HISTORY_LIMIT,
      ),
    );
  }

  /*
   * Detail lookup searches all status records,
   * including historical sessions.
   */
  const resolved =
    resolveSelector(
      statuses,
      input,
    );

  if (!resolved.ok) {
    return resolved.message;
  }

  const status =
    resolved.status;

  const handoff =
    getHandoffState(
      status,
    );

  const lines: string[] = [
    '## Windows Codex Session',
    '',
    `${stateIcon(
      status,
    )} **State:** ${clean(
      displayState(
        status,
      ),
    )}`,
  ];

  if (
    status.threadName
  ) {
    lines.push(
      '',
      `🏷 **Thread:** ${clean(
        status.threadName,
      )}`,
    );
  }

  if (
    status.projectName
  ) {
    lines.push(
      `📁 **Project:** ${clean(
        status.projectName,
      )}`,
    );
  }

  if (
    status.cwd
  ) {
    lines.push(
      `📂 **Directory:** \`${clean(
        status.cwd,
      )}\``,
    );
  }

  lines.push(
    '',
    `🔗 **Session:** \`${clean(
      status.sessionId,
    )}\``,
  );

  if (
    status.cliVersion
  ) {
    lines.push(
      `🛠 **Codex CLI:** ${clean(
        status.cliVersion,
      )}`,
    );
  }

  const model =
    formatModel(
      status,
    );

  if (model) {
    lines.push(
      `🤖 **Model:** ${clean(
        model,
      )}`,
    );
  }

  if (
    status.permissions
  ) {
    lines.push(
      `🔐 **Permissions:** ${clean(
        status.permissions,
      )}`,
    );
  }

  if (
    status.approvalPolicy
  ) {
    lines.push(
      `✅ **Approval:** ${clean(
        status.approvalPolicy,
      )}`,
    );
  }

  if (
    status.collaborationMode
  ) {
    lines.push(
      `👥 **Collaboration:** ${clean(
        status.collaborationMode,
      )}`,
    );
  }

  if (
    status.personality
  ) {
    lines.push(
      `🎛 **Personality:** ${clean(
        status.personality,
      )}`,
    );
  }

  const context =
    formatContext(
      status,
    );

  if (context) {
    lines.push(
      '',
      `🧠 **Context:** ${clean(
        context,
      )}`,
    );
  }

  const tokenUsage =
    formatTokenUsage(
      status,
    );

  if (tokenUsage) {
    lines.push(
      `📊 **Tokens:** ${clean(
        tokenUsage,
      )}`,
    );
  }

  lines.push(
    '',
    `👁 **Observer:** ${clean(
      formatObserver(
        status,
      ),
    )}`,
  );

  lines.push(
    `🔄 **Handoff:** ${clean(
      formatHandoffState(
        handoff,
      ),
    )}`,
  );

  if (
    handoff.launch
      ?.releaseAgentPid
  ) {
    lines.push(
      `🛰 **Release Agent:** Recorded · PID ${
        handoff.launch
          .releaseAgentPid
      }`,
    );
  }

  if (
    handoff.launch
      ?.codexRootPid
  ) {
    lines.push(
      `🖥 **Recorded Codex root:** PID ${
        handoff.launch
          .codexRootPid
      }`,
    );
  }

  if (
    status.lastActivity
  ) {
    lines.push(
      '',
      `⚙ **Activity:** ${clean(
        status.lastActivity,
      )}`,
    );
  }

  if (
    status.lastEventType
  ) {
    lines.push(
      `📨 **Last event:** ${clean(
        status.lastEventType,
      )}`,
    );
  }

  return lines.join(
    '\n',
  );
}

function commandReplyOptions(
  ctx: any,
): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId
      ? { replyInThread: true as const }
      : {}),
  };
}

function isReleaseCandidate(
  status: LocalStatus,
): boolean {
  const state = String(status.state ?? '').toLowerCase();
  const handoff = getHandoffState(status);

  return handoff.windowsActive && state === 'waiting';
}

function normalizeThreadName(
  value: string | undefined,
): string | undefined {
  const name = value?.trim();
  return name ? name : undefined;
}

function releaseActionLabel(
  status: LocalStatus,
  peers: LocalStatus[],
): string {
  /*
   * Human-facing identity rules:
   *
   * 1. Prefer Thread name when present.
   * 2. If the Thread name is duplicated in the current result set,
   *    append a short Session ID so the buttons remain distinguishable.
   * 3. If there is no Thread name, show the short Session ID.
   *
   * Project name / cwd are deliberately NOT used as fallbacks because
   * multiple distinct Sessions can share the same project directory.
   */
  const threadName = normalizeThreadName(status.threadName);

  if (!threadName) {
    return shortSessionId(status.sessionId);
  }

  const duplicateCount = peers.filter(
    (peer) =>
      normalizeThreadName(peer.threadName)?.toLocaleLowerCase() ===
      threadName.toLocaleLowerCase(),
  ).length;

  if (duplicateCount > 1) {
    return `${threadName} · ${shortSessionId(status.sessionId)}`;
  }

  return threadName;
}

function releaseButton(
  status: LocalStatus,
  peers: LocalStatus[],
): ButtonSpec {
  const target = releaseActionLabel(status, peers);

  return {
    text: `🔓 Release ${target}`,
    value: {
      /*
       * IMPORTANT: the display label is only for humans.
       * The release target is ALWAYS the exact full Session ID.
       */
      cmd: 'local-release',
      arg: status.sessionId,
    },
    style: 'primary',
    hoverTips: `Release Windows Session ${target}. Full Session ID: ${status.sessionId}`,
  };
}

function chunkButtons(
  buttons: ButtonSpec[],
  size = 4,
): ButtonSpec[][] {
  const chunks: ButtonSpec[][] = [];
  for (let i = 0; i < buttons.length; i += size) {
    chunks.push(buttons.slice(i, i + size));
  }
  return chunks;
}

function stripMarkdownHeading(
  markdown: string,
): string {
  return markdown.replace(/^##[^\n]*\n+/, '').trim();
}

async function sendStatusCard(
  ctx: any,
  title: string,
  markdown: string,
  releaseCandidates: LocalStatus[],
): Promise<void> {
  const elements: object[] = [
    divMd(stripMarkdownHeading(markdown)),
  ];

  const releasable = releaseCandidates.filter(isReleaseCandidate);
  if (releasable.length > 0) {
    elements.push({ tag: 'hr' });
    for (const group of chunkButtons(releasable.map((status) => releaseButton(status, releasable)))) {
      elements.push(actions(group));
    }
  }

  await ctx.channel.send(
    ctx.msg.chatId,
    { card: shell(title, elements) },
    commandReplyOptions(ctx),
  );
}

/**
 * Interactive card version used by /windows status and the legacy
 * /local-status alias. The underlying status text remains generated by
 * handleLocalStatus(), while Waiting Windows sessions get a one-click
 * Release action carrying the exact Session ID.
 */
export async function handleLocalStatusInteractive(
  args: string,
  ctx: any,
): Promise<void> {
  const input = args.trim();
  const markdown = await handleLocalStatus(args);
  const statuses = sortNewestFirst(readMonitorStatuses());
  const active = statuses.filter(isActiveStatus);
  const history = statuses.filter((status) => !isActiveStatus(status));

  let title = '🖥️ Windows Codex Sessions';
  let releaseCandidates: LocalStatus[] = [];

  if (!input) {
    releaseCandidates = active;
  }
  else {
    const mode = input.toLowerCase();

    if (mode === 'all') {
      title = '🖥️ Windows Codex Sessions · All';
      releaseCandidates = statuses;
    }
    else if (mode === 'history') {
      title = '🖥️ Windows Codex Sessions · History';
      releaseCandidates = history;
    }
    else {
      title = '🖥️ Windows Codex Session';
      const resolved = resolveSelector(statuses, input);
      if (resolved.ok) {
        releaseCandidates = [resolved.status];
      }
    }
  }

  await sendStatusCard(
    ctx,
    title,
    markdown,
    releaseCandidates,
  );
}

