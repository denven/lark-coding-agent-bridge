export interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
  /** Optional PC hover description. Mobile clients still rely on the button label itself. */
  hoverTips?: string;
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
    ...(spec.hoverTips
      ? {
          hover_tips: {
            tag: 'plain_text',
            content: spec.hoverTips,
          },
        }
      : {}),
  };
}

export function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

export function divPlain(content: string): object {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

export function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

export function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ stale cwd; the next message will create a new session' : ''}`
    : (info.emptySessionText ?? '(none)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _(topic-scoped session)_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(not set)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('💬 Lark Session Status', [
    divMd(lines.join('\n')),
    HR,
    actions([
      {
        text: '🆕 New Lark Session',
        value: { cmd: 'new' },
        style: 'primary',
        hoverTips: 'Clear the current Lark scope binding; the next message will create a new Session.',
      },
      {
        text: '🔁 Resume Lark Session',
        value: { cmd: 'resume' },
        hoverTips: 'List and resume Codex Sessions available to the current Lark scope and workspace.',
      },
      {
        text: '📂 Workspace',
        value: { cmd: 'ws.list' },
        hoverTips: 'View and switch workspaces available to the current Lark scope.',
      },
      {
        text: '💡 Help',
        value: { cmd: 'help' },
        hoverTips: 'View Lark, Windows, and global Codex Session management commands.',
      },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**💬 Lark Session**',
        '',
        '当前 Lark Chat / Group / Topic 与 Codex Session 的绑定。',
        '',
        '• **/lark status** — 查看当前 Lark scope 绑定的 Codex Session',
        '• **/lark new [chat [name]]** — 清除当前绑定并新建 Session；也可创建新群',
        '• **/lark resume [N]** — 查看并恢复当前 Lark scope 的历史 Session',
        '',
        '兼容旧命令：**/status**、**/new**、**/reset**、**/resume**',
        '',
        '**🖥️ Windows Codex**',
        '',
        'Windows Terminal 中由本地 Observer / Release Agent 管理的 Codex Session。',
        '',
        '• **/windows status [all|selector]** — 查看全部或指定 Windows Codex Session',
        '• **/windows release <selector>** — 释放 Waiting 状态的 Windows Codex writer',
        '',
        '兼容旧命令：**/local-status**、**/local-release**',
        '',
        '**🗂️ All Codex Sessions**',
        '',
        '跨 Windows 与 Lark 的全局 Session inventory 和 ownership 管理。',
        '',
        '• **/session list [all|keyword]** — 查看 Codex Sessions、Owner 与状态',
        '• **/session use <selector>** — Detached Session → 当前 Lark scope',
        '• **/session handoff <selector>** — Windows → 当前 Lark scope',
        '• **/session handback** — 当前 Lark scope → Detached / Windows-ready',
        '• **/session tail [selector]** — 查看当前或指定 Session 的最后一条 Codex 可见回复',
        '',
        '兼容旧命令：**/sessions**、**/use**、**/local-handoff**、**/handback**',
        '',
        '**📂 Workspace & Configuration**',
        '',
        '• **/cd <path>** — 切换当前 Lark scope 的工作目录（会重置 Session）',
        '• **/ws list|save <name>|use <name>|remove <name>** — 管理工作目录',
        '• **/account** — 查看当前应用；**/account change** 更换 appId / secret 并重连',
        '• **/config** — 调整偏好、访问控制和 lark-cli 身份策略',
        '',
        '**⚙️ Process & Diagnostics**',
        '',
        '• **/stop** — 结束当前正在运行的任务',
        '• **/stop comment:<scopeHash>** — 管理员停止云文档评论任务',
        '• **/timeout [N|off|default]** — 设置当前 Session 的探活时间',
        '• **/timeout comment:<scopeHash> N** — 管理员设置云文档评论任务探活',
        '• **/ps** — 列出本机所有 bot',
        '• **/exit <id|#>** — 关闭指定 bot',
        '• **/reconnect** — 强制重连 WebSocket',
        `• **/doctor [描述]** — 把日志和描述交给 ${escapedAgentName} 自助诊断`,
        '• **/help** — 显示本帮助',
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
      ].join('\n'),
    ),
    HR,
    actions([
      {
        text: '💬 Lark Status',
        value: { cmd: 'status' },
        style: 'primary',
        hoverTips: '查看当前 Lark Chat / Group / Topic 绑定的 Codex Session',
      },
      {
        text: '🔁 Lark Resume',
        value: { cmd: 'resume' },
        hoverTips: '查看并恢复当前 Lark scope 的历史 Session',
      },
      {
        text: '📂 Workspace',
        value: { cmd: 'ws.list' },
        hoverTips: '查看和切换当前 Lark scope 的工作目录',
      },
      {
        text: '🆕 Lark Session',
        value: { cmd: 'new' },
        hoverTips: '清除当前 Lark Session 绑定；下一条消息会建立新 Session',
      },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
