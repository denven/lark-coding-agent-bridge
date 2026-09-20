import {
  buildSessionInventory,
  formatHandoffState,
  hydrateInventoryItem,
  isExistingDirectory,
  listLarkBindings,
  mergeLarkBindings,
  resolveSessionSelector,
  type LarkBinding,
  type SessionInventoryItem,
} from './local-session-state.js';

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

function isCodexContext(
  ctx: any,
): boolean {
  return (
    ctx.agent?.id ===
      'codex' ||
    ctx.controls
      ?.profileConfig
      ?.agentKind ===
      'codex'
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

export async function handleLocalSessions(
  args: string,
  ctx: any,
): Promise<void> {
  if (
    !isCodexContext(
      ctx,
    )
  ) {
    await reply(
      ctx,
      '❌ `/sessions` 仅适用于 Codex agent。',
    );

    return;
  }

  const input =
    args.trim();

  const showAll =
    input.toLowerCase() ===
    'all';

  const keyword =
    showAll
      ? ''
      : input.toLowerCase();

  const {
    items,
    bindings,
  } =
    inventoryForContext(
      ctx,
    );

  let candidates =
    items;

  if (keyword) {
    candidates =
      items.filter(
        (item) =>
          item.sessionId
            .toLowerCase()
            .includes(
              keyword,
            ) ||
          item.threadName
            ?.toLowerCase()
            .includes(
              keyword,
            ) ||
          item.projectName
            ?.toLowerCase()
            .includes(
              keyword,
            ),
      );
  }
  else if (!showAll) {
    /*
     * Default view:
     *
     * all currently-owned sessions
     * +
     * a small recent detached history.
     */
    const important =
      items.filter(
        (item) =>
          item.handoff
            .windowsActive ||
          bindingsFor(
            item,
            bindings,
          ).length >
            0,
      );

    const detached =
      items
        .filter(
          (item) =>
            !item.handoff
              .windowsActive &&
            bindingsFor(
              item,
              bindings,
            ).length ===
              0,
        )
        .slice(
          0,
          10,
        );

    candidates =
      [
        ...important,
        ...detached,
      ];

    const seen =
      new Set<string>();

    candidates =
      candidates.filter(
        (item) => {
          if (
            seen.has(
              item.sessionId,
            )
          ) {
            return false;
          }

          seen.add(
            item.sessionId,
          );

          return true;
        },
      );
  }

  const limit =
    showAll
      ? 30
      : 20;

  candidates =
    candidates
      .slice(
        0,
        limit,
      )
      .map(
        hydrateInventoryItem,
      );

  if (
    candidates.length === 0
  ) {
    await reply(
      ctx,
      keyword
        ? `没有找到匹配 \`${clean(
            input,
          )}\` 的 Codex Session。`
        : '当前没有找到 Codex Session。',
    );

    return;
  }

  const lines: string[] = [
    '## Codex Sessions',
    '',
  ];

  let index = 0;

  for (
    const item of candidates
  ) {
    index += 1;

    const linked =
      bindingsFor(
        item,
        bindings,
      );

    const current =
      linked.some(
        (binding) =>
          binding.current,
      );

    const prefix =
      current
        ? '▶'
        : (
            item.handoff
              .windowsActive
              ? '🖥'
              : '○'
          );

    lines.push(
      `${prefix} **${index}. ${clean(
        sessionTitle(
          item,
        ),
      )}**`,
    );

    if (
      item.projectName
    ) {
      lines.push(
        `   📁 ${clean(
          item.projectName,
        )}`,
      );
    }

    lines.push(
      `   🔗 \`${clean(
        item.sessionId,
      )}\``,
    );

    lines.push(
      `   👤 Owner: **${clean(
        ownerText(
          ctx,
          item,
          bindings,
        ),
      )}**`,
    );

    if (
      item.handoff
        .windowsActive
    ) {
      lines.push(
        `   🔄 Handoff: ${formatHandoffState(
          item.handoff,
        )}`,
      );
    }

    if (
      item.cwd
    ) {
      lines.push(
        `   📂 \`${clean(
          item.cwd,
        )}\``,
      );
    }

    lines.push(
      `   🕒 ${formatUpdated(
        item.updatedAtMs,
      )}`,
      '',
    );
  }

  lines.push(
    '---',
    '',
    '`/use <Thread名称|Session-ID前缀>`：切换到 Detached Session',
    '',
    '`/local-handoff <...>`：Windows → 当前 Lark scope',
    '',
    '`/handback`：当前 Lark scope → Detached',
  );

  if (
    !showAll &&
    !keyword &&
    items.length >
      candidates.length
  ) {
    lines.push(
      '',
      '使用 `/sessions all` 查看更多历史 Session。',
    );
  }

  await reply(
    ctx,
    lines.join('\n'),
  );
}

function targetResolveError(
  message: string,
): string {
  return [
    '❌ **无法选择 Session。**',
    '',
    message,
    '',
    '可以先使用 `/sessions` 查看。',
  ].join('\n');
}

async function flushStores(
  ctx: any,
): Promise<void> {
  if (
    typeof ctx.workspaces
      ?.flush ===
    'function'
  ) {
    await ctx.workspaces.flush();
  }

  if (
    typeof ctx.sessions
      ?.flush ===
    'function'
  ) {
    await ctx.sessions.flush();
  }
}

export async function handleLocalUse(
  args: string,
  ctx: any,
): Promise<void> {
  if (
    !isCodexContext(
      ctx,
    )
  ) {
    await reply(
      ctx,
      '❌ `/use` 仅适用于 Codex agent。',
    );

    return;
  }

  const selector =
    args.trim();

  if (!selector) {
    await reply(
      ctx,
      [
        '用法：',
        '',
        '`/use <Thread名称或Session-ID前缀>`',
        '',
        '例如：',
        '',
        '`/use Calculate 1+2`',
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
    hydrateInventoryItem(
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
        '请先在原 Group / Chat 中执行 `/handback`。',
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
          '不要使用 `/use`。',
          '',
          `请使用：\`/local-handoff ${clean(
            target.sessionId.slice(
              0,
              12,
            ),
          )}\``,
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
          '当前不能安全 `/use`。',
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
  ctx.workspaces.setCwd(
    ctx.scope,
    target.cwd,
  );

  /*
   * Some local bridge versions accept an
   * optional fourth agent id argument.
   * Calling through any keeps compatibility
   * with both signatures.
   */
  (ctx.sessions as any).set(
    ctx.scope,
    target.sessionId,
    target.cwd,
    ctx.agent?.id,
  );

  await flushStores(
    ctx,
  );

  await reply(
    ctx,
    [
      '✅ **Lark Session switched**',
      '',
      `🏷 **Thread:** ${clean(
        sessionTitle(
          target,
        ),
      )}`,
      '',
      `🔗 **Session:** \`${clean(
        target.sessionId,
      )}\``,
      '',
      `📂 **Directory:** \`${clean(
        target.cwd,
      )}\``,
      '',
      '**下一条普通消息将继续这个 Session。**',
    ].join('\n'),
  );
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
  if (
    !isCodexContext(
      ctx,
    )
  ) {
    await reply(
      ctx,
      '❌ `/handback` 仅适用于 Codex agent。',
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
        '⛔ **当前 Codex 任务仍在运行。**',
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
        'ℹ️ 当前 Lark scope 没有绑定 Codex Session。',
        '',
        '无需 handback。',
      ].join('\n'),
    );

    return;
  }

  const inventory =
    buildSessionInventory();

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
      ? hydrateInventoryItem(
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
   * It does NOT delete the underlying Codex
   * rollout/thread.
   */
  ctx.sessions.clear(
    ctx.scope,
  );

  if (
    typeof ctx.sessions
      ?.flush ===
    'function'
  ) {
    await ctx.sessions.flush();
  }

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
    'Codex Session 历史没有被删除。',
  );

  if (cwd) {
    lines.push(
      '',
      '**Windows 中执行：**',
      '',
      '```powershell',
      `cd ${powerShellQuote(
        cwd,
      )}`,
      `codex3 resume ${current.sessionId}`,
      '```',
    );
  }
  else {
    lines.push(
      '',
      '**Windows 中执行：**',
      '',
      '```powershell',
      `codex3 resume ${current.sessionId}`,
      '```',
    );
  }

  lines.push(
    '',
    '在 Windows 接管期间，不要在这个 Lark scope 中发送普通 Codex 任务。',
  );

  await reply(
    ctx,
    lines.join('\n'),
  );
}