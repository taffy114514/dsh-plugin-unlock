/**
 * Automatic repair.
 *
 * The plugin manager reports every management operation on
 * `plugin-manager/operation`. When the marketplace's update or removal fails
 * with `bundle-in-use`, that operation is settled and there is nothing else the
 * marketplace will do — it shows the refusal and stops. This listener picks the
 * failure up, releases the fibers that survived the hot unload, and hands the
 * bundle back to the manager to finish the update.
 *
 * Guard rails, because an automatic rewrite of the profile must never loop:
 *  - only settled operations that actually failed with `bundle-in-use` qualify;
 *  - a bundle this plugin is already repairing is ignored (our own retry cannot
 *    trigger another repair);
 *  - one automatic repair per bundle per `cooldownMs` (default 10 minutes);
 *  - a short delay, so the failed operation's file lock is released first.
 */

import { PLUGIN_NAME } from './version.js';

const LOCK_SETTLE_MS = 500;

/**
 * Stages whose very first act is to unload the bundle and then test whether a
 * fiber survived. Releasing before the manager gets there is the difference
 * between "the update fails and is repaired afterwards" and "the update simply
 * works": the marketplace never shows the refusal at all.
 */
const PREVENTIVE_STAGES = new Set(['remove', 'update']);

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {{ctx: any, repair: any, config: any, state: {healing: Set<string>, inFlight: Set<string>, attempts: Map<string, number>}, log: Function}} input
 * @returns {() => void} disposer
 */
export function registerAutoHeal({ ctx, repair, config, state, log }) {
  if (typeof ctx?.on !== 'function') {
    log?.('autoheal-unavailable', { reason: 'the context exposes no event channel' });
    return () => {};
  }

  const onOperation = (record) => {
    // Never let a repair failure escape into the Host's event dispatch.
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
      /* a disposer that cannot run must not break the unload */
    }
  };

  /**
   * Release the bundle's fibers while the manager's own operation is starting.
   *
   * Deliberately synchronous up to the disposers: the Host does not await its
   * operation listeners, so anything awaited before `fiber.dispose()` here would
   * let the manager's in-use check run first — which is the very failure this
   * path exists to prevent.
   */
  function prevent(record, name) {
    if (name === PLUGIN_NAME) return; // never unload ourselves mid-operation
    // Core packages are the running Host; the manager refuses them as
    // not-removable long before an operation starts, so this is a belt.
    if (name.startsWith('@deepseek-ai/')) return;
    if (state.healing.has(name) || state.inFlight.has(name)) return; // our own repair
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

    // Preventive path: the manager is about to unload this bundle and then test
    // for a surviving fiber. Free it now, in this tick, before that check runs.
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
      log?.('autoheal-skip', { bundle: name, reason: 'a repair of this bundle is already running' });
      return;
    }
    if (repair.inCooldown(name)) {
      log?.('autoheal-skip', { bundle: name, reason: 'inside the cooldown window' });
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
