/**
 * dsh-plugin-unlock
 *
 * The desktop marketplace refuses to update or remove a plugin with
 * "the plugin is in use, and the desktop app will not remove it right now".
 * The refusal is `plugin-manager`'s `bundle-in-use`: after the bundle is
 * deselected and the composition reloaded, a loader entry of that bundle still
 * runs a live fiber, so the manager will not drop the package behind a running
 * plugin.
 *
 * No file is wrong in that state — only the running composition is. So this
 * plugin never edits package.json, never runs pnpm behind the manager's back and
 * never forces the profile into a state the manager would not have written: it
 * disposes the surviving fibers (`Fiber.dispose()` clears the `fiber.uid` the
 * manager tests), and then lets the manager redo its own remove → install →
 * reload.
 *
 * Three surfaces, one engine:
 *   - the `plugin_unlock` tool, so the assistant can repair it on request;
 *   - `/dsh-plugin-unlock/*` routes for a browser or curl;
 *   - an automatic repair of every `bundle-in-use` failure the Host reports,
 *     so the marketplace's update simply goes through on the next attempt.
 */
import { normalizeConfig } from './lib/config.js';
import { createRepair } from './lib/repair.js';
import { createReportLog } from './lib/report.js';
import { createUnlockTool } from './lib/tool.js';
import { registerRoutes } from './lib/route.js';
import { registerAutoHeal } from './lib/autoheal.js';
import { PLUGIN_NAME, PLUGIN_VERSION } from './lib/version.js';

export const name = PLUGIN_NAME;
export const version = PLUGIN_VERSION;

/**
 * @param {any} ctx the plugin's cordis context
 * @param {unknown} rawConfig the `config` block of the bundle patch row
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const log = createReportLog(config);
  /** Shared repair state: what this plugin is currently doing, and how recently. */
  const state = {
    healing: new Set(),
    inFlight: new Set(),
    attempts: new Map(),
  };
  const repair = createRepair({ ctx, config, state, log });

  // `tools` and `webServer` may mount after this bundle: on a cold boot the
  // marketplace's layers can come up before the services they talk to. Sampling
  // `ctx.get()` once in an effect then quietly registers nothing, which is how
  // 0.1.3 ended up loaded but invisible. `ctx.inject()` waits for the service.
  const inject = typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : null;

  const mountTool = (host) => {
    host.effect(() => {
      const tools = host.get('tools');
      if (!tools || typeof tools.register !== 'function') {
        log('tool-unavailable', { reason: 'the tools service is not available' });
        return () => {};
      }
      try {
        const dispose = tools.register(createUnlockTool(repair));
        log('tool-registered', { tool: 'plugin_unlock' });
        return typeof dispose === 'function' ? dispose : () => {};
      } catch (error) {
        log('tool-failed', { message: error instanceof Error ? error.message : String(error) });
        return () => {};
      }
    }, 'dsh-plugin-unlock: tool');
  };

  const mountRoutes = (host) => {
    host.effect(() => registerRoutes({ ctx: host, repair, config, log }), 'dsh-plugin-unlock: routes');
  };

  if (inject) {
    inject(['tools'], mountTool);
    inject(['webServer'], mountRoutes);
  } else {
    mountTool(ctx);
    mountRoutes(ctx);
  }

  if (config.autoFix) {
    ctx.effect(() => registerAutoHeal({ ctx, repair, config, state, log }), 'dsh-plugin-unlock: auto-heal');
  }

  log('ready', {
    version: PLUGIN_VERSION,
    autoFix: config.autoFix,
    autoUpdate: config.autoUpdate,
    route: config.route,
  });
}
