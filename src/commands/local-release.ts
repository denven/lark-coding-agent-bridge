import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REQUEST_RELEASE_SCRIPT = join(
  homedir(),
  'Scripts',
  'Request-CodexRelease.ps1',
);

function formatError(
  text: string,
): string {
  if (
    text.includes(
      'EMPTY_SELECTOR',
    )
  ) {
    return [
      '⚠️ **需要提供 Thread 名称或 Session ID。**',
      '',
      '例如：',
      '',
      '`/local-release Online-Web-Forms`',
      '',
      '或者：',
      '',
      '`/local-release 01a0bb9a`',
    ].join('\n');
  }

  if (
    text.includes(
      'SESSION_NOT_FOUND',
    )
  ) {
    return [
      '❌ **没有找到对应的 Windows Codex Session。**',
      '',
      '可以使用 `/local-status` 查看当前活跃 Session。',
    ].join('\n');
  }

  if (
    text.includes(
      'AMBIGUOUS_SESSION',
    )
  ) {
    return [
      '⚠️ **匹配到多个 Windows Codex Session。**',
      '',
      'Thread 名称或 Session ID 前缀不唯一。',
      '',
      '请先使用 `/local-status` 查看当前 Session，',
      '然后使用更完整的 Thread 名称或 Session ID。',
    ].join('\n');
  }

  if (
    text.includes(
      'SESSION_NOT_ACTIVE',
    )
  ) {
    return [
      '⚠️ **这个 Thread 名称只匹配到历史 Session。**',
      '',
      '当前没有对应的活跃 Windows Codex Session 可以释放。',
      '',
      '可以使用 `/local-status all` 查看最近历史。',
    ].join('\n');
  }

  if (
    text.includes(
      'SESSION_NOT_WAITING',
    )
  ) {
    return [
      '⛔ **该 Session 当前不是 Waiting。**',
      '',
      '为了避免中断正在执行的任务，',
      '只有 `Waiting` 状态的 Session 才允许执行 `/local-release`。',
    ].join('\n');
  }

  if (
    text.includes(
      'OBSERVER_NOT_RUNNING',
    )
  ) {
    return [
      '⚠️ **该 Session 的 Observer 当前没有运行。**',
      '',
      '为避免释放错误的本地进程，本次操作已取消。',
    ].join('\n');
  }

  if (
    text.includes(
      'INVALID_HEARTBEAT',
    )
  ) {
    return [
      '⚠️ **Observer heartbeat 数据无效。**',
      '',
      '为避免释放错误的本地进程，本次操作已取消。',
    ].join('\n');
  }

  if (
    text.includes(
      'STALE_OBSERVER',
    )
  ) {
    return [
      '⚠️ **Observer heartbeat 已过期。**',
      '',
      '为避免释放错误的本地进程，本次操作已取消。',
    ].join('\n');
  }

  if (
    text.includes(
      'RELEASE_REQUEST_TIMEOUT',
    )
  ) {
    return [
      '⚠️ **Local Release Agent 没有及时响应。**',
      '',
      'Windows Codex writer 没有被确认释放。',
      '',
      '请确认该 Session 是由当前新版 `codex3` 启动，',
      '并且 Local Release Agent 正在运行。',
    ].join('\n');
  }

  if (
    text.includes(
      'INVALID_RELEASE_RESULT',
    )
  ) {
    return [
      '⚠️ **Local Release Agent 返回了无效结果。**',
      '',
      '请使用 `/local-status` 再确认该 Session 的当前状态。',
    ].join('\n');
  }

  if (
    text.includes(
      'LAUNCH_MAPPING_NOT_FOUND',
    )
  ) {
    return [
      '⚠️ **没有找到该 Session 的 launch mapping。**',
      '',
      '该 Session 可能不是由当前自动监控机制启动的。',
    ].join('\n');
  }

  if (
    text.includes(
      'INVALID_PID_MAPPING',
    ) ||
    text.includes(
      'UNSAFE_PID_MAPPING',
    ) ||
    text.includes(
      'OWNER_PID_MISMATCH',
    ) ||
    text.includes(
      'CODEX_PARENT_MISMATCH',
    ) ||
    text.includes(
      'NOT_CODEX_PROCESS',
    ) ||
    text.includes(
      'CODEX_PID_REUSED',
    ) ||
    text.includes(
      'CREATION_TIME_VALIDATION_FAILED',
    )
  ) {
    return [
      '⛔ **Codex 进程身份校验失败。**',
      '',
      '为避免结束错误进程，本次 release 已取消。',
    ].join('\n');
  }

  if (
    text.includes(
      'OWNER_POWERSHELL_NOT_RUNNING',
    )
  ) {
    return [
      '⚠️ **对应的 Windows PowerShell 已不存在。**',
      '',
      '该 Session 的本地 launch mapping 可能已经过期。',
    ].join('\n');
  }

  if (
    text.includes(
      'CODEX_ROOT_NOT_RUNNING',
    )
  ) {
    return [
      '⚠️ **对应的 Windows Codex writer 已经不存在。**',
      '',
      '可以使用 `/local-status` 确认当前状态。',
    ].join('\n');
  }

  if (
    text.includes(
      'CODEX_TERMINATION_FAILED',
    )
  ) {
    return [
      '❌ **Windows Codex writer 释放失败。**',
      '',
      'Local Release Agent 已收到请求，但未能完成本地进程终止。',
    ].join('\n');
  }

  if (
    text.includes(
      'TASKKILL_NOT_FOUND',
    )
  ) {
    return [
      '❌ **Windows taskkill.exe 不可用。**',
      '',
      '无法完成本地 Codex writer 释放。',
    ].join('\n');
  }

  if (
    text.includes(
      'RELEASE_FAILED',
    )
  ) {
    return [
      '❌ **Local Release Agent 执行失败。**',
      '',
      '请使用 `/local-status` 确认 Session 当前状态。',
    ].join('\n');
  }

  return [
    '❌ **无法释放 Windows Codex Session。**',
    '',
    '本地安全检查或 Release Agent 执行失败。',
    '',
    text
      ? `详细信息：\n\`${text.slice(
          0,
          1200,
        )}\``
      : '没有返回进一步错误信息。',
  ].join('\n');
}

function getErrorText(
  error: unknown,
): string {
  if (
    typeof error !== 'object' ||
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
    };

  return [
    value.stdout,
    value.stderr,
    value.message,
  ]
    .filter(
      (item) =>
        item !== undefined &&
        item !== null &&
        String(item).trim() !== '',
    )
    .map(
      (item) =>
        String(item),
    )
    .join('\n');
}

export async function handleLocalRelease(
  args: string,
): Promise<string> {
  const selector =
    args.trim();

  if (!selector) {
    return [
      '⚠️ **需要提供 Thread 名称或 Session ID。**',
      '',
      '按 Thread 名称：',
      '',
      '`/local-release Online-Web-Forms`',
      '',
      '或者按 Session ID：',
      '',
      '`/local-release 01a0bb9a`',
      '',
      '可以先使用 `/local-status` 查看当前 Windows Codex Session。',
    ].join('\n');
  }

  try {
    const {
      stdout,
      stderr,
    } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        REQUEST_RELEASE_SCRIPT,
        '-SessionSelector',
        selector,
      ],
      {
        windowsHide: true,
        timeout: 25_000,
        encoding: 'utf8',
      },
    );

    const output =
      `${stdout}\n${stderr}`.trim();

    const match =
      output.match(
        /OK\|RELEASED\|([^|]+)\|(\d+)\|(\d+)/,
      );

    if (!match) {
      return formatError(
        output,
      );
    }

    const sessionId =
      match[1];

    return [
      '✅ **Windows Codex writer released**',
      '',
      `🏷 **Selector:** ${selector}`,
      '',
      `🔗 **Session:** \`${sessionId}\``,
      '',
      '🖥 Windows Codex writer 已退出。',
      '',
      '👁 对应 Observer 已由 `codex3` 清理。',
      '',
      '🟢 Windows Terminal 保持运行。',
      '',
      '**现在可以在 Lark 中 resume 这个 Session。**',
    ].join('\n');
  }
  catch (error: unknown) {
    return formatError(
      getErrorText(error),
    );
  }
}