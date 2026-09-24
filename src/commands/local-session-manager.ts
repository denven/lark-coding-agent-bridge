import {
  formatHandoffState,
  isExistingDirectory,
  listLarkBindings,
  markSessionDetached,
  mergeLarkBindings,
  resolveSessionSelector,
  type LarkBinding,
  type SessionInventoryItem,
} from './local-session-state.js';
import { actions, divMd, divPlain, shell, type ButtonSpec } from '../card/templates.js';
import { log } from '../core/logger.js';
import {
  scopeProvider,
  withoutAgentTokens,
  type SessionProvider,
} from './session-provider.js';
import { bindScopeToSession, unbindScope } from './session-binding.js';

/**
 * Which one-click ownership transfer a Session currently offers. The list card
 * groups Sessions by this so the default view only shows rows that can act.
 */
type SessionCategory = 'handoff' | 'use' | 'handback' | 'none';

const SESSION_FILTERS = ['handoff', 'use', 'handback', 'all'] as const;

type SessionFilter = (typeof SESSION_FILTERS)[number];

/** How many Sessions the category tabs are allowed to draw from. */
const SESSION_FILTER_POOL = 10;

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

async function reply(
  ctx: any,
  markdown: string,
): Promise<void> {
  await ctx.channel.send(
    ctx.msg.chatId,
    { markdown },
    commandReplyOptions(ctx),
  );
}

async function replyCard(
  ctx: any,
  card: object,
): Promise<void> {
  await ctx.channel.send(
    ctx.msg.chatId,
    { card },
    commandReplyOptions(ctx),
  );
}

function hasActiveRun(
  ctx: any,
): boolean {
  if (
    typeof ctx.activeRuns
      ?.get !==
    'function'
  ) {
    return false;
  }

  return Boolean(
    ctx.activeRuns.get(
      ctx.scope,
    ),
  );
}

function scopeName(
  ctx: any,
  scope: string,
): string {
  if (
    scope === ctx.scope
  ) {
    return 'Current';
  }

  const chatId =
    scope.includes(':')
      ? scope.split(':')[0]
      : scope;

  const chats =
    ctx.controls
      ?.knownChats;

  if (
    Array.isArray(chats)
  ) {
    const chat =
      chats.find(
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

  const suffix =
    scope.length > 12
      ? scope.slice(-12)
      : scope;

  return `Scope …${suffix}`;
}

function bindingsFor(
  item: SessionInventoryItem,
  bindings: LarkBinding[],
): LarkBinding[] {
  return bindings.filter(
    (binding) =>
      binding.sessionId ===
      item.sessionId,
  );
}

function ownerText(
  ctx: any,
  item: SessionInventoryItem,
  bindings: LarkBinding[],
): string {
  const linked =
    bindingsFor(
      item,
      bindings,
    );

  if (
    item.handoff.windowsActive &&
    linked.length > 0
  ) {
    return '⚠ Windows + Lark';
  }

  const current =
    linked.find(
      (binding) =>
        binding.current,
    );

  if (current) {
    return 'Lark · Current';
  }

  if (
    linked.length > 0
  ) {
    return `Lark · ${scopeName(
      ctx,
      linked[0]!.scope,
    )}`;
  }

  if (
    item.handoff.windowsActive
  ) {
    const state =
      item.status?.state ??
      'Active';

    return `Windows · ${state}`;
  }

  return 'Detached';
}

function sessionRank(
  item: SessionInventoryItem,
  bindings: LarkBinding[],
): number {
  const linked =
    bindingsFor(
      item,
      bindings,
    );

  if (
    linked.some(
      (binding) =>
        binding.current,
    )
  ) {
    return 0;
  }

  if (
    item.handoff.windowsActive
  ) {
    return 1;
  }

  if (
    linked.length > 0
  ) {
    return 2;
  }

  return 3;
}

function formatUpdated(
  value: number,
): string {
  if (
    !value ||
    value <= 0
  ) {
    return 'unknown';
  }

  try {
    return new Date(
      value,
    ).toLocaleString(
      'en-CA',
      {
        hour12: false,
      },
    );
  }
  catch {
    return 'unknown';
  }
}

function sessionTitle(
  item: SessionInventoryItem,
): string {
  return (
    item.threadName ||
    item.projectName ||
    item.sessionId.slice(
      0,
      12,
    )
  );
}

function inventoryForContext(
  ctx: any,
): {
  items: SessionInventoryItem[];
  bindings: LarkBinding[];
} {
  /*
   * Always the scope's own agent: bindings (sessions.json is per profile) and
   * inventory then describe the same kind of Session, so merging them cannot
   * produce rows for an agent this profile does not drive.
   */
  const inventory =
    scopeProvider(ctx).buildInventory();

  const bindings =
    listLarkBindings(
      ctx,
    );

  mergeLarkBindings(
    inventory.items,
    bindings,
  );

  inventory.items.sort(
    (
      a,
      b,
    ) => {
      const rankA =
        sessionRank(
          a,
          bindings,
        );

      const rankB =
        sessionRank(
          b,
          bindings,
        );

      if (
        rankA !== rankB
      ) {
        return (
          rankA -
          rankB
        );
      }

      return (
        b.updatedAtMs -
        a.updatedAtMs
      );
    },
  );

  return {
    items:
      inventory.items,

    bindings,
  };
}

/*
 * Mirror of the decision tree in sessionActionButtons(). Kept as a separate
 * pure function so the category tabs and the per-row buttons cannot disagree:
 * a Session listed under "Handoff" is exactly one that renders a Handoff
 * button. Any change to one must be made in the other.
 */
function sessionCategory(
  item: SessionInventoryItem,
  bindings: LarkBinding[],
  provider: SessionProvider,
): SessionCategory {
  const linked = bindingsFor(item, bindings);
  const current = linked.some((binding) => binding.current);

  // Conflicting Windows + Lark ownership: inspect before transferring.
  if (item.handoff.windowsActive && linked.length > 0) {
    return 'none';
  }

  if (current) {
    return 'handback';
  }

  // Bound to another Lark scope — not movable from here.
  if (linked.length > 0) {
    return 'none';
  }

  if (item.handoff.windowsActive) {
    if (!provider.supportsHandoff || item.handoff.transferable === false) return 'none';
    return item.handoff.code === 'busy' ? 'none' : 'handoff';
  }

  return 'use';
}

function filterTabButtons(
  counts: Record<SessionFilter, number>,
  active: SessionFilter,
): ButtonSpec[] {
  const labels: Record<SessionFilter, string> = {
    handoff: '↪ Handoff',
    use: '▶ Use',
    handback: '↩ Hand Back',
    all: '🗂 All',
  };

  const hints: Record<SessionFilter, string> = {
    handoff: 'Show only Sessions that can be handed off from Windows to this Lark scope.',
    use: 'Show only Detached Sessions that can be bound to this Lark scope.',
    handback: 'Show only Sessions bound to this Lark scope that can be handed back to Windows.',
    all: 'Show every Session, including ones with no available transfer action.',
  };

  return SESSION_FILTERS.map((filter) => ({
    // The active tab is marked in the label because Lark gives no
    // selected-state styling for buttons inside an action row.
    text: `${filter === active ? '● ' : ''}${labels[filter]} (${counts[filter]})`,
    value: { cmd: 'session.list', arg: filter },
    style: filter === active ? 'primary' : 'default',
    hoverTips: hints[filter],
  }));
}

function lastResponseButton(
  item: SessionInventoryItem,
  provider: SessionProvider,
): ButtonSpec {
  return {
    text: '📜 Last Response',
    // Always target the exact full Session ID.
    value: { cmd: 'session.tail', arg: item.sessionId },
    hoverTips: `Show the most recent completed user-visible ${provider.label} response from this Session.`,
  };
}

function sessionActionButtons(
  ctx: any,
  item: SessionInventoryItem,
  bindings: LarkBinding[],
  provider: SessionProvider,
): ButtonSpec[] {
  const linked = bindingsFor(item, bindings);
  const current = linked.some((binding) => binding.current);
  // Labels name the action and its direction only: the row above already
  // shows the Session, and short labels keep two buttons per line on mobile.
  // The title is repeated in the hover tip for desktop.
  const title = sessionTitle(item);

  const buttons: ButtonSpec[] = [lastResponseButton(item, provider)];

  // A conflicting Windows + Lark ownership state should be inspected before
  // any one-click transfer action is offered. Reading history remains safe.
  if (item.handoff.windowsActive && linked.length > 0) {
    return buttons;
  }

  if (current) {
    buttons.push({
      text: '↩ Hand Back to Windows',
      value: { cmd: 'handback' },
      style: 'primary',
      hoverTips: `Unbind "${title}" from this Lark scope and make it Detached / ready to resume on Windows.`,
    });
    return buttons;
  }

  // A Session bound to another Lark scope cannot be moved from this scope.
  if (linked.length > 0) {
    return buttons;
  }

  if (item.handoff.windowsActive) {
    // Busy Windows sessions are intentionally not given a transfer button.
    // Ready and needs-validation states may still use the authoritative
    // PowerShell release chain in handleLocalHandoff().
    if (
      item.handoff.code === 'busy' ||
      item.handoff.transferable === false ||
      !provider.supportsHandoff
    ) {
      return buttons;
    }

    buttons.push({
      text: '↪ Handoff to Lark',
      value: {
        cmd: 'local-handoff',
        // Always target the exact full Session ID; the label is display-only.
        arg: item.sessionId,
      },
      style: 'primary',
      hoverTips: `Release the Windows writer of "${title}" and bind it to this Lark scope.`,
    });
    return buttons;
  }

  buttons.push({
    text: '▶ Use in Lark',
    value: {
      cmd: 'use',
      // Always target the exact full Session ID; the label is display-only.
      arg: item.sessionId,
    },
    style: 'primary',
    hoverTips: `Bind the Detached ${provider.label} Session "${title}" to this Lark scope.`,
  });

  return buttons;
}

export async function handleLocalSessions(
  args: string,
  ctx: any,
): Promise<void> {
  const provider = scopeProvider(ctx);

  /*
   * A category word picks the tab and anything else is a keyword search, in
   * any order. Agent words (`codex` / `claude`) are dropped: the profile
   * decides the agent, so the command reads the same on every bot.
   */
  let asFilter: SessionFilter | undefined;
  const keywordParts: string[] = [];

  for (const token of withoutAgentTokens(args).split(/\s+/).filter(Boolean)) {
    const lowered = token.toLowerCase();
    const filter = SESSION_FILTERS.find((value) => value === lowered);
    if (filter && !asFilter) {
      asFilter = filter;
      continue;
    }

    keywordParts.push(lowered);
  }

  const keyword = keywordParts.join(' ');

  const { items, bindings } = inventoryForContext(ctx);

  let candidates: SessionInventoryItem[];
  let counts: Record<SessionFilter, number> | undefined;
  let activeFilter: SessionFilter | undefined;

  if (keyword) {
    candidates = items
      .filter(
        (item) =>
          item.sessionId.toLowerCase().includes(keyword) ||
          item.threadName?.toLowerCase().includes(keyword) ||
          item.projectName?.toLowerCase().includes(keyword),
      )
      .slice(0, 30);
  } else {
    /*
     * Category tabs replace the old "recent history" heuristic. Only the most
     * recent SESSION_FILTER_POOL Sessions participate, so the counts on the
     * tabs always describe exactly what the tabs can show.
     */
    const pool = items.slice(0, SESSION_FILTER_POOL);
    const byCategory = new Map<SessionCategory, SessionInventoryItem[]>();
    for (const item of pool) {
      const category = sessionCategory(item, bindings, provider);
      const bucket = byCategory.get(category);
      if (bucket) bucket.push(item);
      else byCategory.set(category, [item]);
    }

    counts = {
      handoff: byCategory.get('handoff')?.length ?? 0,
      use: byCategory.get('use')?.length ?? 0,
      handback: byCategory.get('handback')?.length ?? 0,
      all: pool.length,
    };

    /*
     * Default to Handoff because that is the state needing a decision. When it
     * is empty, fall through to the next non-empty category rather than opening
     * on a blank card.
     */
    activeFilter =
      asFilter ??
      (['handoff', 'handback', 'use'] as const).find((filter) => counts![filter] > 0) ??
      'all';

    candidates =
      activeFilter === 'all' ? pool : (byCategory.get(activeFilter) ?? []);
  }

  candidates = candidates.map((item) => provider.hydrate(item));

  if (candidates.length === 0 && keyword) {
    await reply(ctx, `No ${provider.label} Session matched **${clean(keyword)}**.`);
    return;
  }

  if (counts?.all === 0) {
    await reply(ctx, `No ${provider.label} Sessions were found.`);
    return;
  }

  const elements: object[] = [];

  if (counts && activeFilter) {
    elements.push(actions(filterTabButtons(counts, activeFilter)));
    elements.push({ tag: 'hr' });
  }

  if (candidates.length === 0) {
    elements.push(
      divMd(
        `No Session in the most recent ${SESSION_FILTER_POOL} currently offers this action. Pick another category above.`,
      ),
    );
  }

  for (const [idx, item] of candidates.entries()) {
    const linked = bindingsFor(item, bindings);
    const current = linked.some((binding) => binding.current);
    const prefix = current ? '▶' : item.handoff.windowsActive ? '🖥' : '○';
    const lines: string[] = [
      `${prefix} **${idx + 1}. ${clean(sessionTitle(item))}**`,
    ];

    if (item.projectName) {
      lines.push(`📁 ${clean(item.projectName)}`);
    }

    lines.push(`🔗 ${clean(item.sessionId)}`);
    lines.push(`👤 Owner: **${clean(ownerText(ctx, item, bindings))}**`);

    if (item.handoff.windowsActive) {
      lines.push(`🔄 Handoff: ${formatHandoffState(item.handoff)}`);
    }

    if (item.cwd) {
      lines.push(`📂 ${clean(item.cwd)}`);
    }

    lines.push(`🕒 ${formatUpdated(item.updatedAtMs)}`);
    elements.push(divMd(lines.join('\n')));

    const buttons = sessionActionButtons(ctx, item, bindings, provider);
    if (buttons.length > 0) {
      elements.push(actions(buttons));
    }

    if (idx < candidates.length - 1) {
      elements.push({ tag: 'hr' });
    }
  }

  const olderHint =
    counts && items.length > counts.all
      ? [
          '',
          `Showing the most recent ${SESSION_FILTER_POOL} of ${items.length} Sessions. Use **/session list <keyword>** to find an older one.`,
        ]
      : [];

  elements.push({ tag: 'hr' });
  elements.push(
    divMd(
      [
        '**Session actions**',
        '• **Use in Lark** — Detached Session → this Lark scope',
        provider.supportsHandoff
          ? '• **Handoff to Lark** — Windows → this Lark scope'
          : `• **Handoff** — not available for ${provider.label} yet; quit the Windows window first, then Use`,
        '• **Hand Back to Windows** — this Lark scope → Detached / Windows-ready',
        `• **Last Response** — read the latest completed user-visible ${provider.label} response`,
        ...olderHint,
      ].join('\n'),
    ),
  );

  const card = shell(`🗂️ All ${provider.label} Sessions`, elements);

  /*
   * A tab click re-runs this handler with ctx.msg.messageId set to the card's
   * own message (see makeFakeMsg in card/dispatcher.ts). Recall that card and
   * post the replacement, which is the same pattern the /account and /config
   * card flows use.
   *
   * Two rejected alternatives, both of which fail silently:
   *   - channel.updateCard() → im.v1.message.patch. Feishu answers HTTP 200
   *     with a non-zero body code and the SDK discards the response, so a
   *     refused patch throws nothing and renders nothing.
   *   - sendManagedCard() → cardkit.card.create, which rejects the v1 schema
   *     that shell() builds ("returned no card_id").
   *
   * Cost of recall-and-resend: the card moves to the bottom of the chat on each
   * tab switch instead of updating where it sits.
   */
  if (ctx.fromCardAction && ctx.msg.messageId) {
    /*
     * Send first, recall second. The replacement is sent as a reply to the old
     * card because that is the only way to land in the right topic thread
     * (SendOptions has no threadId — only replyTo/replyInThread), and recalling
     * a parent message in Feishu does not remove replies already made to it.
     */
    const stale = ctx.msg.messageId;
    await replyCard(ctx, card);

    try {
      await ctx.channel.recallMessage(stale);
    } catch (err) {
      // Leaves the old card above the new one — visible, not silent.
      log.warn('command', 'session-list-recall-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  await replyCard(ctx, card);
}

function formatResponseTime(
  value: number | undefined,
): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  try {
    return new Date(value).toLocaleString(
      'en-CA',
      { hour12: false },
    );
  }
  catch {
    return undefined;
  }
}

export async function handleLocalTail(
  args: string,
  ctx: any,
): Promise<void> {
  const provider = scopeProvider(ctx);
  const selector = withoutAgentTokens(args, { leadingOnly: true });

  const { items, bindings } = inventoryForContext(ctx);

  let target: SessionInventoryItem | undefined;

  if (selector) {
    const resolved = resolveSessionSelector(selector, items);
    if (!resolved.ok) {
      await reply(ctx, targetResolveError(resolved.message));
      return;
    }
    target = provider.hydrate(resolved.item);
  }
  else {
    const current = bindings.find((binding) => binding.current);
    if (!current) {
      await reply(
        ctx,
        [
          `ℹ️ **The current Lark scope has no ${provider.label} Session binding.**`,
          '',
          'Use **/session tail <Thread name | Session ID>** to inspect a specific Session.',
        ].join('\n'),
      );
      return;
    }

    const found = items.find((item) => item.sessionId === current.sessionId);
    if (found) {
      target = provider.hydrate(found);
    }
  }

  if (!target) {
    await reply(ctx, `❌ The requested ${provider.label} Session could not be found in the inventory.`);
    return;
  }

  if (!target.rolloutPath && !target.status?.rolloutPath) {
    await reply(
      ctx,
      [
        `⚠️ **No ${provider.label} transcript is available for this Session.**`,
        '',
        `🔗 **Session:** ${clean(target.sessionId)}`,
      ].join('\n'),
    );
    return;
  }

  const response = await provider.readLastResponse(target, 5_000);

  if (!response) {
    await reply(
      ctx,
      [
        `ℹ️ **No completed user-visible ${provider.label} response was found.**`,
        '',
        `🏷 **Thread:** ${clean(sessionTitle(target))}`,
        `🔗 **Session:** ${clean(target.sessionId)}`,
      ].join('\n'),
    );
    return;
  }

  const time = formatResponseTime(response.timestampMs);
  const elements: object[] = [
    divMd(
      [
        `🏷 **Thread:** ${clean(sessionTitle(target))}`,
        `🔗 **Session:** ${clean(target.sessionId)}`,
        `👤 **Owner:** ${clean(ownerText(ctx, target, bindings))}`,
        ...(time ? [`🕒 **Response time:** ${time}`] : []),
      ].join('\n'),
    ),
    { tag: 'hr' },
    divPlain(response.text),
  ];

  if (response.truncated) {
    elements.push(
      divMd(`_The response was shortened for Lark display; the full text remains in the ${provider.label} transcript._`),
    );
  }

  await replyCard(ctx, shell(`📜 Last ${provider.label} Response`, elements));
}

function targetResolveError(
  message: string,
): string {
  return [
    '❌ **无法选择 Session。**',
    '',
    message,
    '',
    '可以先使用 **/session list** 查看。',
  ].join('\n');
}

export async function handleLocalUse(
  args: string,
  ctx: any,
): Promise<void> {
  // Binding is always into the scope's own agent — see bindScopeToSession().
  const provider = scopeProvider(ctx);
  const selector = withoutAgentTokens(args, { leadingOnly: true });

  if (!selector) {
    await reply(
      ctx,
      [
        '用法：',
        '',
        '**/session use <Thread名称或Session-ID前缀>**',
        '',
        '例如：',
        '',
        '**/session use Calculate 1+2**',
      ].join('\n'),
    );

    return;
  }

  if (
    hasActiveRun(
      ctx,
    )
  ) {
    await reply(
      ctx,
      [
        '⛔ 当前 Lark scope 正在执行任务。',
        '',
        '请等待任务结束，或者先使用 `/stop`。',
      ].join('\n'),
    );

    return;
  }

  const {
    items,
    bindings,
  } =
    inventoryForContext(
      ctx,
    );

  const resolved =
    resolveSessionSelector(
      selector,
      items,
    );

  if (!resolved.ok) {
    await reply(
      ctx,
      targetResolveError(
        resolved.message,
      ),
    );

    return;
  }

  let target =
    provider.hydrate(
      resolved.item,
    );

  const current =
    bindings.find(
      (binding) =>
        binding.current,
    );

  if (
    current?.sessionId ===
    target.sessionId
  ) {
    await reply(
      ctx,
      `✅ 当前 Lark scope 已经绑定到 **${clean(
        sessionTitle(
          target,
        ),
      )}**。`,
    );

    return;
  }

  const otherBindings =
    bindings.filter(
      (binding) =>
        binding.sessionId ===
          target.sessionId &&
        !binding.current,
    );

  if (
    otherBindings.length >
    0
  ) {
    await reply(
      ctx,
      [
        '⛔ **这个 Session 已绑定到另一个 Lark scope。**',
        '',
        `Session: \`${clean(
          target.sessionId,
        )}\``,
        '',
        `Scope: ${clean(
          scopeName(
            ctx,
            otherBindings[0]!.scope,
          ),
        )}`,
        '',
        '请先在原 Group / Chat 中执行 **/session handback**。',
      ].join('\n'),
    );

    return;
  }

  if (
    target.handoff
      .windowsActive
  ) {
    if (
      target.handoff.code ===
      'ready'
    ) {
      await reply(
        ctx,
        [
          '🖥 **这个 Session 当前由 Windows 控制。**',
          '',
          `Handoff: ${formatHandoffState(
            target.handoff,
          )}`,
          '',
          '不要使用 **/session use**。',
          '',
          `请使用：**/session handoff ${clean(
            target.sessionId.slice(
              0,
              12,
            ),
          )}**`,
        ].join('\n'),
      );
    }
    else {
      await reply(
        ctx,
        [
          '⛔ **这个 Session 当前仍由 Windows 控制。**',
          '',
          `Handoff: ${formatHandoffState(
            target.handoff,
          )}`,
          '',
          '当前不能安全执行 **/session use**。',
        ].join('\n'),
      );
    }

    return;
  }

  if (
    !target.cwd
  ) {
    await reply(
      ctx,
      [
        '❌ 无法确定这个 Session 的工作目录。',
        '',
        `Session: \`${clean(
          target.sessionId,
        )}\``,
      ].join('\n'),
    );

    return;
  }

  if (
    !isExistingDirectory(
      target.cwd,
    )
  ) {
    await reply(
      ctx,
      [
        '❌ Session 工作目录不存在。',
        '',
        `📂 \`${clean(
          target.cwd,
        )}\``,
      ].join('\n'),
    );

    return;
  }

  /*
   * /use is deliberately non-destructive:
   *
   * it never releases a Windows writer.
   * It only binds an already Detached Session.
   */
  const bound = await bindScopeToSession(
    ctx,
    provider.agentKind,
    target.sessionId,
    target.cwd,
  );

  if (!bound.catalogBound) {
    log.warn('command', 'session-use-no-catalog', {
      agent: provider.agentKind,
      scope: ctx.scope,
    });
  }

  const summary = [
    `🏷 **Thread:** ${clean(sessionTitle(target))}`,
    ...(target.projectName ? [`📁 **Project:** ${clean(target.projectName)}`] : []),
    `🔗 **Session:** ${clean(target.sessionId)}`,
    `📂 **Directory:** ${clean(target.cwd)}`,
    '👤 **Owner:** Lark · Current',
    '',
    ...(bound.catalogBound || provider.agentKind === 'claude'
      ? ['**Continue by sending a normal message in this Lark scope.**']
      : [
          // Codex resumes only from the session catalog (run-flow.ts).
          '⚠️ **Session catalog 不可用，Codex 无法续接这个 Session；下一条消息会开启新 thread。**',
        ]),
  ];

  /*
   * Like a handoff, show where the conversation left off — a Detached
   * Session was usually last used on Windows, so this is what the user needs
   * to pick it up from Lark. Display only: the resumed Session already has
   * the full history.
   */
  const lastResponse = await provider.readLastResponse(target, 5_000);

  const elements: object[] = [divMd(summary.join('\n')), { tag: 'hr' }];

  if (lastResponse) {
    elements.push(divMd('**💬 Last Response**'), divPlain(lastResponse.text));
    if (lastResponse.truncated) {
      elements.push(
        divMd(`_The response was shortened for Lark display; the full text remains in the ${provider.label} transcript._`),
      );
    }
  }
  else {
    elements.push(divMd('💬 **Last Response:** no completed user-visible response was found.'));
  }

  elements.push(
    { tag: 'hr' },
    actions([
      {
        text: '↩ Hand Back to Windows',
        value: { cmd: 'handback' },
        style: 'primary',
        hoverTips: 'Unbind this Session from the current Lark scope and make it Detached / Windows-ready.',
      },
    ]),
  );

  await replyCard(ctx, shell('✅ Session Now in Lark', elements));
}

function powerShellQuote(
  value: string,
): string {
  return `'${value.replace(
    /'/g,
    "''",
  )}'`;
}

export async function handleLocalHandback(
  _args: string,
  ctx: any,
): Promise<void> {
  // A scope only ever binds its own agent's Sessions, so handback is too.
  const provider = scopeProvider(ctx);

  if (
    hasActiveRun(
      ctx,
    )
  ) {
    await reply(
      ctx,
      [
        `⛔ **当前 ${provider.label} 任务仍在运行。**`,
        '',
        '为了避免在任务执行过程中交回控制权，handback 已取消。',
        '',
        '请等待任务完成；如确实需要终止，先使用 `/stop`。',
      ].join('\n'),
    );

    return;
  }

  const bindings =
    listLarkBindings(
      ctx,
    );

  const current =
    bindings.find(
      (binding) =>
        binding.current,
    );

  if (
    !current
  ) {
    await reply(
      ctx,
      [
        `ℹ️ 当前 Lark scope 没有绑定 ${provider.label} Session。`,
        '',
        '无需 handback。',
      ].join('\n'),
    );

    return;
  }

  const inventory =
    provider.buildInventory();

  mergeLarkBindings(
    inventory.items,
    bindings,
  );

  const item =
    inventory.items.find(
      (value) =>
        value.sessionId ===
        current.sessionId,
    );

  const hydrated =
    item
      ? provider.hydrate(
          item,
        )
      : undefined;

  const cwd =
    current.cwd ??
    hydrated?.cwd ??
    ctx.workspaces
      ?.cwdFor?.(
        ctx.scope,
      );

  const threadName =
    hydrated?.threadName;

  /*
   * Handback means:
   *
   * stop considering this Lark scope the owner.
   *
   * It does NOT delete the underlying
   * transcript / thread.
   *
   * The Codex detached marker suppresses stale Observer telemetry. Claude has
   * no Observer: its ownership comes from the live process registry, which is
   * already PID-checked, so there is nothing stale to suppress.
   */
  const detachedRecorded =
    provider.agentKind === 'codex'
      ? markSessionDetached(
          current.sessionId,
          'handback',
        )
      : true;

  await unbindScope(ctx);

  const lines: string[] = [
    '✅ **Lark → Windows handback completed**',
    '',
  ];

  if (threadName) {
    lines.push(
      `🏷 **Thread:** ${clean(
        threadName,
      )}`,
      '',
    );
  }

  lines.push(
    `🔗 **Session:** \`${clean(
      current.sessionId,
    )}\``,
    '',
  );

  if (cwd) {
    lines.push(
      `📂 **Directory:** \`${clean(
        cwd,
      )}\``,
      '',
    );
  }

  lines.push(
    '🔓 当前 Lark scope 已解除 Session 绑定。',
    '',
    '👤 Owner: **Detached**（Windows-ready，但尚未由 Windows writer 接管）。',
    '',
    `${provider.label} Session 历史没有被删除。`,
  );

  if (!detachedRecorded) {
    lines.push(
      '',
      '⚠️ Detached ownership marker could not be persisted; stale Windows telemetry may remain visible briefly.',
    );
  }

  if (cwd) {
    lines.push(
      '',
      '**Windows 中执行：**',
      '',
      '```powershell',
      `cd ${powerShellQuote(
        cwd,
      )}`,
      provider.resumeHint(current.sessionId),
      '```',
    );
  }
  else {
    lines.push(
      '',
      '**Windows 中执行：**',
      '',
      '```powershell',
      provider.resumeHint(current.sessionId),
      '```',
    );
  }

  lines.push(
    '',
    `在 Windows 接管期间，不要在这个 Lark scope 中发送普通 ${provider.label} 任务。`,
  );

  await reply(
    ctx,
    lines.join('\n'),
  );
}