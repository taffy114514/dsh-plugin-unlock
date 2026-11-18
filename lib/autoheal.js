/**
 * 自动修复。
 *
 * 插件管理器把每次管理操作都广播到 `plugin-manager/operation`。市场的更新或卸载
 * 以 `bundle-in-use` 失败之后，那次操作就算结案了——市场会显示拒绝然后什么也不做。
 * 本监听器接住这次失败，把热卸载后残存的 fiber 释放掉，再把包交还给管理器完成更新。
 *
 * 有护栏，因为自动改写 profile 绝不允许成环：
 *  - 只处理真正以 `bundle-in-use` 结束的失败操作；
 *  - 本插件正在修的那个包直接忽略（自己的重试不能再触发一次修复）；
 *  - 同一个包在 `cooldownMs`（默认 10 分钟）内只自动修一次；
 *  - 先等一小会儿，让失败操作的文件锁先释放。
 */

import { PLUGIN_NAME } from './version.js';

const LOCK_SETTLE_MS = 500;

/**
 * 这些阶段的第一件事就是卸载 bundle、然后检查有没有 fiber 活下来。赶在管理器走到
 * 那一步之前释放，区别是“更新失败、事后再修”还是“更新直接就过去了”：后者市场
 * 根本不会显示那句拒绝。
 */
const PREVENTIVE_STAGES = new Set(['remove', 'update']);

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {{ctx: any, repair: any, config: any, state: {healing: Set<string>, inFlight: Set<string>, attempts: Map<string, number>}, log: Function}} input
 * @returns {() => void} 卸载函数
 */
export function registerAutoHeal({ ctx, repair, config, state, log }) {
  if (typeof ctx?.on !== 'function') {
    log?.('autoheal-unavailable', { reason: '这个上下文没有事件通道' });
    return () => {};
  }

  const onOperation = (record) => {
    // 修复失败绝不允许冒泡到宿主的事件派发里。
    try {
      void handleOperation(record).catch((error) => {
        log?.('autoheal-error', { message: error instanceof Error ? error.message : String(error) });
      });
    } catch (error) {
      log?.('autoheal-error', { message: error instanceof Error ? error.message : String(error) });
    }
  };

  const dispose = ctx.on('plugin-manager/operation', onOperation);
  log?.('autoheal-registered', { cooldownMs: config.cooldownMs, autoUpdate: config.autoUpdate });
  return () => {
    try {
      if (typeof dispose === 'function') dispose();
      else if (typeof ctx.off === 'function') ctx.off('plugin-manager/operation', onOperation);
    } catch {
      /* 跑不起来的卸载函数不能把整个卸载流程带崩 */
    }
  };

  /**
   * 在管理器自己的操作刚开始时，把这个包的 fiber 释放掉。
   *
   * 到 dispose 为止刻意保持同步：宿主派发 `plugin-manager/operation` 时不 await
   * 监听器，所以这里只要先 await 任何东西，管理器自己的“是否在用”检查就会抢在
   * 前面跑——而那正是这条路径要防的失败。
   */
  function prevent(record, name) {
    if (name === PLUGIN_NAME) return; // 绝不在操作中途卸载自己
    // 核心包就是正在跑的宿主本身；管理器在操作开始前就以 not-removable 拒掉它们，
    // 这里是再兜一道。
    if (name.startsWith('@deepseek-ai/')) return;
    if (state.healing.has(name) || state.inFlight.has(name)) return; // 我们自己正在修的
    let fast;
    try {
      fast = repair.releaseFast(name);
    } catch (error) {
      log?.('autoheal-error', { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!fast || fast.started === 0) return;
    log?.('prevent-release', {
      bundle: name,
      operationId: record.id ?? null,
      stage: record.stage ?? null,
      entries: fast.started,
    });
    void fast.settled
      .then((outcome) => {
        log?.(outcome.remaining === 0 ? 'prevent-released' : 'prevent-partial', {
          bundle: name,
          entries: fast.started,
          remaining: outcome.remaining,
          failed: outcome.failed,
          ms: outcome.ms,
        });
      })
      .catch((error) => log?.('autoheal-error', { message: error instanceof Error ? error.message : String(error) }));
  }

  async function handleOperation(record) {
    if (!record || typeof record !== 'object') return;
    const target = typeof record.target === 'string' ? record.target.trim() : '';

    // 抢先路径：管理器马上要把这个包卸掉、然后检查有没有活下来的 fiber。
    // 就在当前这个 tick 里放掉它，赶在那个检查之前。
    if (record.phase === 'started' && target && PREVENTIVE_STAGES.has(record.stage)) {
      prevent(record, target);
      return;
    }

    if (record.phase !== 'settled') return;
    if (record.application !== 'failed') return;
    if (record.errorCode !== 'bundle-in-use') return;
    const name = target;
    if (!name) return;
    if (state.healing.has(name) || state.inFlight.has(name)) {
      log?.('autoheal-skip', { bundle: name, reason: '这个包的修复已经在跑了' });
      return;
    }
    if (repair.inCooldown(name)) {
      log?.('autoheal-skip', { bundle: name, reason: '还在冷却窗口内' });
      return;
    }

    log?.('autoheal-start', { bundle: name, operationId: record.id ?? null, stage: record.stage ?? null });
    state.healing.add(name);
    try {
      await delay(LOCK_SETTLE_MS);
      const result = await repair.heal(name, { update: config.autoUpdate });
      log?.(result?.ok === true ? 'autoheal-done' : 'autoheal-failed', {
        bundle: name,
        step: result?.step ?? null,
        code: result?.error?.code ?? result?.result?.result?.error?.code ?? null,
        reason: result?.reason ?? null,
      });
    } finally {
      state.healing.delete(name);
    }
  }
}
