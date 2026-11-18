/**
 * dsh-plugin-unlock 的运行时配置。
 *
 * 本插件刻意不带任何依赖（连 schemastery 都不要），所以 `cordis.patch.yml` 里的
 * `config:` 块由这里手工归一化：每个值缺失或格式不对时，都退回安全默认值。
 */

/** @typedef {ReturnType<typeof normalizeConfig>} UnlockConfig */

export const DEFAULTS = Object.freeze({
  /** 宿主一报 `bundle-in-use` 失败就自动修复。 */
  autoFix: true,
  /** 释放成功之后，把市场放弃的那次更新做完。 */
  autoUpdate: true,
  /** 同一个包两次自动修复之间的最小间隔。 */
  cooldownMs: 600000,
  /** HTTP 界面的挂载前缀。 */
  route: '/dsh-plugin-unlock',
  /** 把每次修复镜像写进 JSONL 报告文件。 */
  log: true,
  /** 单次管理器调用最多等多久，超时就按超时上报。 */
  deadlineMs: 180000,
  /** status 接口在内存里保留多少条事件。 */
  maxLogEvents: 50,
});

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function asRoute(value, fallback) {
  if (typeof value !== 'string') return fallback;
  let route = value.trim();
  if (!route) return fallback;
  if (!route.startsWith('/')) route = `/${route}`;
  while (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
  return route;
}

/**
 * 把组合层递过来的东西归一化成一份完整配置。
 * @param {unknown} raw patch 行里的 `config` 对象。
 * @returns {{autoFix: boolean, autoUpdate: boolean, cooldownMs: number, route: string, log: boolean, deadlineMs: number, maxLogEvents: number}}
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    autoFix: asBool(source.autoFix, DEFAULTS.autoFix),
    autoUpdate: asBool(source.autoUpdate, DEFAULTS.autoUpdate),
    cooldownMs: asNumber(source.cooldownMs, DEFAULTS.cooldownMs),
    route: asRoute(source.route, DEFAULTS.route),
    log: asBool(source.log, DEFAULTS.log),
    deadlineMs: asNumber(source.deadlineMs, DEFAULTS.deadlineMs),
    maxLogEvents: Math.max(1, Math.floor(asNumber(source.maxLogEvents, DEFAULTS.maxLogEvents))),
  };
}
