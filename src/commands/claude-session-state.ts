import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  processState,
  type HandoffState,
  type LocalStatus,
  type SessionInventory,
  type SessionInventoryItem,
} from './local-session-state.js';
import { normalizeSessionPreview } from '../session/preview.js';

/*
 * Claude Code keeps everything this module needs under ~/.claude:
 *
 *   projects/<encoded-cwd>/<sessionId>.jsonl     the transcript
 *   projects/<encoded-cwd>/<sessionId>/          session-scoped sidecars
 *   sessions/<pid>.json                          LIVE process registry
 *
 * The registry is the reason Claude needs no Observer: it already carries
 * pid + sessionId + cwd + procStart + status, which is what ~/.codex-monitor's
 * status-*.json and launches/*.json provide for Codex.
 *
 * It is NOT a heartbeat, though: updatedAt only moves on activity or status
 * changes, so an idle session's entry legitimately goes minutes stale.
 * Liveness therefore comes from the PID (plus procStart, which the release
 * script checks against the live process creation time).
 */
const CLAUDE_HOME = join(homedir(), '.claude');
const PROJECTS_DIR = join(CLAUDE_HOME, 'projects');
const REGISTRY_DIR = join(CLAUDE_HOME, 'sessions');

/**
 * Where the bridge and the elevated Claude Release Agent
 * (scripts/windows/Watch-ClaudeRelease.ps1) exchange files.
 */
export const CLAUDE_MONITOR_HOME = join(homedir(), '.claude-monitor');

/** The agent rewrites its heartbeat every 2s; allow a few missed beats. */
const AGENT_FRESH_MS = 10_000;

/**
 * Entrypoints that are never a Windows writer. `claude -p` — including the
 * Lark bridge's own runs — registers as `sdk-cli` with kind "interactive", so
 * `kind` cannot tell them apart; `entrypoint` can.
 */
const NON_WRITER_ENTRYPOINT = /^sdk/i;

/** The only entrypoint the release script will terminate: a terminal window. */
const TERMINAL_ENTRYPOINT = 'cli';

/** Bytes scanned from each end of a transcript when hydrating metadata. */
const METADATA_WINDOW_BYTES = 64 * 1024;

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** One live `claude` process, as recorded in ~/.claude/sessions/<pid>.json. */
export interface ClaudeRegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  /** Windows FILETIME of process creation — the PID-reuse guard. */
  procStart?: string;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  nameSource?: string;
  status?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
  /**
   * Set by readClaudeRegistry(), not by Claude: the process is alive but this
   * bridge may not open it — it runs elevated (Run as administrator) and the
   * bridge does not. Only the elevated Claude Release Agent can release it.
   */
  accessDenied?: boolean;
}

export interface ClaudeSessionLocation {
  sessionId: string;
  transcriptPath: string;
  sidecarDir: string;
  mtimeMs: number;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export interface ReleaseAgentStatus {
  running: boolean;
  /** Only an elevated agent can release an elevated Claude window. */
  elevated: boolean;
}

/**
 * Whether the Claude Release Agent is up, judged by its heartbeat file.
 *
 * Deliberately not a PID probe: the agent is elevated and the bridge is not,
 * which is exactly the situation where probing a process misleads.
 */
export function readReleaseAgentStatus(now = Date.now()): ReleaseAgentStatus {
  const beat = readJson<{ updatedAt?: number; elevated?: boolean }>(
    join(CLAUDE_MONITOR_HOME, 'agent.json'),
  );
  const running =
    typeof beat?.updatedAt === 'number' && now - beat.updatedAt <= AGENT_FRESH_MS;
  return { running, elevated: running && beat?.elevated === true };
}

/**
 * Read the live-process registry, keyed by sessionId.
 *
 * Entries whose PID is gone are dropped: Claude removes its file on a clean
 * exit, but a hard kill leaves one behind and a stale entry must never be
 * mistaken for an owned session. SDK entries (`claude -p`) are dropped too:
 * they are Lark's own runs, not Windows windows. When two PIDs claim the same
 * session the most recently updated one wins.
 *
 * Unknown entrypoints (e.g. an IDE integration) are kept deliberately: a
 * false "Windows-active" only blocks /session use, whereas a false "detached"
 * would allow two writers on one session.
 */
export function readClaudeRegistry(): Map<string, ClaudeRegistryEntry> {
  const bySession = new Map<string, ClaudeRegistryEntry>();

  let files: string[];
  try {
    files = readdirSync(REGISTRY_DIR);
  } catch {
    return bySession;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const entry = readJson<ClaudeRegistryEntry>(join(REGISTRY_DIR, file));
    if (!entry?.sessionId || typeof entry.pid !== 'number') continue;
    if (entry.entrypoint && NON_WRITER_ENTRYPOINT.test(entry.entrypoint)) continue;
    const state = processState(entry.pid);
    if (state === 'gone') continue;
    if (state === 'denied') entry.accessDenied = true;

    const existing = bySession.get(entry.sessionId);
    if (existing && (existing.updatedAt ?? 0) >= (entry.updatedAt ?? 0)) continue;

    bySession.set(entry.sessionId, entry);
  }

  return bySession;
}

/**
 * Every transcript under ~/.claude/projects, newest first.
 *
 * Enumerates real *.jsonl files rather than trusting an index. Older Claude
 * Code versions wrote a per-project sessions-index.json, but it outlives the
 * transcripts it lists (Claude's periodic cleanup deletes old transcripts and
 * leaves the index), so reading it would produce phantom rows.
 */
export function listClaudeSessionFiles(): ClaudeSessionLocation[] {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }

  const found: ClaudeSessionLocation[] = [];

  for (const projectDir of projectDirs) {
    const dir = join(PROJECTS_DIR, projectDir);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const match = SESSION_FILE_RE.exec(entry);
      if (!match) continue;

      const sessionId = match[1]!;
      const transcriptPath = join(dir, entry);

      let mtimeMs: number;
      try {
        const stats = statSync(transcriptPath);
        if (!stats.isFile()) continue;
        mtimeMs = stats.mtimeMs;
      } catch {
        continue;
      }

      found.push({
        sessionId,
        transcriptPath,
        sidecarDir: join(dir, sessionId),
        mtimeMs,
      });
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/**
 * Derive the handoff state for a Claude session.
 *
 * Mirrors getHandoffState() for Codex, including its division of labour: this
 * function performs structural checks only. Authoritative process-identity
 * validation (procStart match, image name, PID reuse) belongs to the release
 * step, which is the only place where acting on a wrong PID would be harmful.
 *
 * Unlike Codex, every Claude 'needs-validation' is also non-transferable: the
 * release script refuses each of these cases, so offering Handoff would only
 * produce a guaranteed failure.
 */
export function claudeHandoffState(
  entry: ClaudeRegistryEntry | undefined,
  {
    hasTranscript = true,
    elevatedAgent = false,
  }: { hasTranscript?: boolean; elevatedAgent?: boolean } = {},
): HandoffState {
  if (!entry) {
    return {
      code: 'detached',
      windowsActive: false,
      observerFresh: false,
      observerAlive: false,
      writerAlive: false,
      releaseAgentAlive: false,
    };
  }

  // The claude process is its own writer; readClaudeRegistry() already proved
  // its PID alive. There is no separate observer or release agent.
  const base = {
    windowsActive: true,
    observerFresh: true,
    observerAlive: true,
    writerAlive: true,
    releaseAgentAlive: false,
  };

  const status = entry.status?.toLowerCase();

  if (status === 'busy') {
    return { ...base, code: 'busy', reason: 'Claude is working' };
  }

  const blocked = (reason: string): HandoffState => ({
    ...base,
    code: 'needs-validation',
    reason,
    transferable: false,
  });

  // Only a status known to be safe to interrupt may become 'ready'.
  if (status !== 'idle') {
    return blocked(`Unknown status: ${entry.status ?? 'missing'}`);
  }

  if (entry.entrypoint !== TERMINAL_ENTRYPOINT) {
    return blocked(`Open in ${entry.entrypoint ?? 'an unknown client'} — close it there`);
  }

  // Windows refuses to let a non-elevated bridge inspect or terminate an
  // elevated process; only the elevated Release Agent can do it.
  if (entry.accessDenied && !elevatedAgent) {
    return blocked('Running as administrator — Claude release agent not running');
  }

  // Nothing has been said yet: there is no conversation to resume in Lark.
  if (!hasTranscript) {
    return blocked('No conversation yet');
  }

  if (!entry.procStart) {
    return blocked('Process identity unavailable');
  }

  return { ...base, code: 'ready' };
}

/** How a live registry entry reads on the card, e.g. "Windows · Waiting". */
function registryStatus(sessionId: string, entry: ClaudeRegistryEntry): LocalStatus {
  return {
    sessionId,
    ...(entry.cwd ? { cwd: entry.cwd, projectName: basename(entry.cwd) } : {}),
    ...(entry.name ? { threadName: entry.name } : {}),
    ...(entry.version ? { cliVersion: entry.version } : {}),
    state: entry.status === 'busy' ? 'Working' : 'Waiting',
    ...(entry.updatedAt ? { lastEventTime: new Date(entry.updatedAt).toISOString() } : {}),
  };
}

/**
 * Build the Claude session inventory.
 *
 * Deliberately cheap: session id comes from the filename and the timestamp
 * from the file's mtime, so no transcript is opened here. cwd and title are
 * filled in later by hydrateClaudeItem(), which the card layer calls only for
 * the handful of sessions it actually renders.
 */
export function buildClaudeInventory(): SessionInventory {
  const registry = readClaudeRegistry();
  const { elevated: elevatedAgent } = readReleaseAgentStatus();
  const items: SessionInventoryItem[] = [];
  const seen = new Set<string>();

  for (const location of listClaudeSessionFiles()) {
    const entry = registry.get(location.sessionId);
    seen.add(location.sessionId);

    items.push({
      sessionId: location.sessionId,
      // SessionInventoryItem.rolloutPath is the agent-neutral "transcript on
      // disk" slot; for Claude that is the projects/<cwd>/<id>.jsonl file.
      rolloutPath: location.transcriptPath,
      updatedAtMs: Math.max(location.mtimeMs, entry?.updatedAt ?? 0),
      ...(entry?.cwd ? { cwd: entry.cwd, projectName: basename(entry.cwd) } : {}),
      ...(entry?.name ? { threadName: entry.name } : {}),
      ...(entry ? { status: registryStatus(location.sessionId, entry) } : {}),
      handoff: claudeHandoffState(entry, { elevatedAgent }),
    });
  }

  /*
   * A window that has not been sent anything yet is running but has written
   * no transcript, so the file scan above cannot see it. List it from the
   * registry alone: it is a real Windows session, just not transferable yet.
   */
  for (const [sessionId, entry] of registry) {
    if (seen.has(sessionId)) continue;

    items.push({
      sessionId,
      updatedAtMs: entry.updatedAt ?? entry.startedAt ?? 0,
      ...(entry.cwd ? { cwd: entry.cwd, projectName: basename(entry.cwd) } : {}),
      ...(entry.name ? { threadName: entry.name } : {}),
      status: registryStatus(sessionId, entry),
      handoff: claudeHandoffState(entry, { hasTranscript: false, elevatedAgent }),
    });
  }

  items.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return { items };
}

/**
 * Fill in cwd / title for a single session by reading small windows from each
 * end of its transcript.
 *
 * cwd must come from the file's contents: the project directory name is a
 * lossy encoding (`[^A-Za-z0-9]` → `-`, so `E:\AI_Tools\lark-sessions` becomes
 * `E--AI-Tools-lark-sessions`) and cannot be decoded back into a real path.
 */
export function hydrateClaudeItem(item: SessionInventoryItem): SessionInventoryItem {
  if (item.cwd && item.threadName) return item;

  const transcriptPath = item.rolloutPath;
  if (!transcriptPath) return item;

  const next = { ...item };

  if (!next.threadName) {
    const sidecarDir = transcriptPath.replace(/\.jsonl$/i, '');
    const custom = readJson<{ customTitle?: string }>(join(sidecarDir, 'custom-title.json'));
    const customTitle = custom?.customTitle?.trim();
    if (customTitle) next.threadName = customTitle;
  }

  const head = readWindow(transcriptPath, 'head');
  const tail = readWindow(transcriptPath, 'tail');

  if (!next.cwd) {
    const cwd = findCwd(head) ?? findCwd(tail);
    if (cwd) {
      next.cwd = cwd;
      next.projectName = basename(cwd);
    }
  }

  if (!next.threadName) {
    // ai-title is rewritten as the conversation evolves, so the last one wins.
    next.threadName = findLastAiTitle(tail) ?? findFirstUserPrompt(head);
  }

  return next;
}

type WindowEnd = 'head' | 'tail';

function readWindow(path: string, end: WindowEnd): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size <= 0) return '';

    const length = Math.min(size, METADATA_WINDOW_BYTES);
    const start = end === 'head' ? 0 : size - length;

    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');

    // A tail window almost certainly starts mid-line; drop that fragment.
    if (end === 'tail' && start > 0) {
      const newline = text.indexOf('\n');
      return newline === -1 ? '' : text.slice(newline + 1);
    }

    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function* parseLines(text: string, reverse = false): Generator<any> {
  const lines = text.split(/\r?\n/);
  const ordered = reverse ? lines.reverse() : lines;

  for (const line of ordered) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      /* partial or malformed line */
    }
  }
}

function findCwd(text: string): string | undefined {
  for (const record of parseLines(text)) {
    const cwd = record?.cwd;
    if (typeof cwd === 'string' && cwd.trim()) return cwd.trim();
  }
  return undefined;
}

function findLastAiTitle(text: string): string | undefined {
  for (const record of parseLines(text, true)) {
    if (record?.type !== 'ai-title') continue;
    const title = record.aiTitle;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return undefined;
}

function findFirstUserPrompt(text: string): string | undefined {
  for (const record of parseLines(text)) {
    if (record?.type !== 'user' || record?.isSidechain === true) continue;

    const content = record.message?.content;
    const promptText =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
              .map((part: any) => part.text)
              .join(' ')
          : '';

    // Lark-run sessions start with the bridge's wrapped prompt; this unwraps
    // its <user_input> section so the title is what the user actually typed.
    const normalized = normalizeSessionPreview(promptText, 60);
    if (normalized) return normalized;
  }
  return undefined;
}
