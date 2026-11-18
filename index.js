/**
 * dsh-plugin-unlock
 *
 * 桌面端市场在更新或卸载插件时会拒绝，提示“这个插件正在使用中，桌面端不允许现在
 * 移除”。这个拒绝来自 `plugin-manager` 的 `bundle-in-use`：把 bundle 从组合里
 * 摘掉、重新加载之后，属于它的某个 loader 条目仍然跑着活 fiber，于是管理器不肯
 * 在一个正在运行的插件背后把包抽走。
 *
 * 这种状态下没有任何文件是错的，错的只是当前这份运行中的组合。所以本插件不碰
 * package.json、不在管理器背后偷偷跑 pnpm、也不把 profile 改成管理器不会写成的
 * 样子：它只把那些存活的 fiber 释放掉（`Fiber.dispose()` 会清掉管理器要检查的
 * `fiber.uid`），再把 remove → install → reload 交还给管理器自己做。
 *
 * 三个入口，同一个引擎：
 *   - `plugin_unlock` 工具，助手接到报障就能直接修；
 *   - `/dsh-plugin-unlock/*` 路由，浏览器或 curl 都能用；
 *   - 对宿主报告的每一次 `bundle-in-use` 失败自动修复，市场的更新下一次就过去了。
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
 * @param {any} ctx 本插件的 cordis 上下文
 * @param {unknown} rawConfig bundle patch 行里的 `config` 块
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const log = createReportLog(config);
  /** 共享的修复状态：插件此刻在做什么、上一次做是什么时候。 */
  const state = {
    healing: new Set(),
    inFlight: new Set(),
    attempts: new Map(),
  };
  const repair = createRepair({ ctx, config, state, log });

  // `tools` 和 `webServer` 可能比本 bundle 挂得更晚：冷启动时市场的组合层常常先于
  // 它要用的服务起来。在 effect 里只 `ctx.get()` 一次，服务没到就默默什么都没注册
  // ——0.1.3 就是这样“装了但看不见”。改用 `ctx.inject()` 等它。
  const inject = typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : null;

  const mountTool = (host) => {
    host.effect(() => {
      const tools = host.get('tools');
      if (!tools || typeof tools.register !== 'function') {
        log('tool-unavailable', { reason: '拿不到 tools 服务' });
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
