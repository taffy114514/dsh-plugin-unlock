/**
 * Runtime configuration for dsh-plugin-unlock.
 *
 * The plugin deliberately carries no dependency (not even schemastery), so the
 * `config:` block of `cordis.patch.yml` is normalised by hand and every value
 * falls back to a safe default when it is missing or malformed.
 */

/** @typedef {ReturnType<typeof normalizeConfig>} UnlockConfig */

export const DEFAULTS = Object.freeze({
  /** Repair a `bundle-in-use` failure as soon as the Host reports it. */
  autoFix: true,
  /** After a successful release, finish the update the marketplace gave up on. */
  autoUpdate: true,
  /** Minimum gap between two automatic repairs of the same bundle. */
  cooldownMs: 600000,
  /** Prefix the HTTP surface is mounted on. */
  route: '/dsh-plugin-unlock',
  /** Mirror every repair into the JSONL report file. */
  log: true,
  /** How long one manager call may take before the repair reports a timeout. */
  deadlineMs: 180000,
  /** How many in-memory events the status endpoint keeps. */
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
 * Normalise whatever the composition handed over into a complete config.
 * @param {unknown} raw the `config` object from the patch row.
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
