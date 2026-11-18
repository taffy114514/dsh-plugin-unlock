/**
 * The one piece of knowledge this plugin is built on: what "in use" means to
 * `@deepseek-ai/dsh-plugin-manager`.
 *
 * `PluginManager#removeBundle` refuses a removal when, after the bundle was
 * deselected and the composition reloaded, a loader entry that belongs to the
 * bundle still runs a live fiber:
 *
 * ```js
 * if ([...this.ctx.loader.entries()].some((entry) =>
 *       entry.fiber?.uid != null &&
 *       contributions.some((row) => row.id === entry.options.id && row.name === entry.options.name)))
 *   throw new ManagementFailure('bundle-in-use');
 * ```
 *
 * These helpers mirror exactly that predicate, so the plugin can name the
 * entries that block a bundle and then release them.
 *
 * Nothing here imports DSH internals: the loader, the manager and the entries
 * are handed in, which keeps the logic unit-testable.
 */

/** A fiber that still owns a uid is loaded; `Fiber.dispose()` clears it to `null`. */
export function isLiveFiber(entry) {
  return entry?.fiber?.uid != null;
}

function rowKey(id, name) {
  return `${typeof id === 'string' ? id : ''}\u0000${typeof name === 'string' ? name : ''}`;
}

/**
 * Read every loader entry, tolerating a loader that is not mounted yet.
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
 * The flattened patch rows a bundle contributes, straight from the manager.
 * The manager itself is the only authority for this list; when it cannot answer
 * the caller falls back to matching by plugin name.
 *
 * @param {{bundleRows?: (name: string) => unknown} | null | undefined} manager
 * @param {string} name bundle name
 * @returns {Array<{id?: unknown, name?: unknown}>}
 */
export function bundleRows(manager, name) {
  return readRows(manager, name).rows;
}

/**
 * The same read, but it also reports whether the manager could answer at all.
 *
 * The distinction matters: a bundle that answers `[]` contributes no plugin rows
 * the manager could refuse over, while a manager that cannot answer at all
 * (no `bundleRows`, an unknown bundle, a broken manifest) leaves the question
 * open and the name-based fallback is used instead.
 *
 * @param {{bundleRows?: (name: string) => unknown} | null | undefined} manager
 * @param {string} name bundle name
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
 * Best-effort origin of an entry, used for humans reading the report.
 * Mirrors what the manager's own diagnostics read.
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
 * Describe one loader entry without holding onto live objects.
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
 * The loader entries that make the manager refuse a removal of `name`.
 *
 * Matching is intentionally two-tiered:
 *  1. exact (id, name) pairs from `manager.bundleRows(name)` — the predicate the
 *     manager uses, so a hit here is guaranteed to block the removal. A bundle
 *     that reports no rows is not refused by the manager, and nothing matches;
 *  2. only when the manager cannot list the rows at all (no `bundleRows`, an
 *     unknown bundle, a broken manifest): match the bundle name itself, a nested
 *     `<name>/...` plugin name, or an entry whose id is the bundle name.
 *
 * @param {{loader?: any, manager?: any, name: string}} input
 * @returns {any[]} live loader entries that belong to the bundle
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
 * One-line reason for a human, e.g. `dsh-caveman → 2 live entries (dsh-caveman, dsh-caveman/ui)`.
 * @param {string} name
 * @param {any[]} entries
 */
export function summarize(name, entries) {
  if (entries.length === 0) return `${name}: no live entry blocks it`;
  const labels = entries
    .map((entry) => {
      const options = entry?.options ?? {};
      return typeof options.id === 'string' && options.id ? options.id : String(options.name ?? '?');
    })
    .join(', ');
  return `${name}: ${entries.length} live ${entries.length === 1 ? 'entry' : 'entries'} blocking it (${labels})`;
}
