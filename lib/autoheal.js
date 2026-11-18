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

const LOCK_SETTLE_MS = 500;

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

  async function handleOperation(record) {
    if (!record || typeof record !== 'object') return;
    if (record.phase !== 'settled') return;
    if (record.application !== 'failed') return;
    if (record.errorCode !== 'bundle-in-use') return;
    const name = typeof record.target === 'string' ? record.target.trim() : '';
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
