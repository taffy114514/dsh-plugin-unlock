/**
 * 整个插件只依赖这一条知识：对 `@deepseek-ai/dsh-plugin-manager` 来说，
 * “正在使用中”到底是什么意思。
 *
 * `PluginManager#removeBundle` 在把 bundle 从组合里摘掉、重新加载之后，
 * 只要还有属于该 bundle 的 loader 条目跑着活 fiber，就拒绝卸载：
 *
 * ```js
 * if ([...this.ctx.loader.entries()].some((entry) =>
 *       entry.fiber?.uid != null &&
 *       contributions.some((row) => row.id === entry.options.id && row.name === entry.options.name)))
 *   throw new ManagementFailure('bundle-in-use');
 * ```
 *
 * 下面这些函数就是把这条判断原样抄下来，因此插件能指出到底是哪些条目挡住了某个
 * 包，然后把它们释放掉。
 *
 * 这里不 import 任何 DSH 内部模块：loader、manager、entry 都是外部传进来的，
 * 逻辑因此可以脱离宿主做单元测试。
 */

/** fiber 还持有 uid 就说明它还活着；`Fiber.dispose()` 会把它清成 `null`。 */
export function isLiveFiber(entry) {
  return entry?.fiber?.uid != null;
}

function rowKey(id, name) {
  return `${typeof id === 'string' ? id : ''}\u0000${typeof name === 'string' ? name : ''}`;
}

/**
 * 读出全部 loader 条目，loader 还没挂上也照样能跑。
 * @param {{entries?: () => Iterable<unknown>} | null | undefined} loader
 * @returns {any[]}
 */
export function entriesOf(loader) {
  if (loader === null || loader === undefined || typeof loader.entries !== 'function') return [];
  try {
    const iterator = loader.entries();
    return iterator === null || iterator === undefined ? [] : [...iterator];
  } catch {
    return [];
  }
}

/**
 * 某个 bundle 贡献的、拍平后的 patch 行，直接问管理器要。
 * 这份列表只有管理器说了算；它答不上来时，调用方退化成按插件名匹配。
 *
 * @param {{bundleRows?: (name: string) => unknown} | null | undefined} manager
 * @param {string} name bundle 名
 * @returns {Array<{id?: unknown, name?: unknown}>}
 */
export function bundleRows(manager, name) {
  return readRows(manager, name).rows;
}

/**
 * 同一次读取，但额外告诉调用方：管理器到底答上了没有。
 *
 * 这个区别很关键：一个答 `[]` 的 bundle 没有贡献任何可被拒绝的插件行，所以什么
 * 都不该匹配；而管理器整个答不上来（没有 `bundleRows`、不认识的 bundle、清单坏
 * 了）时，问题仍然悬着，这时才用按名字匹配的兜底规则。
 *
 * @param {{bundleRows?: (name: string) => unknown} | null | undefined} manager
 * @param {string} name bundle 名
 * @returns {{known: boolean, rows: Array<{id?: unknown, name?: unknown}>}}
 */
export function readRows(manager, name) {
  if (manager === null || manager === undefined || typeof manager.bundleRows !== 'function') {
    return { known: false, rows: [] };
  }
  try {
    const rows = manager.bundleRows(name);
    if (!Array.isArray(rows)) return { known: false, rows: [] };
    return { known: true, rows: rows.filter((row) => row !== null && typeof row === 'object') };
  } catch {
    return { known: false, rows: [] };
  }
}

/**
 * 条目的来源，尽量读；只给人看报告时用。
 * 读的东西和管理器自己的诊断一致。
 *
 * @param {any} entry
 * @returns {string | null}
 */
export function baseUrlOf(entry) {
  try {
    const base = entry?.parent?.tree?.ctx?.baseUrl;
    return typeof base === 'string' ? base : null;
  } catch {
    return null;
  }
}

/**
 * 把一个 loader 条目描述成纯数据，不长期持有活对象。
 * @param {any} entry
 */
export function describeEntry(entry) {
  const options = entry?.options ?? {};
  return {
    id: typeof options.id === 'string' ? options.id : null,
    name: typeof options.name === 'string' ? options.name : null,
    uid: entry?.fiber?.uid ?? null,
    state: entry?.fiber?.state ?? null,
    source: baseUrlOf(entry),
  };
}

/**
 * 让管理器拒绝卸载 `name` 的那些 loader 条目。
 *
 * 匹配刻意分成两级：
 *  1. 用 `manager.bundleRows(name)` 给出的 (id, name) 精确配对——这正是管理器的
 *     判断依据，命中就一定挡得住卸载。一个报不出任何行的 bundle，管理器本来也
 *     不会拒绝它，因此什么都不匹配；
 *  2. 只有管理器连行都列不出来时（没有 `bundleRows`、不认识的 bundle、清单坏了），
 *     才退化成：匹配 bundle 名本身、嵌套的 `<name>/...` 插件名，或 id 等于 bundle
 *     名的条目。
 *
 * @param {{loader?: any, manager?: any, name: string}} input
 * @returns {any[]} 属于该 bundle 且仍然存活的 loader 条目
 */
export function inUseEntries({ loader, manager, name }) {
  if (typeof name !== 'string' || name === '') return [];
  const entries = entriesOf(loader);
  if (entries.length === 0) return [];

  const { known, rows } = readRows(manager, name);
  const keys = new Set();
  for (const row of rows) keys.add(rowKey(row.id, row.name));
  const prefix = `${name}/`;

  const matched = [];
  for (const entry of entries) {
    if (!isLiveFiber(entry)) continue;
    const options = entry?.options ?? {};
    let hit = known ? keys.has(rowKey(options.id, options.name)) : false;
    if (!hit && !known) {
      const id = typeof options.id === 'string' ? options.id : '';
      const pluginName = typeof options.name === 'string' ? options.name : '';
      hit = pluginName === name || id === name || pluginName.startsWith(prefix);
    }
    if (hit) matched.push(entry);
  }
  return matched;
}

/**
 * 给人看的一句话，例如 `dsh-caveman：2 个存活条目挡着（dsh-caveman, dsh-caveman/ui）`。
 * @param {string} name
 * @param {any[]} entries
 */
export function summarize(name, entries) {
  if (entries.length === 0) return `${name}：没有存活条目挡着`;
  const labels = entries
    .map((entry) => {
      const options = entry?.options ?? {};
      return typeof options.id === 'string' && options.id ? options.id : String(options.name ?? '?');
    })
    .join(', ');
  return `${name}：${entries.length} 个存活条目挡着（${labels}）`;
}
