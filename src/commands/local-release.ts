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

function formatError(text: string): string {
  if (text.includes('SESSION_NOT_FOUND')) {
    return [
      '❌ **没有找到对应的 Windows Codex Session。**',
      '',
      '请先使用 `/local-status` 查看当前 Session。',
    ].join('\n');
  }

  if (text.includes('AMBIGUOUS_SESSION')) {
    return [
      '❌ **Session ID 前缀不唯一。**',
      '',
      '请提供更多位 Session ID。',
      '',
      '例如：',
      '',
      '`/local-release 01a0bd5f`',
    ].join('\n');
  }

  if (text.includes('SESSION_NOT_WAITING')) {
    return [
      '⛔ **该 Session 当前不是 Waiting。**',
      '',
      '为避免中断正在运行的任务，',
      '只有 `Waiting` 状态才能执行 `/local-release`。',
    ].join('\n');
  }

  if (text.includes('OBSERVER_NOT_RUNNING')) {
    return [
      '⚠️ **Observer 当前没有运行。**',
      '',
      '为避免释放错误的 Session，本次操作已取消。',
    ].join('\n');
  }

  if (text.includes('RELEASE_REQUEST_TIMEOUT')) {
    return [
      '⚠️ **Local Release Agent 没有及时响应。**',
      '',
      'Windows Codex writer 没有被释放。',
      '',
      '请确认当前 Session 是由新版 `codex3` 启动，',
      '并且 `Watch-CodexRelease.ps1` 正在运行。',
    ].join('\n');
  }

  if (text.includes('INVALID_RELEASE_RESULT')) {
    return [
      '⚠️ **Local Release Agent 返回了无效结果。**',
      '',
      'Windows Codex 是否已退出需要进一步确认。',
    ].join('\n');
  }

  if (text.includes('STALE_OBSERVER')) {
    return [
      '⚠️ **Observer heartbeat 已过期。**',
      '',
      '为避免释放错误的 Session，本次操作已取消。',
    ].join('\n');
  }

  if (text.includes('LAUNCH_MAPPING_NOT_FOUND')) {
    return [
      '⚠️ **没有找到该 Session 的 launch mapping。**',
      '',
      '该 Session 可能不是由当前自动监控机制启动的。',
    ].join('\n');
  }

  if (
    text.includes('OWNER_PID_MISMATCH') ||
    text.includes('CODEX_PARENT_MISMATCH') ||
    text.includes('NOT_CODEX_PROCESS') ||
    text.includes('CODEX_PID_REUSED') ||
    text.includes('INVALID_PID_MAPPING') ||
    text.includes('UNSAFE_PID_MAPPING')
  ) {
    return [
      '⛔ **Codex 进程身份校验失败。**',
      '',
      '为避免结束错误进程，本次 release 已取消。',
    ].join('\n');
  }

  if (text.includes('CODEX_ROOT_NOT_RUNNING')) {
    return [
      '⚠️ **Windows Codex 进程已经不存在。**',
      '',
      '该 Session 可能已经在本地退出。',
    ].join('\n');
  }

  if (text.includes('CODEX_TERMINATION_FAILED')) {
    return [
      '❌ **Windows Codex 进程释放失败。**',
      '',
      'Local Release Agent 已收到请求，但无法完成进程终止。',
    ].join('\n');
  }

  return [
    '❌ **无法释放 Windows Codex Session。**',
    '',
    '本地安全检查或 Release Agent 执行失败。',
    '',
    text
      ? `详细信息：\n\`${text.slice(0, 1200)}\``
      : '没有返回进一步错误信息。',
  ].join('\n');
}

export async function handleLocalRelease(
  args: string,
): Promise<string> {
  const prefix = args.trim();

  if (!prefix) {
    return [
      '⚠️ **需要提供 Session ID 前缀。**',
      '',
      '例如：',
      '',
      '`/local-release 01a0bd5f`',
      '',
      '可以先使用 `/local-status` 查看当前 Windows Codex Session。',
    ].join('\n');
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        REQUEST_RELEASE_SCRIPT,
        '-SessionPrefix',
        prefix,
      ],
      {
        windowsHide: true,
        timeout: 20_000,
        encoding: 'utf8',
      },
    );

    const output = `${stdout}\n${stderr}`.trim();

    const match = output.match(
      /OK\|RELEASED\|([^|]+)\|(\d+)\|(\d+)/,
    );

    if (!match) {
      return formatError(output);
    }

    const sessionId = match[1];

    return [
      '✅ **Windows Codex writer released**',
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
  catch (error: any) {
    const output = [
      error?.stdout,
      error?.stderr,
      error?.message,
    ]
      .filter(Boolean)
      .map((value) => String(value))
      .join('\n');

    return formatError(output);
  }
}