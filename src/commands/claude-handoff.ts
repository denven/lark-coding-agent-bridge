import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { actions, divMd, divPlain, shell } from '../card/templates.js';
import { log } from '../core/logger.js';
import {
  formatHandoffState,
  isExistingDirectory,
  listLarkBindings,
  mergeLarkBindings,
  resolveSessionSelector,
} from './local-session-state.js';
import { CLAUDE_MONITOR_HOME, readReleaseAgentStatus } from './claude-session-state.js';
import { bindScopeToSession } from './session-binding.js';
import { providerFor } from './session-provider.js';

const execFileAsync = promisify(execFile);

/** Installed by scripts/windows/Install-CodexBridgeScripts.ps1. */
const RELEASE_SCRIPT = join(homedir(), 'Scripts', 'Request-ClaudeRelease.ps1');

const RELEASE_TIMEOUT_MS = 30_000;

const RELEASED_RE = /^OK\|RELEASED\|([0-9a-f-]{36})\|(\d+)\s*$/im;
const ERROR_RE = /^ERROR\|([A-Z_]+)\|?(.*)$/m;

function clean(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/`/g, "'");
}

function replyOptions(ctx: any): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  };
}

async function reply(ctx: any, markdown: string): Promise<void> {
  await ctx.channel.send(ctx.msg.chatId, { markdown }, replyOptions(ctx));
}

async function replyCard(ctx: any, card: object): Promise<void> {
  await ctx.channel.send(ctx.msg.chatId, { card }, replyOptions(ctx));
}

function hasActiveRun(ctx: any): boolean {
  return typeof ctx.activeRuns?.get === 'function' && Boolean(ctx.activeRuns.get(ctx.scope));
}

type ReleaseResult =
  | { ok: true; sessionId: string; writerPid: number }
  | { ok: false; code: string; detail: string };

function parseReleaseOutput(output: string): ReleaseResult {
  const released = RELEASED_RE.exec(output);
  if (released) {
    return { ok: true, sessionId: released[1]!, writerPid: Number(released[2]) };
  }

  const error = ERROR_RE.exec(output);
  return error
    ? { ok: false, code: error[1]!, detail: error[2] ?? '' }
    : { ok: false, code: 'INVALID_RELEASE_RESULT', detail: output.trim().slice(0, 500) };
}

const AGENT_POLL_MS = 200;

/**
 * Hand the release to the elevated Claude Release Agent and wait for its
 * verdict. Files are the only channel: the bridge runs LIMITED and may not
 * touch the elevated agent or the elevated Claude window directly.
 */
async function requestReleaseViaAgent(
  sessionId: string,
  monitorHome: string,
  timeoutMs: number,
): Promise<ReleaseResult> {
  const requestId = randomUUID();
  const requestDir = join(monitorHome, 'requests');
  const resultPath = join(monitorHome, 'results', `release-${requestId}.json`);
  const deadline = Date.now() + timeoutMs;

  await mkdir(requestDir, { recursive: true });
  const requestPath = join(requestDir, `release-${requestId}.json`);
  // Leave headroom so an expired request is refused rather than acted on
  // after the bridge has already given up.
  const request = { version: 1, requestId, sessionId, requestedAt: Date.now(), expiresAt: deadline - 2_000 };
  // Rename into place: the agent must never pick up a half-written request.
  await writeFile(`${requestPath}.tmp`, JSON.stringify(request), 'utf8');
  await rename(`${requestPath}.tmp`, requestPath);

  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as { output?: unknown };
      await rm(resultPath, { force: true });
      return parseReleaseOutput(typeof result.output === 'string' ? result.output : '');
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, AGENT_POLL_MS));
  }

  // Withdraw a request the agent never claimed so it cannot fire later.
  await rm(requestPath, { force: true });
  return { ok: false, code: 'AGENT_TIMEOUT', detail: '' };
}

/**
 * Ask Request-ClaudeRelease.ps1 to terminate the Session's Windows writer.
 *
 * All authoritative checks (idle, terminal entrypoint, procStart vs. the live
 * process, claude.exe image) happen inside the script, right before it acts,
 * so nothing here can race them.
 *
 * The script runs through the elevated Release Agent whenever one is up, and
 * directly otherwise — which still works for Claude windows that are not
 * elevated, and fails cleanly with ACCESS_DENIED for ones that are.
 */
export async function requestClaudeRelease(
  sessionId: string,
  {
    monitorHome = CLAUDE_MONITOR_HOME,
    timeoutMs = RELEASE_TIMEOUT_MS,
  }: { monitorHome?: string; timeoutMs?: number } = {},
): Promise<ReleaseResult> {
  if (readReleaseAgentStatus().running) {
    return requestReleaseViaAgent(sessionId, monitorHome, timeoutMs);
  }

  if (!existsSync(RELEASE_SCRIPT)) {
    return { ok: false, code: 'SCRIPT_NOT_INSTALLED', detail: RELEASE_SCRIPT };
  }

  let output: string;
  try {
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RELEASE_SCRIPT, '-SessionId', sessionId],
      { timeout: RELEASE_TIMEOUT_MS, windowsHide: true },
    );
    output = `${result.stdout}\n${result.stderr}`;
  } catch (err) {
    // A non-zero exit is how the script reports refusals; its stdout still
    // carries the ERROR line.
    const failure = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (failure.killed) return { ok: false, code: 'RELEASE_TIMEOUT', detail: '' };
    output = [failure.stdout, failure.stderr, failure.message].filter(Boolean).join('\n');
  }

  return parseReleaseOutput(output);
}

function formatReleaseError(result: { code: string; detail: string }): string {
  const lines = (() => {
    switch (result.code) {
      case 'SCRIPT_NOT_INSTALLED':
        return [
          '⛔ **Claude Release 脚本未安装。**',
          '',
          `缺少：\`${clean(result.detail)}\``,
          '',
          '请运行 `scripts\\windows\\Install-CodexBridgeScripts.ps1` 安装后重试。',
        ];
      case 'SESSION_NOT_ACTIVE':
      case 'WRITER_NOT_RUNNING':
        return [
          'ℹ️ **Windows 上已没有这个 Session 的 Claude 窗口。**',
          '',
          '它可能刚刚退出。如果已是 Detached，请改用 **/session use**。',
        ];
      case 'SESSION_NOT_IDLE':
        return [
          '⛔ **Windows 上的 Claude 当前不是空闲状态。**',
          '',
          '为避免中断正在进行的回合，只有 idle 的 Session 可以 handoff。请等它完成后重试。',
        ];
      case 'AMBIGUOUS_WRITER':
        return [
          '⚠️ **有多个 Claude 窗口同时打开了这个 Session。**',
          '',
          '请先在 Windows 上关闭多余的窗口，只保留一个后重试。',
        ];
      case 'UNSUPPORTED_ENTRYPOINT':
        return [
          '⛔ **这个 Session 不是在终端窗口中运行的。**',
          '',
          '它可能开在 IDE 或其他客户端中，bridge 不会自动终止它。请在那里手动关闭，再执行 **/session use**。',
        ];
      case 'PROCESS_IDENTITY_UNAVAILABLE':
      case 'PID_REUSED':
      case 'NOT_CLAUDE_PROCESS':
        return [
          '⛔ **Windows Claude 进程身份校验失败。**',
          '',
          '无法确认目标进程就是这个 Session 的 writer，handoff 已取消，没有终止任何进程。',
        ];
      case 'ACCESS_DENIED':
        return [
          '⛔ **Windows 拒绝访问目标进程。**',
          '',
          '这个 Claude 窗口以管理员身份运行，而 bridge 不是。需要先启动 Claude Release Agent（管理员权限）才能接管，handoff 已取消。',
        ];
      case 'AGENT_TIMEOUT':
        return [
          '⚠️ **Claude Release Agent 没有及时返回结果。**',
          '',
          'Lark 没有接管这个 Session。代理可能仍然关闭了 Windows 窗口；如果是这样，Session 现在是 Detached，可以用 **/session use** 接管。',
        ];
      case 'REQUEST_EXPIRED':
        return ['⚠️ **释放请求已过期，没有执行。**', '', '请重试 **/session handoff**。'];
      case 'TASKKILL_NOT_FOUND':
      case 'TERMINATION_FAILED':
        return [
          '❌ **未能终止 Windows 上的 Claude 窗口。**',
          '',
          'Windows writer 没有被确认释放，因此 Lark 不会接管这个 Session。',
        ];
      case 'RELEASE_TIMEOUT':
        return [
          '⚠️ **Release 脚本没有及时返回。**',
          '',
          'Windows writer 没有被确认释放，因此 Lark 不会接管这个 Session。',
        ];
      default:
        return ['❌ **Windows → Lark handoff 失败。**'];
    }
  })();

  return [
    ...lines,
    '',
    '```text',
    clean(`${result.code}${result.detail ? `|${result.detail}` : ''}`).slice(0, 800),
    '```',
  ].join('\n');
}

/**
 * Windows → Lark handoff for a Claude Code Session.
 *
 * Same contract as the Codex handoff: ownership moves to this scope only
 * after the Windows writer is confirmed gone, so a failed release can never
 * leave both sides believing they own the Session.
 */
export async function handleClaudeHandoff(
  selector: string,
  ctx: any,
): Promise<void> {
  if (!selector) {
    await reply(
      ctx,
      ['⚠️ **需要提供 Thread 名称或 Session ID。**', '', '例如：`/session handoff Test-Session`'].join('\n'),
    );
    return;
  }

  if (hasActiveRun(ctx)) {
    await reply(
      ctx,
      ['⛔ 当前 Lark scope 正在执行任务。', '', '请等待任务结束，或者先使用 `/stop`。'].join('\n'),
    );
    return;
  }

  const provider = providerFor('claude');
  const inventory = provider.buildInventory();
  const bindings = listLarkBindings(ctx);
  mergeLarkBindings(inventory.items, bindings);

  const resolved = resolveSessionSelector(selector, inventory.items);
  if (!resolved.ok) {
    await reply(
      ctx,
      ['❌ **无法选择 Session。**', '', resolved.message, '', '可以先使用 **/session list** 查看。'].join('\n'),
    );
    return;
  }

  const target = provider.hydrate(resolved.item);
  const linked = bindings.filter((binding) => binding.sessionId === target.sessionId);
  const boundHere = linked.some((binding) => binding.current);
  const boundElsewhere = linked.some((binding) => !binding.current);

  if (boundElsewhere) {
    await reply(
      ctx,
      [
        '⛔ **这个 Session 已绑定到另一个 Lark scope。**',
        '',
        '请先在原 Group / Chat 中执行 **/session handback**。',
      ].join('\n'),
    );
    return;
  }

  if (!target.handoff.windowsActive) {
    await reply(
      ctx,
      boundHere
        ? `✅ 当前 Lark scope 已经拥有这个 Session。`
        : [
            'ℹ️ **这个 Session 没有在 Windows 上运行（Detached）。**',
            '',
            `请使用：**/session use ${clean(target.sessionId.slice(0, 12))}**`,
          ].join('\n'),
    );
    return;
  }

  if (boundHere) {
    // Windows reopened a Session this scope still owns: two writers. Leave it
    // for the user to inspect rather than killing either side.
    await reply(
      ctx,
      [
        '⚠️ **这个 Session 同时被 Windows 和当前 Lark scope 持有。**',
        '',
        '请先确认哪一边应该继续：在 Windows 上退出窗口，或在这里执行 **/session handback**。',
      ].join('\n'),
    );
    return;
  }

  // Known-doomed cases (elevated window, nothing said yet, IDE client, …):
  // refuse here with the exact reason rather than running the release script.
  if (target.handoff.transferable === false) {
    const elevated = target.handoff.reason?.startsWith('Running as administrator');
    await reply(
      ctx,
      [
        '⛔ **这个 Windows 上的 Claude 窗口不能从 Lark 接管。**',
        '',
        `Handoff: ${formatHandoffState(target.handoff)}`,
        '',
        ...(elevated
          ? [
              '它以**管理员身份**运行，而 bridge 没有；Windows 不允许普通进程检查或终止管理员进程，这需要以管理员身份运行的 Claude Release Agent 来完成，但它现在没有运行。',
              '',
              '可以任选其一：',
              '• 启动 Claude Release Agent（管理员权限）后重试；',
              '• 在 Windows 上退出这个窗口，再执行 **/session use**；',
              '• 以后用普通（非管理员）终端启动 Claude。',
            ]
          : target.handoff.reason === 'No conversation yet'
            ? ['这个窗口还没有任何对话，没有可续接的内容。直接在 Lark 发消息即可开始新会话。']
            : ['请在 Windows 上关闭这个窗口，再执行 **/session use**。']),
      ].join('\n'),
    );
    return;
  }

  if (target.handoff.code === 'busy') {
    await reply(
      ctx,
      [
        '⛔ **Windows 上的 Claude 正在工作。**',
        '',
        `Handoff: ${formatHandoffState(target.handoff)}`,
        '',
        '请等它回到空闲后再 handoff。',
      ].join('\n'),
    );
    return;
  }

  const cwd = target.cwd;
  if (!cwd || !isExistingDirectory(cwd)) {
    await reply(
      ctx,
      [
        '❌ **无法确定或找不到这个 Session 的工作目录。**',
        '',
        `📂 \`${clean(cwd ?? 'unknown')}\``,
        '',
        '为避免在错误目录续接，handoff 已取消，没有终止任何进程。',
      ].join('\n'),
    );
    return;
  }

  // 'needs-validation' is deliberately not rejected here: the script performs
  // the authoritative checks and reports the precise reason.
  const release = await requestClaudeRelease(target.sessionId);

  if (!release.ok) {
    log.warn('command', 'claude-release-refused', { code: release.code });
    await reply(ctx, formatReleaseError(release));
    return;
  }

  if (release.sessionId !== target.sessionId) {
    await reply(
      ctx,
      [
        '⛔ **Release 脚本返回的 Session 与请求不一致。**',
        '',
        `请求：\`${clean(target.sessionId)}\``,
        `返回：\`${clean(release.sessionId)}\``,
        '',
        'Lark 不会接管任何 Session。',
      ].join('\n'),
    );
    return;
  }

  // The Windows writer is gone from here on. Never try to restart it: that
  // would reopen the ownership race. On failure, say how to resume safely.
  try {
    await bindScopeToSession(ctx, 'claude', release.sessionId, cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reply(
      ctx,
      [
        '⚠️ **Windows 窗口已关闭，但 Lark 绑定失败。**',
        '',
        `🔗 **Session:** \`${clean(release.sessionId)}\``,
        `📂 **Directory:** \`${clean(cwd)}\``,
        '',
        '这个 Session 现在是 Detached，可以安全地在任意一边续接：',
        '',
        `• Lark：**/session use ${clean(release.sessionId.slice(0, 12))}**`,
        `• Windows：\`${provider.resumeHint(release.sessionId)}\``,
        '',
        `错误：${clean(message)}`,
      ].join('\n'),
    );
    return;
  }

  const lastResponse = await provider.readLastResponse(target, 5_000);

  const summary = [
    ...(target.threadName ? [`🏷 **Thread:** ${clean(target.threadName)}`] : []),
    ...(target.projectName ? [`📁 **Project:** ${clean(target.projectName)}`] : []),
    `🔗 **Session:** ${clean(release.sessionId)}`,
    `📂 **Directory:** ${clean(cwd)}`,
    '👤 **Owner:** Lark · Current',
    `🖥 **Windows writer:** Released (pid ${release.writerPid})`,
    '',
    '**Continue by sending a normal message in this Lark scope.**',
  ];

  const elements: object[] = [divMd(summary.join('\n')), { tag: 'hr' }];

  if (lastResponse) {
    elements.push(divMd('**💬 Last Windows Response**'), divPlain(lastResponse.text));
    if (lastResponse.truncated) {
      elements.push(
        divMd('_The response was shortened for Lark display; the full text remains in the Claude Code transcript._'),
      );
    }
  } else {
    elements.push(
      divMd('💬 **Last Windows Response:** no completed user-visible response was found in the transcript.'),
    );
  }

  elements.push(
    { tag: 'hr' },
    actions([
      {
        text: '📜 Last Response',
        value: { cmd: 'session.tail', arg: release.sessionId },
        hoverTips: 'Read the latest completed user-visible Claude Code response for this Session.',
      },
      {
        text: '↩ Hand Back to Windows',
        value: { cmd: 'handback' },
        style: 'primary',
        hoverTips: 'Unbind this Session from the current Lark scope and make it Detached / Windows-ready.',
      },
    ]),
  );

  await replyCard(ctx, shell('✅ Session Handoff Completed', elements));
}
