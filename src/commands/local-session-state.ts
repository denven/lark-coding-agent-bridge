import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const MONITOR_HOME = join(
  homedir(),
  '.codex-monitor',
);

export const OBSERVER_FRESH_MS = 30_000;

export interface LocalStatus {
  version?: number;

  sessionId: string;

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

  state?: string;
  lastActivity?: string;
  lastEventType?: string;
  lastEventTime?: string;

  observerPid?: number;
  observerState?: string;
  observerStartedAt?: string;
  observerUpdatedAt?: string;

  tokenUsage?: {
    total?: number;
    input?: number;
    cachedInput?: number;
    output?: number;
    reasoningOutput?: number;
  };

  contextWindow?: {
    used?: number;
    total?: number;
    percentLeft?: number;
  };
}

export interface LaunchMapping {
  version?: number;

  launchId?: string;
  sessionId?: string;

  cwd?: string;
  codexHome?: string;

  ownerPowerShellPid?: number;

  codexRootPid?: number;
  codexRootParentPid?: number;
  codexRootName?: string;
  codexRootCommandLine?: string;
  codexRootCreatedAt?: string;

  rolloutPath?: string;

  observerPid?: number;
  releaseAgentPid?: number;

  attachedAt?: string;
}

export interface DetachedMarker {
  version: 1;

  sessionId: string;
  detachedAt: string;
  reason?: string;
}

interface DetachedMarkerRecord {
  marker: DetachedMarker;
  time: number;
}

interface LaunchMappingRecord {
  launch: LaunchMapping;
  time: number;
}

export type HandoffCode =
  | 'ready'
  | 'busy'
  | 'needs-validation'
  | 'detached';

export interface HandoffState {
  code: HandoffCode;

  windowsActive: boolean;

  observerFresh: boolean;
  observerAlive: boolean;
  writerAlive: boolean;
  releaseAgentAlive: boolean;

  reason?: string;

  /**
   * False when no one-click Windows → Lark transfer can succeed, so the card
   * offers neither a Handoff tab entry nor a button. Undefined means the
   * release step itself decides (Codex's needs-validation relies on that).
   */
  transferable?: boolean;

  launch?: LaunchMapping;
}

export interface LarkBinding {
  scope: string;

  sessionId: string;
  cwd?: string;

  updatedAt?: number;

  current: boolean;
}

export interface SessionInventoryItem {
  sessionId: string;

  threadName?: string;

  cwd?: string;
  projectName?: string;

  updatedAtMs: number;

  rolloutPath?: string;

  status?: LocalStatus;

  handoff: HandoffState;
}

export interface SessionInventory {
  codexHome?: string;

  items: SessionInventoryItem[];
}

interface SessionIndexEntry {
  sessionId: string;

  threadName?: string;

  updatedAtMs: number;

  order: number;
}

interface RolloutMeta {
  sessionId?: string;

  cwd?: string;

  cliVersion?: string;
  modelProvider?: string;
}

export type SessionResolveResult =
  | {
      ok: true;

      item: SessionInventoryItem;
    }
  | {
      ok: false;

      code:
        | 'empty'
        | 'not-found'
        | 'ambiguous';

      message: string;

      matches?: SessionInventoryItem[];
    };

function readJsonFile<T>(
  path: string,
): T | undefined {
  try {
    const raw = readFileSync(
      path,
      'utf8',
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
    ) as T;
  }
  catch {
    return undefined;
  }
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

function statusUpdatedAt(
  status: LocalStatus,
): number {
  return Math.max(
    toTime(
      status.threadNameUpdatedAt,
    ),
    toTime(
      status.lastEventTime,
    ),
    toTime(
      status.observerUpdatedAt,
    ),
  );
}

/**
 * 'denied' means the process exists but this process may not open it — on
 * Windows, a non-elevated bridge probing an elevated (Run as administrator)
 * process gets EPERM. It must never be read as "gone".
 */
export type ProcessState =
  | 'alive'
  | 'denied'
  | 'gone';

export function processState(
  pid: unknown,
): ProcessState {
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return 'gone';
  }

  try {
    process.kill(
      pid,
      0,
    );

    return 'alive';
  }
  catch (error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
      ? 'denied'
      : 'gone';
  }
}

export function isProcessAlive(
  pid: unknown,
): boolean {
  return processState(pid) !== 'gone';
}

export function isFreshTimestamp(
  value: unknown,
  maxAgeMs = OBSERVER_FRESH_MS,
): boolean {
  if (
    typeof value !== 'string' ||
    !value
  ) {
    return false;
  }

  const timestamp =
    Date.parse(value);

  if (
    !Number.isFinite(timestamp)
  ) {
    return false;
  }

  const age =
    Date.now() -
    timestamp;

  /*
   * A small negative value can happen because of
   * clock granularity. Treat it as fresh.
   */
  return (
    age >= -5_000 &&
    age <= maxAgeMs
  );
}

export function readMonitorStatuses():
  LocalStatus[] {
  if (
    !existsSync(
      MONITOR_HOME,
    )
  ) {
    return [];
  }

  let names: string[];

  try {
    names =
      readdirSync(
        MONITOR_HOME,
      );
  }
  catch {
    return [];
  }

  const result: LocalStatus[] = [];

  for (const name of names) {
    if (
      !name.startsWith(
        'status-',
      ) ||
      !name.endsWith(
        '.json',
      )
    ) {
      continue;
    }

    const status =
      readJsonFile<LocalStatus>(
        join(
          MONITOR_HOME,
          name,
        ),
      );

    if (
      !status ||
      typeof status.sessionId !==
        'string' ||
      !status.sessionId
    ) {
      continue;
    }

    result.push(
      status,
    );
  }

  return result;
}

function safeSessionFileName(
  sessionId: string,
): string {
  return sessionId.replace(
    /[^A-Za-z0-9._-]/g,
    '_',
  );
}

function detachedMarkerPath(
  sessionId: string,
): string {
  return join(
    MONITOR_HOME,
    'detached',
    `${safeSessionFileName(sessionId)}.json`,
  );
}

function readDetachedMarkerRecord(
  sessionId: string,
): DetachedMarkerRecord | undefined {
  const path = detachedMarkerPath(sessionId);
  const marker = readJsonFile<DetachedMarker>(path);

  if (
    !marker ||
    marker.sessionId !== sessionId ||
    typeof marker.detachedAt !== 'string'
  ) {
    return undefined;
  }

  const parsed = toTime(marker.detachedAt);
  let time = parsed;

  if (time <= 0) {
    try {
      time = statSync(path).mtimeMs;
    }
    catch {
      time = 0;
    }
  }

  return { marker, time };
}

/**
 * Persist explicit evidence that no Windows writer currently owns this
 * Session. The marker remains valid until a newer Windows launch mapping is
 * created by Attach-CodexObserver.ps1. This prevents a stale/fresh-for-a-few-
 * seconds Observer heartbeat from incorrectly re-claiming Windows ownership
 * after handoff or handback.
 */
export function markSessionDetached(
  sessionId: string,
  reason = 'detached',
): boolean {
  const dir = join(
    MONITOR_HOME,
    'detached',
  );

  const path = detachedMarkerPath(sessionId);

  const marker: DetachedMarker = {
    version: 1,
    sessionId,
    detachedAt: new Date().toISOString(),
    reason,
  };

  try {
    mkdirSync(
      dir,
      { recursive: true },
    );

    writeFileSync(
      path,
      JSON.stringify(
        marker,
        null,
        2,
      ),
      'utf8',
    );

    return true;
  }
  catch {
    return false;
  }
}

function launchTimestamp(
  path: string,
  launch: LaunchMapping,
): number {
  const attached =
    toTime(
      launch.attachedAt,
    );

  if (attached > 0) {
    return attached;
  }

  try {
    return statSync(
      path,
    ).mtimeMs;
  }
  catch {
    return 0;
  }
}

function getLatestLaunchMappingRecord(
  sessionId: string,
): LaunchMappingRecord | undefined {
  const dir =
    join(
      MONITOR_HOME,
      'launches',
    );

  if (
    !existsSync(dir)
  ) {
    return undefined;
  }

  let names: string[];

  try {
    names =
      readdirSync(dir);
  }
  catch {
    return undefined;
  }

  let selected:
    | LaunchMappingRecord
    | undefined;

  for (const name of names) {
    if (
      !name.endsWith(
        '.json',
      )
    ) {
      continue;
    }

    const path =
      join(
        dir,
        name,
      );

    const launch =
      readJsonFile<LaunchMapping>(
        path,
      );

    if (
      !launch ||
      launch.sessionId !==
        sessionId
    ) {
      continue;
    }

    const time =
      launchTimestamp(
        path,
        launch,
      );

    if (
      !selected ||
      time >= selected.time
    ) {
      selected = {
        launch,
        time,
      };
    }
  }

  return selected;
}

export function getLatestLaunchMapping(
  sessionId: string,
): LaunchMapping | undefined {
  return getLatestLaunchMappingRecord(
    sessionId,
  )?.launch;
}

export function getHandoffState(
  status: LocalStatus,
): HandoffState {
  const launchRecord =
    getLatestLaunchMappingRecord(
      status.sessionId,
    );

  const launch =
    launchRecord?.launch;

  const detachedRecord =
    readDetachedMarkerRecord(
      status.sessionId,
    );

  /*
   * An explicit detached marker is authoritative until a newer Windows
   * launch exists. This is the durable ownership boundary used by handoff
   * and handback. Observer heartbeat alone is telemetry and must not reclaim
   * ownership after the corresponding Windows writer was released.
   */
  const explicitlyDetached =
    detachedRecord !== undefined &&
    (
      !launchRecord ||
      detachedRecord.time >=
        launchRecord.time
    );

  const observerPid =
    status.observerPid ??
    launch?.observerPid;

  /*
   * A fresh Observer heartbeat is itself strong
   * evidence that the Windows Codex lifecycle is
   * currently active.
   *
   * Do not require a second PID probe merely to
   * decide Windows ownership.
   */
  const observerFresh =
    String(
      status.observerState ?? '',
    )
      .trim()
      .toLowerCase() ===
      'running' &&
    isFreshTimestamp(
      status.observerUpdatedAt,
    );

  const observerAlive =
    observerFresh ||
    isProcessAlive(
      observerPid,
    );

  /*
   * These PID checks are useful diagnostics,
   * but codexRootPid is NOT authoritative enough
   * to block handoff by itself.
   *
   * The PowerShell release chain performs the
   * final process identity validation.
   */
  const writerAlive =
    isProcessAlive(
      launch?.codexRootPid,
    );

  const releaseAgentAlive =
    isProcessAlive(
      launch?.releaseAgentPid,
    );

  /*
   * Windows ownership:
   *
   * Fresh Observer heartbeat is sufficient.
   * writerAlive is retained as a fallback.
   */
  const windowsActive =
    !explicitlyDetached &&
    (
      observerFresh ||
      writerAlive
    );

  if (!windowsActive) {
    return {
      code: 'detached',

      windowsActive: false,

      observerFresh,
      observerAlive,
      writerAlive,
      releaseAgentAlive,

      reason:
        explicitlyDetached
          ? detachedRecord?.marker.reason ??
            'Explicitly detached'
          : undefined,

      launch,
    };
  }

  const activityState =
    String(
      status.state ?? '',
    )
      .trim()
      .toLowerCase();

  /*
   * A Windows Session that is still executing
   * should never be handed off automatically.
   */
  if (
    activityState !==
    'waiting'
  ) {
    return {
      code: 'busy',

      windowsActive: true,

      observerFresh,
      observerAlive,
      writerAlive,
      releaseAgentAlive,

      reason:
        status.state ||
        'Codex is active',

      launch,
    };
  }

  /*
   * From this point the Session is Waiting.
   *
   * Missing metadata means TypeScript cannot
   * fully pre-validate the handoff, but it does
   * NOT mean handoff must be rejected.
   *
   * Request-CodexRelease.ps1 remains the
   * authoritative validator.
   */
  if (
    !observerFresh
  ) {
    return {
      code:
        'needs-validation',

      windowsActive: true,

      observerFresh,
      observerAlive,
      writerAlive,
      releaseAgentAlive,

      reason:
        'Observer heartbeat stale',

      launch,
    };
  }

  if (!launch) {
    return {
      code:
        'needs-validation',

      windowsActive: true,

      observerFresh,
      observerAlive,
      writerAlive,
      releaseAgentAlive,

      reason:
        'Launch mapping unavailable',
    };
  }

  if (
    typeof launch.releaseAgentPid !==
      'number' ||
    !Number.isInteger(
      launch.releaseAgentPid,
    ) ||
    launch.releaseAgentPid <= 0
  ) {
    return {
      code:
        'needs-validation',

      windowsActive: true,

      observerFresh,
      observerAlive,
      writerAlive,
      releaseAgentAlive,

      reason:
        'Release Agent not recorded',

      launch,
    };
  }

  /*
   * At this point TypeScript has enough structural
   * evidence to consider handoff ready:
   *
   * - Windows Observer heartbeat is fresh
   * - Codex activity state is Waiting
   * - current launch mapping exists
   * - a Release Agent PID was recorded
   *
   * Do NOT require process.kill(pid, 0) here.
   *
   * Request-CodexRelease.ps1 /
   * Release-CodexSession.ps1 perform the
   * authoritative runtime process validation.
   */
  return {
    code: 'ready',

    windowsActive: true,

    observerFresh,
    observerAlive,
    writerAlive,
    releaseAgentAlive,

    launch,
  };
}

export function formatHandoffState(
  handoff: HandoffState,
): string {
  switch (
    handoff.code
  ) {
    case 'ready':
      return '🟢 Ready';

    case 'busy':
      return `🔵 Busy${
        handoff.reason
          ? ` · ${handoff.reason}`
          : ''
      }`;

    case 'needs-validation':
      return `🟡 Needs validation${
        handoff.reason
          ? ` · ${handoff.reason}`
          : ''
      }`;

    case 'detached':
    default:
      return '⚪ Detached';
  }
}

export function handoffLabelForStatus(
  status: LocalStatus,
): string {
  return formatHandoffState(
    getHandoffState(
      status,
    ),
  );
}

function deriveCodexHomeFromRollout(
  rolloutPath: string,
): string | undefined {
  const match =
    rolloutPath.match(
      /^(.*?)[\\/]sessions[\\/]/i,
    );

  return match?.[1];
}

export function resolveCodexHome(
  statuses =
    readMonitorStatuses(),
): string | undefined {
  const candidates: string[] = [];

  for (const status of statuses) {
    if (!status.rolloutPath) {
      continue;
    }

    const derived =
      deriveCodexHomeFromRollout(
        status.rolloutPath,
      );

    if (derived) {
      candidates.push(
        derived,
      );
    }
  }

  if (
    process.env.CODEX_HOME
  ) {
    candidates.push(
      process.env.CODEX_HOME,
    );
  }

  candidates.push(
    join(
      homedir(),
      '.codex-cli-thirdparty',
    ),
  );

  candidates.push(
    join(
      homedir(),
      '.codex',
    ),
  );

  const seen =
    new Set<string>();

  for (const candidate of candidates) {
    const key =
      candidate.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    if (
      existsSync(
        join(
          candidate,
          'sessions',
        ),
      ) ||
      existsSync(
        join(
          candidate,
          'session_index.jsonl',
        ),
      )
    ) {
      return candidate;
    }
  }

  return undefined;
}

function readSessionIndex(
  codexHome: string,
): SessionIndexEntry[] {
  const path =
    join(
      codexHome,
      'session_index.jsonl',
    );

  if (
    !existsSync(path)
  ) {
    return [];
  }

  let raw: string;

  try {
    /*
     * Explicit UTF-8 is important for Windows
     * PowerShell-created thread names.
     */
    raw =
      readFileSync(
        path,
        'utf8',
      );
  }
  catch {
    return [];
  }

  const latest =
    new Map<
      string,
      SessionIndexEntry
    >();

  const lines =
    raw.split(
      /\r?\n/,
    );

  let order = 0;

  for (const line of lines) {
    order += 1;

    if (!line.trim()) {
      continue;
    }

    try {
      const value =
        JSON.parse(
          line,
        ) as {
          id?: unknown;
          thread_name?: unknown;
          updated_at?: unknown;
        };

      if (
        typeof value.id !==
          'string' ||
        !value.id
      ) {
        continue;
      }

      const updatedAtMs =
        typeof value.updated_at ===
          'string'
          ? (
              Date.parse(
                value.updated_at,
              ) || 0
            )
          : 0;

      const entry:
        SessionIndexEntry = {
          sessionId:
            value.id,

          threadName:
            typeof value.thread_name ===
              'string' &&
            value.thread_name.trim()
              ? value.thread_name.trim()
              : undefined,

          updatedAtMs,

          order,
        };

      const previous =
        latest.get(
          value.id,
        );

      if (
        !previous ||
        entry.updatedAtMs >
          previous.updatedAtMs ||
        (
          entry.updatedAtMs ===
            previous.updatedAtMs &&
          entry.order >
            previous.order
        )
      ) {
        latest.set(
          value.id,
          entry,
        );
      }
    }
    catch {
      /*
       * session_index is append-only.
       * Ignore malformed/truncated records.
       */
    }
  }

  return [
    ...latest.values(),
  ];
}

function walkRollouts(
  directory: string,
  result: Map<string, string>,
): void {
  let entries;

  try {
    entries =
      readdirSync(
        directory,
        {
          withFileTypes: true,
        },
      );
  }
  catch {
    return;
  }

  for (const entry of entries) {
    const path =
      join(
        directory,
        entry.name,
      );

    if (
      entry.isDirectory()
    ) {
      walkRollouts(
        path,
        result,
      );

      continue;
    }

    if (
      !entry.isFile() ||
      !entry.name.endsWith(
        '.jsonl',
      )
    ) {
      continue;
    }

    const match =
      entry.name.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
      );

    if (!match?.[1]) {
      continue;
    }

    result.set(
      match[1],
      path,
    );
  }
}

function listRolloutPaths(
  codexHome: string,
): Map<string, string> {
  const result =
    new Map<
      string,
      string
    >();

  const root =
    join(
      codexHome,
      'sessions',
    );

  if (
    existsSync(root)
  ) {
    walkRollouts(
      root,
      result,
    );
  }

  return result;
}

function readRolloutMeta(
  path: string,
): RolloutMeta {
  const MAX_BYTES =
    2 * 1024 * 1024;

  const buffer =
    Buffer.alloc(
      MAX_BYTES,
    );

  let fd:
    | number
    | undefined;

  try {
    fd =
      openSync(
        path,
        'r',
      );

    const bytes =
      readSync(
        fd,
        buffer,
        0,
        MAX_BYTES,
        0,
      );

    const text =
      buffer
        .subarray(
          0,
          bytes,
        )
        .toString(
          'utf8',
        );

    for (
      const line of text.split(
        /\r?\n/,
      )
    ) {
      if (!line.trim()) {
        continue;
      }

      let value: any;

      try {
        value =
          JSON.parse(
            line,
          );
      }
      catch {
        continue;
      }

      if (
        value?.type !==
          'session_meta'
      ) {
        continue;
      }

      const payload =
        value.payload ??
        {};

      return {
        sessionId:
          typeof payload.session_id ===
            'string'
            ? payload.session_id
            : (
                typeof payload.id ===
                  'string'
                  ? payload.id
                  : undefined
              ),

        cwd:
          typeof payload.cwd ===
            'string'
            ? payload.cwd
            : undefined,

        cliVersion:
          typeof payload.cli_version ===
            'string'
            ? payload.cli_version
            : undefined,

        modelProvider:
          typeof payload.model_provider ===
            'string'
            ? payload.model_provider
            : undefined,
      };
    }
  }
  catch {
    return {};
  }
  finally {
    if (
      fd !== undefined
    ) {
      try {
        closeSync(fd);
      }
      catch {
        // Ignore close errors.
      }
    }
  }

  return {};
}

function detachedHandoff():
  HandoffState {
  return {
    code: 'detached',

    windowsActive: false,

    observerFresh: false,
    observerAlive: false,
    writerAlive: false,
    releaseAgentAlive: false,
  };
}

export function buildSessionInventory():
  SessionInventory {
  const statuses =
    readMonitorStatuses();

  const codexHome =
    resolveCodexHome(
      statuses,
    );

  const indexEntries =
    codexHome
      ? readSessionIndex(
          codexHome,
        )
      : [];

  const rolloutPaths =
    codexHome
      ? listRolloutPaths(
          codexHome,
        )
      : new Map<
          string,
          string
        >();

  const items =
    new Map<
      string,
      SessionInventoryItem
    >();

  for (
    const entry of indexEntries
  ) {
    items.set(
      entry.sessionId,
      {
        sessionId:
          entry.sessionId,

        threadName:
          entry.threadName,

        updatedAtMs:
          entry.updatedAtMs,

        rolloutPath:
          rolloutPaths.get(
            entry.sessionId,
          ),

        handoff:
          detachedHandoff(),
      },
    );
  }

  for (
    const status of statuses
  ) {
    const previous =
      items.get(
        status.sessionId,
      );

    const updatedAtMs =
      Math.max(
        previous?.updatedAtMs ??
          0,
        statusUpdatedAt(
          status,
        ),
      );

    items.set(
      status.sessionId,
      {
        sessionId:
          status.sessionId,

        threadName:
          status.threadName ??
          previous?.threadName,

        cwd:
          status.cwd ??
          previous?.cwd,

        projectName:
          status.projectName ??
          previous?.projectName,

        updatedAtMs,

        rolloutPath:
          status.rolloutPath ??
          previous?.rolloutPath ??
          rolloutPaths.get(
            status.sessionId,
          ),

        status,

        handoff:
          getHandoffState(
            status,
          ),
      },
    );
  }

  const result =
    [
      ...items.values(),
    ];

  result.sort(
    (
      a,
      b,
    ) =>
      b.updatedAtMs -
      a.updatedAtMs,
  );

  return {
    codexHome,
    items: result,
  };
}

export function hydrateInventoryItem(
  item: SessionInventoryItem,
): SessionInventoryItem {
  if (
    item.cwd &&
    item.projectName
  ) {
    return item;
  }

  if (
    !item.rolloutPath
  ) {
    return item;
  }

  const meta =
    readRolloutMeta(
      item.rolloutPath,
    );

  const cwd =
    item.cwd ??
    meta.cwd;

  return {
    ...item,

    cwd,

    projectName:
      item.projectName ??
      (
        cwd
          ? basename(cwd)
          : undefined
      ),
  };
}

export function isExistingDirectory(
  path: string,
): boolean {
  try {
    return statSync(
      path,
    ).isDirectory();
  }
  catch {
    return false;
  }
}

export function listLarkBindings(
  ctx: any,
): LarkBinding[] {
  const result:
    LarkBinding[] = [];

  const currentScope =
    String(
      ctx.scope ?? '',
    );

  const store =
    ctx.sessions;

  if (
    store &&
    typeof store.listRaw ===
      'function'
  ) {
    const entries =
      store.listRaw() as
        Record<
          string,
          any
        >;

    for (
      const [
        scope,
        value,
      ] of Object.entries(
        entries,
      )
    ) {
      const sessionId =
        typeof value?.sessionId ===
          'string'
          ? value.sessionId
          : (
              typeof value?.threadId ===
                'string'
                ? value.threadId
                : undefined
            );

      if (!sessionId) {
        continue;
      }

      result.push(
        {
          scope,

          sessionId,

          cwd:
            typeof value.cwd ===
              'string'
              ? value.cwd
              : undefined,

          updatedAt:
            typeof value.updatedAt ===
              'number'
              ? value.updatedAt
              : undefined,

          current:
            scope ===
            currentScope,
        },
      );
    }
  }
  else if (
    store &&
    typeof store.getRaw ===
      'function'
  ) {
    const value =
      store.getRaw(
        currentScope,
      );

    const sessionId =
      typeof value?.sessionId ===
        'string'
        ? value.sessionId
        : undefined;

    if (sessionId) {
      result.push(
        {
          scope:
            currentScope,

          sessionId,

          cwd:
            typeof value.cwd ===
              'string'
              ? value.cwd
              : undefined,

          updatedAt:
            typeof value.updatedAt ===
              'number'
              ? value.updatedAt
              : undefined,

          current: true,
        },
      );
    }
  }

  return result;
}

export function mergeLarkBindings(
  items: SessionInventoryItem[],
  bindings: LarkBinding[],
): void {
  for (
    const binding of bindings
  ) {
    const existing =
      items.find(
        (item) =>
          item.sessionId ===
          binding.sessionId,
      );

    if (existing) {
      if (
        !existing.cwd &&
        binding.cwd
      ) {
        existing.cwd =
          binding.cwd;

        existing.projectName =
          basename(
            binding.cwd,
          );
      }

      existing.updatedAtMs =
        Math.max(
          existing.updatedAtMs,
          binding.updatedAt ??
            0,
        );

      continue;
    }

    items.push(
      {
        sessionId:
          binding.sessionId,

        cwd:
          binding.cwd,

        projectName:
          binding.cwd
            ? basename(
                binding.cwd,
              )
            : undefined,

        updatedAtMs:
          binding.updatedAt ??
          0,

        handoff:
          detachedHandoff(),
      },
    );
  }
}

function matchSummary(
  item: SessionInventoryItem,
): string {
  const name =
    item.threadName
      ? ` ${item.threadName}`
      : '';

  return `${item.sessionId.slice(
    0,
    12,
  )}${name}`;
}

function ambiguousResult(
  matches: SessionInventoryItem[],
): SessionResolveResult {
  return {
    ok: false,

    code: 'ambiguous',

    message: [
      '匹配到多个 Session，请使用更完整的名称或 Session ID。',
      '',
      ...matches
        .slice(
          0,
          8,
        )
        .map(
          (item) =>
            `- ${matchSummary(
              item,
            )}`,
        ),
    ].join('\n'),

    matches,
  };
}

export function resolveSessionSelector(
  selector: string,
  items: SessionInventoryItem[],
): SessionResolveResult {
  const input =
    selector.trim();

  if (!input) {
    return {
      ok: false,

      code: 'empty',

      message:
        '请提供 Thread 名称或 Session ID。',
    };
  }

  const lower =
    input.toLowerCase();

  const exactId =
    items.filter(
      (item) =>
        item.sessionId.toLowerCase() ===
        lower,
    );

  if (
    exactId.length === 1
  ) {
    return {
      ok: true,
      item: exactId[0]!,
    };
  }

  const idPrefix =
    items.filter(
      (item) =>
        item.sessionId
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
      item: idPrefix[0]!,
    };
  }

  if (
    idPrefix.length > 1
  ) {
    return ambiguousResult(
      idPrefix,
    );
  }

  const exactName =
    items.filter(
      (item) =>
        item.threadName
          ?.toLowerCase() ===
        lower,
    );

  if (
    exactName.length === 1
  ) {
    return {
      ok: true,
      item: exactName[0]!,
    };
  }

  if (
    exactName.length > 1
  ) {
    return ambiguousResult(
      exactName,
    );
  }

  const namePrefix =
    items.filter(
      (item) =>
        item.threadName
          ?.toLowerCase()
          .startsWith(
            lower,
          ),
    );

  if (
    namePrefix.length === 1
  ) {
    return {
      ok: true,
      item: namePrefix[0]!,
    };
  }

  if (
    namePrefix.length > 1
  ) {
    return ambiguousResult(
      namePrefix,
    );
  }

  return {
    ok: false,

    code: 'not-found',

    message:
      `没有找到 Session：${input}`,
  };
}
