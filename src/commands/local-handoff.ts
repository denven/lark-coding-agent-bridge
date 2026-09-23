import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  buildSessionInventory,
  formatHandoffState,
  listLarkBindings,
  markSessionDetached,
  mergeLarkBindings,
  resolveSessionSelector,
  type LocalStatus,
  type SessionInventoryItem,
} from './local-session-state.js';
import { actions, divMd, divPlain, shell } from '../card/templates.js';
import { readLastCodexResponse } from '../session/codex-transcript.js';
import { bindScopeToSession } from './session-binding.js';
import { handleClaudeHandoff } from './claude-handoff.js';
import { scopeProvider, withoutAgentTokens } from './session-provider.js';

const execFileAsync =
  promisify(execFile);

const REQUEST_RELEASE_SCRIPT =
  join(
    homedir(),
    'Scripts',
    'Request-CodexRelease.ps1',
  );

const MONITOR_HOME =
  join(
    homedir(),
    '.codex-monitor',
  );

const RELEASE_TIMEOUT_MS =
  30_000;

const STATUS_RETRY_COUNT =
  15;

const STATUS_RETRY_DELAY_MS =
  200;

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

function sleep(
  milliseconds: number,
): Promise<void> {
  return new Promise(
    (resolve) => {
      setTimeout(
        resolve,
        milliseconds,
      );
    },
  );
}

async function reply(
  ctx: any,
  markdown: string,
): Promise<void> {
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      markdown,
    },
    {
      replyTo:
        ctx.msg.messageId,
    },
  );
}

async function replyCard(
  ctx: any,
  card: object,
): Promise<void> {
  await ctx.channel.send(
    ctx.msg.chatId,
    { card },
    {
      replyTo:
        ctx.msg.messageId,
    },
  );
}

function isCodexContext(
  ctx: any,
): boolean {
  /*
   * Different local bridge versions expose
   * Codex identity through slightly different
   * properties. Support both.
   */
  if (
    ctx.agent?.id ===
    'codex'
  ) {
    return true;
  }

  if (
    ctx.controls
      ?.profileConfig
      ?.agentKind ===
    'codex'
  ) {
    return true;
  }

  return false;
}

function getErrorText(
  error: unknown,
): string {
  if (
    typeof error !==
      'object' ||
    error === null
  ) {
    return String(
      error ?? '',
    );
  }

  const value =
    error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
      code?: unknown;
      signal?: unknown;
    };

  return [
    value.stdout,
    value.stderr,
    value.message,
  ]
    .filter(
      (item) =>
        item !==
          undefined &&
        item !==
          null &&
        String(item)
          .trim() !==
          '',
    )
    .map(
      (item) =>
        String(item),
    )
    .join('\n');
}

function formatReleaseError(
  text: string,
): string {
  const value =
    text.trim();

  if (
    value.includes(
      'SESSION_NOT_FOUND',
    )
  ) {
    return [
      '❌ **没有找到对应的 Windows Codex Session。**',
      '',
      '请先使用 `/local-status` 或 `/sessions` 查看当前 Session。',
    ].join('\n');
  }

  if (
    value.includes(
      'AMBIGUOUS_SESSION',
    )
  ) {
    return [
      '⚠️ **匹配到多个 Windows Codex Session。**',
      '',
      '请使用更完整的 Thread 名称或 Session ID。',
    ].join('\n');
  }

  if (
    value.includes(
      'SESSION_NOT_ACTIVE',
    )
  ) {
    return [
      '⚠️ **目标 Session 当前没有活动的 Windows writer。**',
      '',
      '如果 Session 已经 Detached，请使用 `/use`，而不是 `/local-handoff`。',
    ].join('\n');
  }

  if (
    value.includes(
      'SESSION_NOT_WAITING',
    )
  ) {
    return [
      '⛔ **目标 Session 当前不是 Waiting。**',
      '',
      '为了避免中断正在执行的 Codex 任务，只有 Waiting Session 可以 handoff。',
    ].join('\n');
  }

  if (
    value.includes(
      'OBSERVER_NOT_RUNNING',
    ) ||
    value.includes(
      'INVALID_HEARTBEAT',
    ) ||
    value.includes(
      'STALE_OBSERVER',
    )
  ) {
    return [
      '⚠️ **目标 Session 的 Observer 状态不可靠。**',
      '',
      '为避免接管错误的 Session，本次 handoff 已取消。',
    ].join('\n');
  }

  if (
    value.includes(
      'RELEASE_REQUEST_TIMEOUT',
    )
  ) {
    return [
      '⚠️ **Local Release Agent 没有及时响应。**',
      '',
      'Windows writer 没有被确认释放，因此 Lark 不会接管这个 Session。',
    ].join('\n');
  }

  if (
    value.includes(
      'LAUNCH_MAPPING_NOT_FOUND',
    ) ||
    value.includes(
      'INVALID_PID_MAPPING',
    ) ||
    value.includes(
      'UNSAFE_PID_MAPPING',
    ) ||
    value.includes(
      'PID_MISMATCH',
    ) ||
    value.includes(
      'PARENT_MISMATCH',
    ) ||
    value.includes(
      'NOT_CODEX_PROCESS',
    ) ||
    value.includes(
      'PID_REUSED',
    )
  ) {
    return [
      '⛔ **Windows Codex 进程身份校验失败。**',
      '',
      'Release Agent 无法确认目标 writer 的身份，因此 handoff 已取消。',
    ].join('\n');
  }

  if (
    value.includes(
      'ACCESS_DENIED',
    ) ||
    value.includes(
      'Access is denied',
    )
  ) {
    return [
      '⛔ **Windows 进程释放被拒绝。**',
      '',
      'Windows writer 没有被确认释放，因此 Lark 不会接管。',
    ].join('\n');
  }

  return [
    '❌ **Windows → Lark handoff 失败。**',
    '',
    value
      ? [
          '详细信息：',
          '',
          '```text',
          clean(
            value.slice(
              0,
              1800,
            ),
          ),
          '```',
        ].join('\n')
      : '没有返回进一步错误信息。',
  ].join('\n');
}

async function readStatus(
  sessionId: string,
): Promise<
  LocalStatus | undefined
> {
  const path =
    join(
      MONITOR_HOME,
      `status-${sessionId}.json`,
    );

  try {
    const raw =
      (
        await readFile(
          path,
          'utf8',
        )
      )
        .replace(
          /^\uFEFF/,
          '',
        )
        .trim();

    if (!raw) {
      return undefined;
    }

    return JSON.parse(
      raw,
    ) as LocalStatus;
  }
  catch {
    return undefined;
  }
}

async function waitForStatus(
  sessionId: string,
): Promise<
  LocalStatus | undefined
> {
  for (
    let attempt = 0;
    attempt <
    STATUS_RETRY_COUNT;
    attempt += 1
  ) {
    const status =
      await readStatus(
        sessionId,
      );

    if (status) {
      return status;
    }

    await sleep(
      STATUS_RETRY_DELAY_MS,
    );
  }

  return undefined;
}

async function verifyDirectory(
  cwd: string,
): Promise<boolean> {
  try {
    const info =
      await stat(cwd);

    return info.isDirectory();
  }
  catch {
    return false;
  }
}

interface ReleaseSuccess {
  ok: true;

  sessionId: string;

  codexPid?: number;
  observerPid?: number;

  output: string;
}

interface ReleaseFailure {
  ok: false;

  message: string;
}

type ReleaseResult =
  | ReleaseSuccess
  | ReleaseFailure;

async function requestRelease(
  sessionId: string,
): Promise<ReleaseResult> {
  try {
    const {
      stdout,
      stderr,
    } =
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          REQUEST_RELEASE_SCRIPT,
          '-SessionSelector',
          sessionId,
        ],
        {
          windowsHide: true,

          timeout:
            RELEASE_TIMEOUT_MS,

          encoding:
            'utf8',
        },
      );

    const output =
      `${stdout ?? ''}\n${stderr ?? ''}`
        .trim();

    /*
     * Current Request-CodexRelease.ps1 success
     * format:
     *
     * OK|RELEASED|<SessionId>|<CodexPid>|<ObserverPid>
     *
     * PID fields are allowed to vary in future
     * versions, so only SessionId is mandatory.
     */
    const match =
      output.match(
        /OK\|RELEASED\|([^|\r\n]+)(?:\|([^|\r\n]*))?(?:\|([^|\r\n]*))?/,
      );

    if (!match?.[1]) {
      return {
        ok: false,

        message:
          formatReleaseError(
            output,
          ),
      };
    }

    const releasedSessionId =
      match[1].trim();

    const codexPid =
      match[2] &&
      /^\d+$/.test(
        match[2].trim(),
      )
        ? Number(
            match[2].trim(),
          )
        : undefined;

    const observerPid =
      match[3] &&
      /^\d+$/.test(
        match[3].trim(),
      )
        ? Number(
            match[3].trim(),
          )
        : undefined;

    return {
      ok: true,

      sessionId:
        releasedSessionId,

      codexPid,
      observerPid,

      output,
    };
  }
  catch (error: unknown) {
    return {
      ok: false,

      message:
        formatReleaseError(
          getErrorText(
            error,
          ),
        ),
    };
  }
}

function sessionDisplayName(
  item: SessionInventoryItem,
): string {
  if (
    item.threadName
  ) {
    return item.threadName;
  }

  if (
    item.projectName
  ) {
    return item.projectName;
  }

  return item.sessionId;
}

function describeScope(
  ctx: any,
  scope: string,
): string {
  if (
    scope ===
    ctx.scope
  ) {
    return 'Current scope';
  }

  /*
   * If the Bridge keeps known Lark chats,
   * try to show the human-readable chat name.
   */
  const chatId =
    scope.includes(':')
      ? scope.split(':')[0]
      : scope;

  const knownChats =
    ctx.controls
      ?.knownChats;

  if (
    Array.isArray(
      knownChats,
    )
  ) {
    const chat =
      knownChats.find(
        (value: any) =>
          value?.chatId ===
            chatId ||
          value?.id ===
            chatId,
      );

    const name =
      chat?.name ??
      chat?.title;

    if (
      typeof name ===
        'string' &&
      name.trim()
    ) {
      return name.trim();
    }
  }

  if (
    scope.length >
    16
  ) {
    return `Scope …${scope.slice(
      -12,
    )}`;
  }

  return scope;
}

function currentScopeBinding(
  ctx: any,
): string | undefined {
  const bindings =
    listLarkBindings(
      ctx,
    );

  return bindings.find(
    (binding) =>
      binding.current,
  )?.sessionId;
}

export async function handleLocalHandoff(
  args: string,
  ctx: any,
): Promise<void> {
  /*
   * Handoff always lands in this scope's own agent: the released Session must
   * be one this scope's adapter can resume. The profile decides which agent,
   * so the command is identical on a Codex and a Claude bot.
   */
  const selector =
    withoutAgentTokens(args, { leadingOnly: true });

  if (scopeProvider(ctx).agentKind === 'claude') {
    await handleClaudeHandoff(selector, ctx);
    return;
  }

  if (!selector) {
    await reply(
      ctx,
      [
        '⚠️ **需要提供 Thread 名称或 Session ID。**',
        '',
        '例如：',
        '',
        '`/local-handoff Calculate 1+2`',
        '',
        '或者：',
        '',
        '`/local-handoff 01a0be4d`',
      ].join('\n'),
    );

    return;
  }

  /*
   * Do not release a Windows writer unless
   * this Lark profile is actually capable of
   * becoming the Codex owner.
   */
  if (
    !isCodexContext(
      ctx,
    )
  ) {
    await reply(
      ctx,
      [
        '⛔ **当前 Lark scope 不是 Codex agent。**',
        '',
        '为避免释放 Windows writer 后无法接管，本次 handoff 已取消。',
      ].join('\n'),
    );

    return;
  }

  /*
   * Build a global view:
   *
   * Windows monitor status
   * +
   * persisted Lark scope bindings.
   */
  const inventory =
    buildSessionInventory();

  const bindings =
    listLarkBindings(
      ctx,
    );

  mergeLarkBindings(
    inventory.items,
    bindings,
  );

  const resolved =
    resolveSessionSelector(
      selector,
      inventory.items,
    );

  if (!resolved.ok) {
    await reply(
      ctx,
      [
        '❌ **无法确定 handoff Session。**',
        '',
        resolved.message,
        '',
        '可以先使用 `/sessions` 或 `/local-status` 查看。',
      ].join('\n'),
    );

    return;
  }

  const target =
    resolved.item;

  /*
   * A Session already owned by another Lark
   * scope must first be handed back there.
   *
   * Otherwise we would create two logical
   * Lark writers for the same Codex thread.
   */
  const otherBindings =
    bindings.filter(
      (binding) =>
        binding.sessionId ===
          target.sessionId &&
        binding.scope !==
          ctx.scope,
    );

  if (
    otherBindings.length >
    0
  ) {
    await reply(
      ctx,
      [
        '⛔ **这个 Session 已经绑定到另一个 Lark scope。**',
        '',
        `🏷 **Thread:** ${clean(
          sessionDisplayName(
            target,
          ),
        )}`,
        '',
        `🔗 **Session:** \`${clean(
          target.sessionId,
        )}\``,
        '',
        `📱 **Lark scope:** ${clean(
          describeScope(
            ctx,
            otherBindings[0]!.scope,
          ),
        )}`,
        '',
        '请先在原 Group / Chat 中执行 `/handback`。',
      ].join('\n'),
    );

    return;
  }

  /*
   * If the current scope already points to the
   * requested Session, no ownership change is
   * required.
   *
   * This check is mainly useful after a previous
   * successful handoff.
   */
  const currentSessionId =
    currentScopeBinding(
      ctx,
    );

  if (
    currentSessionId ===
      target.sessionId &&
    !target.handoff
      .windowsActive
  ) {
    await reply(
      ctx,
      [
        'ℹ️ **当前 Lark scope 已经绑定到这个 Session。**',
        '',
        `🏷 **Thread:** ${clean(
          sessionDisplayName(
            target,
          ),
        )}`,
        '',
        `🔗 **Session:** \`${clean(
          target.sessionId,
        )}\``,
        '',
        '直接发送普通消息即可继续工作。',
      ].join('\n'),
    );

    return;
  }

  /*
   * /local-handoff is specifically:
   *
   * Windows -> Lark
   *
   * Detached sessions should use /use instead.
   */
  if (
    !target.handoff
      .windowsActive
  ) {
    await reply(
      ctx,
      [
        '⚪ **这个 Session 当前没有 Windows writer。**',
        '',
        `🏷 **Thread:** ${clean(
          sessionDisplayName(
            target,
          ),
        )}`,
        '',
        `🔗 **Session:** \`${clean(
          target.sessionId,
        )}\``,
        '',
        '如果要在当前 Lark scope 中使用它，请执行：',
        '',
        `\`/use ${clean(
          target.sessionId.slice(
            0,
            12,
          ),
        )}\``,
      ].join('\n'),
    );

    return;
  }

  /*
   * TypeScript performs only a lightweight
   * ownership/activity pre-check.
   *
   * Busy is the only state that must be rejected
   * before contacting the local Release Agent.
   *
   * "needs-validation" is allowed to continue:
   * Request-CodexRelease.ps1 and
   * Release-CodexSession.ps1 perform the
   * authoritative process validation.
   */
  if (
    target.handoff.code ===
    'busy'
  ) {
    await reply(
      ctx,
      [
        '⛔ **目标 Windows Session 当前仍在执行任务。**',
        '',
        `🏷 **Thread:** ${clean(
          sessionDisplayName(
            target,
          ),
        )}`,
        '',
        `🔗 **Session:** \`${clean(
          target.sessionId,
        )}\``,
        '',
        `🔄 **Handoff:** ${clean(
          formatHandoffState(
            target.handoff,
          ),
        )}`,
        '',
        '请等待当前 Codex 任务完成后再执行 handoff。',
      ].join('\n'),
    );

    return;
  }

  /*
   * Important:
   *
   * Release by the fully resolved Session ID,
   * not by the original selector.
   *
   * This avoids a race or ambiguity between
   * Thread-name matching and release.
   */
  const release =
    await requestRelease(
      target.sessionId,
    );

  if (!release.ok) {
    await reply(
      ctx,
      release.message,
    );

    return;
  }

  /*
   * Defensive check:
   *
   * Request-CodexRelease.ps1 must confirm that
   * it released the exact Session we resolved.
   */
  if (
    release.sessionId
      .toLowerCase() !==
    target.sessionId
      .toLowerCase()
  ) {
    await reply(
      ctx,
      [
        '⛔ **Release 返回了不同的 Session ID。**',
        '',
        `Requested: \`${clean(
          target.sessionId,
        )}\``,
        '',
        `Released: \`${clean(
          release.sessionId,
        )}\``,
        '',
        '为了避免错误接管，Lark Session 没有被修改。',
      ].join('\n'),
    );

    return;
  }

  /*
   * Persist the ownership boundary immediately after the authoritative
   * Windows release succeeds. A stale Observer heartbeat may remain fresh
   * for a few seconds, but it must not reclaim Windows ownership. The marker
   * is automatically superseded when a newer Windows launch mapping appears.
   */
  const detachedRecorded =
    markSessionDetached(
      release.sessionId,
      'handoff-release',
    );

  /*
   * The Windows writer is now gone.
   *
   * The status JSON intentionally survives long
   * enough to act as handoff metadata.
   *
   * codex3 finally may update it to Exited /
   * Stopped immediately after release, but cwd
   * and thread metadata remain usable.
   */
  const releasedStatus =
    await waitForStatus(
      release.sessionId,
    );

  /*
   * Read the last completed Windows-side response after release confirmation,
   * when the rollout is no longer being written by the Windows writer. This
   * is display-only continuity for the human; it is never re-injected into
   * Codex because the resumed thread already contains the response.
   */
  const lastWindowsResponse =
    await readLastCodexResponse({
      sessionId: release.sessionId,
      rolloutPath:
        releasedStatus?.rolloutPath ??
        target.rolloutPath,
      maxChars: 5_000,
    });

  const cwd =
    releasedStatus?.cwd ??
    target.cwd;

  if (!cwd) {
    await reply(
      ctx,
      [
        '⚠️ **Windows writer 已释放，但 Lark 自动接管没有完成。**',
        '',
        `🔗 **Session:** \`${clean(
          release.sessionId,
        )}\``,
        '',
        '原因：无法确定 Session 的工作目录。',
        '',
        'Codex Session 本身没有丢失。',
        '',
        '可以使用 `/sessions` 查找后，再通过 `/use` 或 `/resume` 手工恢复。',
      ].join('\n'),
    );

    return;
  }

  const cwdValid =
    await verifyDirectory(
      cwd,
    );

  if (!cwdValid) {
    await reply(
      ctx,
      [
        '⚠️ **Windows writer 已释放，但目标工作目录不存在。**',
        '',
        `📂 **Directory:** \`${clean(
          cwd,
        )}\``,
        '',
        `🔗 **Session:** \`${clean(
          release.sessionId,
        )}\``,
        '',
        'Lark Session 没有被修改。',
      ].join('\n'),
    );

    return;
  }

  /*
   * Commit ownership to this Lark scope.
   *
   * We intentionally do this only AFTER the
   * Windows Release Agent has confirmed success.
   *
   * Therefore a failed Windows release can never
   * result in both Windows and Lark believing that
   * they own the same Session.
   */
  try {
    /*
     * Writes the session catalog as well as sessions.json: Codex resumes only
     * from the catalog, so a sessions.json-only binding would make the next
     * message start a fresh thread instead of continuing this one.
     */
    const bound = await bindScopeToSession(
      ctx,
      'codex',
      release.sessionId,
      cwd,
    );

    if (!bound.catalogBound) {
      throw new Error(
        'Session catalog unavailable; Codex cannot resume this thread from Lark',
      );
    }
  }
  catch (error: unknown) {
    /*
     * At this point Windows is already released.
     *
     * Do NOT attempt to restart it automatically:
     * that could create another ownership race.
     *
     * Instead tell the user exactly which Session
     * remains safe to resume.
     */
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await reply(
      ctx,
      [
        '⚠️ **Windows writer 已释放，但 Lark Session 绑定失败。**',
        '',
        `🔗 **Session:** \`${clean(
          release.sessionId,
        )}\``,
        '',
        `📂 **Directory:** \`${clean(
          cwd,
        )}\``,
        '',
        'Codex Session 本身仍然存在。',
        '',
        '可以通过 `/use`、`/resume` 或 Windows `codex3 resume` 恢复。',
        '',
        `错误：\`${clean(
          message,
        )}\``,
      ].join('\n'),
    );

    return;
  }

  const threadName =
    releasedStatus
      ?.threadName ??
    target.threadName;

  const projectName =
    releasedStatus
      ?.projectName ??
    target.projectName;

  const summaryLines: string[] = [];

  if (threadName) {
    summaryLines.push(
      `🏷 **Thread:** ${clean(threadName)}`,
    );
  }

  if (projectName) {
    summaryLines.push(
      `📁 **Project:** ${clean(projectName)}`,
    );
  }

  summaryLines.push(
    `🔗 **Session:** ${clean(release.sessionId)}`,
    `📂 **Directory:** ${clean(cwd)}`,
    '👤 **Owner:** Lark · Current',
    '🖥 **Windows writer:** Released',
    '',
    '**Continue by sending a normal message in this Lark scope.**',
  );

  if (!detachedRecorded) {
    summaryLines.push(
      '',
      '⚠️ Detached ownership marker could not be persisted; stale Windows telemetry may remain visible briefly.',
    );
  }

  const elements: object[] = [
    divMd(summaryLines.join('\n')),
  ];

  if (lastWindowsResponse) {
    elements.push(
      { tag: 'hr' },
      divMd('**💬 Last Windows Response**'),
      divPlain(lastWindowsResponse.text),
    );

    if (lastWindowsResponse.truncated) {
      elements.push(
        divMd('_The response was shortened for Lark display; the full text remains in the Codex rollout._'),
      );
    }
  }
  else {
    elements.push(
      { tag: 'hr' },
      divMd('💬 **Last Windows Response:** no completed user-visible response was found in the rollout.'),
    );
  }

  elements.push(
    { tag: 'hr' },
    actions([
      {
        text: '📜 Last Response',
        value: {
          cmd: 'session.tail',
          arg: release.sessionId,
        },
        hoverTips: 'Read the latest completed user-visible Codex response for this Session.',
      },
      {
        text: '↩ Hand Back',
        value: { cmd: 'handback' },
        style: 'primary',
        hoverTips: 'Unbind this Session from the current Lark scope and make it Detached / Windows-ready.',
      },
    ]),
  );

  await replyCard(
    ctx,
    shell(
      '✅ Session Handoff Completed',
      elements,
    ),
  );
}
