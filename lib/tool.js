/**
 * `plugin_unlock` 工具。
 *
 * 之所以做成工具、而不只是一组 HTTP 路由：助手可以在用户报障的当下自己动手释放，
 * 而且工具是每个 DSH 前端都已经暴露的入口，不需要用户再去翻浏览器 Cookie。
 */

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'in_use', 'runtime', 'release', 'update', 'remove', 'heal'],
      description:
        'status = 列出所有插件包及各自被什么挡住；in_use = 只看被存活 loader 条目挡住的包；'
        + 'runtime = 宿主用来跑 pnpm 的那份 payload 在不在；'
        + 'release = 释放这些条目（只停插件，不改任何文件）；'
        + 'update = 先释放，再交给插件管理器更新；'
        + 'remove = 先释放，再交给插件管理器卸载；'
        + 'heal = 先释放，且在不传 update:false 时把挂起的更新做完。',
    },
    name: {
      type: 'string',
      description: '包名，写法和 profile 里一致，例如 dsh-caveman。action=status/in_use 时可省略。',
    },
    version: {
      type: 'string',
      description: 'action=update 时指定精确版本；省略则用该包最新且本 Harness 认可的版本。',
    },
    update: {
      type: 'boolean',
      description: '只对 action=heal 有效：true 表示释放后把更新做完，false 表示只释放不更新。',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '本次请求的那一步是否成功。' },
    action: { type: 'string' },
    bundle: { type: 'string' },
    step: { type: 'string', description: '最后执行的步骤：release、list-versions、compatible-version、update 或 remove。' },
    reason: { type: 'string', description: '某一步失败的原因，用直白的话写。' },
    blocked: { type: 'array', description: '被存活 loader 条目挡住的插件包。' },
    bundles: { type: 'array', description: '该 profile 认识的所有插件包及其阻塞状态。' },
    services: { type: 'object', description: '插件能看到的宿主服务。' },
    runtime: { type: 'object', description: '宿主从哪里跑 pnpm、那份 payload 在不在，以及当前 DSH 版本。' },
    needsRuntimeRepair: { type: 'boolean', description: '剩下的问题是运行时 payload 缺失，不是锁。' },
    needsCompatibleVersion: { type: 'boolean', description: '剩下的问题是这个版本被本 DSH 判为不兼容，不是锁。' },
    skippedIncompatible: { type: 'array', description: '因为本 DSH 会拒绝而跳过的更新版本。' },
    requestId: { type: 'string', description: '管理器为这次更新分配的 request id。' },
    hint: { type: 'string' },
  },
  additionalProperties: true,
};

const DESCRIPTION =
  '修复 DSH 里被市场以“这个插件正在使用中”拒绝更新或卸载的插件。'
  + '桌面端热卸载之后常常还留着该插件的 fiber，插件管理器随即以 bundle-in-use 中止操作。'
  + '本工具释放这些 fiber，再把更新/卸载交还给管理器自己执行，'
  + '因此 profile、lockfile 与 dsh.profile.bundles 的记账方式与管理器亲手写下的完全一致。';

/**
 * @param {ReturnType<import('./repair.js').createRepair>} repair
 */
export function createUnlockTool(repair) {
  return {
    name: 'plugin_unlock',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      const action = typeof args.action === 'string' ? args.action : 'status';
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
      try {
        if (action === 'status') {
          const result = await repair.status({ name });
          return { action, ...result, hint: hintFor(name, result) };
        }
        if (action === 'in_use') {
          const result = await repair.status({ name, includeEvents: false });
          return {
            action,
            ok: result.ok === true,
            generatedAt: result.generatedAt,
            blocked: result.blocked ?? [],
            counts: result.counts ?? null,
            services: result.services ?? null,
          };
        }
        if (action === 'release') return { action, ...(await repair.release(name)) };
        if (action === 'runtime') {
          const runtime = repair.runtime();
          // 没有 hint 时干脆不带这个键：工具输出必须是可无损序列化的 JSON，
          // 带一个 undefined 会被宿主判为非法输出。
          return runtime.hint
            ? { action, ok: runtime.ok === true, runtime, hint: runtime.hint }
            : { action, ok: runtime.ok === true, runtime };
        }
        if (action === 'update') return { action, ...(await repair.update(name, { version: args.version })) };
        if (action === 'remove') return { action, ...(await repair.remove(name)) };
        if (action === 'heal') {
          return { action, ...(await repair.heal(name, { version: args.version, update: typeof args.update === 'boolean' ? args.update : undefined })) };
        }
        return { action, ok: false, reason: `未知的 action：${String(action)}` };
      } catch (error) {
        return {
          action,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          code: typeof (/** @type {any} */ (error)?.code) === 'string' ? /** @type {any} */ (error).code : null,
        };
      }
    },
  };
}

function hintFor(name, result) {
  if (result?.ok !== true) return '拿不到 pluginManager 服务，什么都没能检查。';
  if (result?.runtime && result.runtime.ok !== true) return result.runtime.hint;
  if (!name) {
    const blocked = Array.isArray(result.blocked) ? result.blocked.length : 0;
    return blocked === 0
      ? '当前没有被挡住的插件包。'
      : '用 plugin_unlock 的 action=heal 加上其中一个包名，即可释放它并把挂起的更新做完。';
  }
  const bundle = Array.isArray(result.bundles) ? result.bundles.find((item) => item.name === name) : undefined;
  if (!bundle) return `${name} 不在这个 profile 的插件包里。`;
  if (!bundle.blocked) return `${name} 没有被挡住，市场可以直接更新或卸载它。`;
  return `${name} 被 ${bundle.blockedBy.length} 个存活的 loader 条目挡住，执行 action=heal 即可。`;
}
