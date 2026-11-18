/**
 * The repair engine.
 *
 * Everything here goes through the services the running Host already exposes —
 * `pluginManager`, `loader`, `profileContext` — never through the filesystem or
 * a second pnpm run. That keeps the profile's package.json, pnpm lockfile and
 * `dsh.profile.bundles` bookkeeping exactly as the plugin manager wrote it, which
 * is the whole reason the desktop refuses the removal in the first place: it
 * wants to unload the plugin cleanly, not to leave a half-removed package.
 *
 * The sequence for a stuck bundle is:
 *   1. release  — dispose the loader entries whose fiber survived the hot unload
 *                 (`Fiber.dispose()` clears `fiber.uid`, which is exactly the
 *                 flag the manager tests);
 *   2. update   — hand the same bundle back to `pluginManager.updateBundle()`,
 *                 which re-runs its own remove → install → reload;
 *   3. remove   — or `pluginManager.removeBundle()` when removal was the goal.
 *
 * If the manager still refuses, the caller gets the manager's own error code and
 * nothing has been changed behind its back.
 */
import { describeEntry, inUseEntries, summarize } from './keys.js';
import { looksLikeRuntimeFailure, probeRuntime, runtimeHint } from './runtime.js';

/**
 * A JSON-safe description of a thrown value.
 * @param {unknown} error
 */
export function errorFact(error) {
  const code = typeof (/** @type {any} */ (error)?.code) === 'string' ? /** @type {any} */ (error).code : null;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

/** A release that refused outright, rather than one that ran and left entries behind. */
function refusedRelease(released) {
  return released?.ok === false && !Array.isArray(released?.released);
}

function safeGet(ctx, service) {
  try {
    return ctx?.get?.(service) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {{ctx: any, config: import('./config.js').UnlockConfig, state: {healing: Set<string>, inFlight: Set<string>, attempts: Map<string, number>}, log: Function, probe?: Function}} input
 */
export function createRepair({ ctx, config, state, log, probe = probeRuntime }) {
  const manager = () => safeGet(ctx, 'pluginManager');
  const loader = () => safeGet(ctx, 'loader');

  function services() {
    const connection = safeGet(ctx, 'connection');
    return {
      pluginManager: Boolean(manager()),
      loader: Boolean(loader()),
      profileContext: Boolean(safeGet(ctx, 'profileContext')),
      hmr: Boolean(safeGet(ctx, 'hmr')),
      webServer: Boolean(safeGet(ctx, 'webServer')),
      tools: Boolean(safeGet(ctx, 'tools')),
      commands: Boolean(safeGet(ctx, 'commands')),
      connection: Boolean(connection),
    };
  }

  /**
   * The Host's own pnpm, checked rather than assumed. A release fixes the lock;
   * it cannot fix a payload that is not on disk, and saying so beats letting the
   * update fail with `MODULE_NOT_FOUND` afterwards.
   */
  function runtime() {
    const result = probe();
    return { ...result, hint: runtimeHint(result) };
  }

  /** Live entries of one bundle, described for the report. */
  function inUse(name) {
    return inUseEntries({ loader: loader(), manager: manager(), name }).map(describeEntry);
  }

  /** Raw entries, kept inside the engine. */
  function liveEntries(name) {
    return inUseEntries({ loader: loader(), manager: manager(), name });
  }

  /**
   * Whether the manager would ever try to remove this bundle.
   *
   * This is the safety catch for the whole plugin. Every core bundle
   * (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`) has dozens of live
   * fibers by design, and an installation bundle is not managed by this
   * profile at all. Their fibers matching their own rows is normal, not a
   * stuck update — the manager answers `not-removable` long before it reaches
   * the in-use check. Releasing those fibers would tear the running Host
   * apart, so they are reported, never repaired.
   *
   * @param {any} bundle a `listBundles()` row
   */
  function repairable(bundle) {
    if (!bundle || typeof bundle.name !== 'string') return false;
    if (bundle.removable === false) return false;
    if (bundle.official === true) return false;
    return bundle.availability === 'profile';
  }

  /** Every bundle the manager knows, filtered to the ones a removal could block. */
  async function statuses(filter) {
    const m = manager();
    if (!m || typeof m.listBundles !== 'function') {
      return { ok: false, reason: 'the pluginManager service is not available', services: services() };
    }
    let listed;
    try {
      listed = await m.listBundles();
    } catch (error) {
      return { ok: false, reason: 'listBundles() failed', error: errorFact(error), services: services() };
    }
    const bundles = (Array.isArray(listed) ? listed : [])
      .filter((bundle) => !filter || bundle?.name === filter)
      .filter((bundle) => bundle && typeof bundle.name === 'string')
      .map((bundle) => {
        const live = inUse(bundle.name);
        const canRepair = repairable(bundle);
        return {
          name: bundle.name,
          version: bundle.version ?? null,
          enabled: bundle.enabled === true,
          installed: bundle.installed === true,
          official: bundle.official === true,
          availability: bundle.availability ?? null,
          removable: bundle.removable !== false,
          readOnlyReason: bundle.readOnlyReason ?? null,
          update: bundle.update ?? null,
          blockedBy: live,
          // "blocked" means the marketplace would refuse THIS bundle — not that
          // it happens to have loaded code, which every installed plugin does.
          blocked: live.length > 0 && canRepair,
          repairable: canRepair,
        };
      });
    return { ok: true, bundles, services: services() };
  }

  /**
   * Status of one bundle or of every bundle, plus what the plugin can do about it.
   * @param {{name?: string, includeEvents?: boolean}} [options]
   */
  async function status(options = {}) {
    const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : undefined;
    const result = await statuses(name);
    if (result.ok !== true) return { ...result, generatedAt: new Date().toISOString() };
    const blocked = result.bundles.filter((bundle) => bundle.blocked);
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      services: result.services,
      runtime: runtime(),
      config: {
        autoFix: config.autoFix,
        autoUpdate: config.autoUpdate,
        cooldownMs: config.cooldownMs,
        route: config.route,
      },
      counts: { bundles: result.bundles.length, blocked: blocked.length },
      blocked: blocked.map((bundle) => ({ name: bundle.name, entries: bundle.blockedBy })),
      bundles: name ? result.bundles : result.bundles.map((bundle) => ({
        ...bundle,
        blockedBy: bundle.blocked ? bundle.blockedBy : [],
      })),
      reportFile: log?.file ?? null,
      ...(options.includeEvents === false ? {} : { events: log?.events?.slice(-config.maxLogEvents) ?? [] }),
    };
  }

  /**
   * Step 1 — dispose every live fiber that blocks the bundle.
   * Nothing is written to the profile: this only stops the running plugins.
   *
   * @param {string} [name] bundle name; omitted, every blocked bundle is released.
   */
  async function release(name) {
    const m = manager();
    if (!m) return { ok: false, reason: 'the pluginManager service is not available', services: services() };

    const explicit = typeof name === 'string' && name.trim() ? name.trim() : null;
    if (explicit) {
      // Never tear down code the manager would refuse to remove anyway: a core
      // bundle's fibers are the running Host, not a stuck update.
      const listed = await statuses(explicit);
      if (listed.ok !== true) return { ok: false, bundle: explicit, reason: listed.reason, services: listed.services };
      const target = listed.bundles?.[0];
      if (!target) return { ok: false, bundle: explicit, reason: `${explicit} is not a bundle this profile lists` };
      if (target.repairable !== true) {
        return {
          ok: false,
          bundle: explicit,
          blocked: target.blocked,
          reason: `${explicit} is ${target.official ? 'an official' : target.availability === 'installation' ? 'an installation' : 'a protected'} bundle; the manager refuses it as not-removable before the in-use check, so its entries are reported but never released`,
        };
      }
    }

    const names = explicit
      ? [explicit]
      : (await statuses()).bundles?.filter((bundle) => bundle.blocked).map((bundle) => bundle.name) ?? [];
    if (names.length === 0) return { ok: true, released: [], note: 'no bundle is blocked by a live entry' };

    const released = [];
    for (const bundleName of names) {
      const before = liveEntries(bundleName);
      const steps = [];
      for (const entry of before) {
        const described = describeEntry(entry);
        try {
          if (!entry?.fiber || typeof entry.fiber.dispose !== 'function') {
            steps.push({ ...described, released: false, error: { code: 'no-fiber', message: 'the loader entry exposes no fiber to dispose' } });
            continue;
          }
          await entry.fiber.dispose();
          steps.push({ ...described, released: entry.fiber.uid == null, uid: entry.fiber.uid ?? null });
        } catch (error) {
          steps.push({ ...described, released: false, error: errorFact(error) });
        }
      }
      const after = liveEntries(bundleName);
      if (before.length > 0) log('release', { bundle: bundleName, entries: steps.length, remaining: after.length });
      released.push({
        bundle: bundleName,
        ok: after.length === 0,
        summary: summarize(bundleName, before),
        steps,
        remaining: after.map(describeEntry),
      });
    }
    return { ok: released.every((item) => item.ok), released };
  }

  /**
   * Resolve the version an update should target: the caller's, else the newest
   * version the registry lists above the installed one.
   */
  async function resolveVersion(m, name, requested) {
    if (typeof requested === 'string' && requested.trim()) return { version: requested.trim(), source: 'request' };
    if (typeof m.listVersions !== 'function') return { refusal: { status: 'refused', problem: 'no-list-versions', reason: 'this plugin manager lists no versions' } };
    let listing;
    try {
      listing = await m.listVersions(name, {});
    } catch (error) {
      return { refusal: { status: 'refused', problem: 'list-versions-failed', reason: errorFact(error) } };
    }
    if (listing?.status === 'listed' && Array.isArray(listing.versions) && listing.versions.length > 0) {
      return { version: listing.versions[0].version, source: 'registry', listing: { installed: listing.installed ?? null, registry: listing.registry ?? null, newer: listing.versions.length } };
    }
    return { refusal: listing ?? { status: 'refused', problem: 'unknown', reason: 'no version list' } };
  }

  /**
   * Step 2 — the manager's own update, now that nothing blocks it.
   * `updateBundle` removes, installs and reloads; on its own failure it restores
   * the version it removed, so a failed attempt leaves the profile as it was.
   */
  async function runUpdate(name, requestedVersion) {
    const m = manager();
    if (!m || typeof m.updateBundle !== 'function') {
      return { ok: false, step: 'update', bundle: name, reason: 'the pluginManager service does not expose updateBundle()' };
    }
    const target = await resolveVersion(m, name, requestedVersion);
    if (!target.version) {
      return {
        ok: false,
        step: 'list-versions',
        bundle: name,
        reason: 'no newer version could be resolved, so the removal was only released',
        retryInMarket: true,
        refusal: target.refusal,
      };
    }
    try {
      const result = await m.updateBundle(name, target.version, {});
      const failed = result?.result?.application === 'failed' || Boolean(result?.result?.error);
      log('update', { bundle: name, to: target.version, ok: !failed, code: result?.result?.error?.code ?? null });
      return {
        ok: !failed,
        step: 'update',
        bundle: name,
        from: result?.from ?? null,
        to: target.version,
        versionSource: target.source,
        result,
      };
    } catch (error) {
      const fact = errorFact(error);
      log('update-failed', { bundle: name, code: fact.code, message: fact.message });
      if (looksLikeRuntimeFailure(error)) {
        return { ok: false, step: 'runtime', bundle: name, to: target.version, error: fact, runtime: runtime(), needsRuntimeRepair: true };
      }
      return { ok: false, step: 'update', bundle: name, to: target.version, error: fact };
    }
  }

  /**
   * Release, then hand the bundle back to the manager for its update.
   * @param {string} name
   * @param {{version?: string, update?: boolean}} [options]
   */
  async function update(name, options = {}) {
    const bundleName = typeof name === 'string' ? name.trim() : '';
    if (!bundleName) return { ok: false, reason: 'a bundle name is required' };
    const released = await release(bundleName);
    if (refusedRelease(released)) {
      return { ok: false, step: 'release', bundle: bundleName, reason: released.reason, release: released };
    }
    if (released.released?.[0] && released.released[0].ok !== true) {
      return { ok: false, step: 'release', bundle: bundleName, reason: 'a live entry survived the release, so the update was not attempted', release: released };
    }
    const environment = runtime();
    if (environment.ok !== true) {
      return {
        ok: false,
        step: 'runtime',
        bundle: bundleName,
        reason: 'the lock was cleared, but the Host cannot run pnpm: its runtime payload is missing',
        runtime: environment,
        needsRuntimeRepair: true,
        released: summarizeRelease(released),
      };
    }
    return { ...(await runUpdate(bundleName, options.version)), released: summarizeRelease(released) };
  }

  /**
   * Release, then let the manager remove the package.
   * @param {string} name
   */
  async function remove(name) {
    const bundleName = typeof name === 'string' ? name.trim() : '';
    if (!bundleName) return { ok: false, reason: 'a bundle name is required' };
    const m = manager();
    if (!m || typeof m.removeBundle !== 'function') {
      return { ok: false, reason: 'the pluginManager service does not expose removeBundle()' };
    }
    const released = await release(bundleName);
    if (refusedRelease(released)) {
      return { ok: false, step: 'release', bundle: bundleName, reason: released.reason, release: released };
    }
    if (released.released?.[0] && released.released[0].ok !== true) {
      return { ok: false, step: 'release', bundle: bundleName, reason: 'a live entry survived the release, so the removal was not attempted', release: released };
    }
    const environment = runtime();
    if (environment.ok !== true) {
      return {
        ok: false,
        step: 'runtime',
        bundle: bundleName,
        reason: 'the lock was cleared, but the Host cannot run pnpm: its runtime payload is missing',
        runtime: environment,
        needsRuntimeRepair: true,
        released: summarizeRelease(released),
      };
    }
    try {
      const result = await m.removeBundle(bundleName);
      const failed = Boolean(result?.error) || result?.application === 'failed';
      log('remove', { bundle: bundleName, ok: !failed, code: result?.error?.code ?? null });
      return { ok: !failed, step: 'remove', bundle: bundleName, result, released: summarizeRelease(released) };
    } catch (error) {
      const fact = errorFact(error);
      log('remove-failed', { bundle: bundleName, code: fact.code, message: fact.message });
      if (looksLikeRuntimeFailure(error)) {
        return { ok: false, step: 'runtime', bundle: bundleName, error: fact, runtime: runtime(), needsRuntimeRepair: true, released: summarizeRelease(released) };
      }
      return { ok: false, step: 'remove', bundle: bundleName, error: fact };
    }
  }

  /**
   * The one call a stuck user needs: clear the block, then finish the job unless
   * the caller asked for the release alone.
   * @param {string} name
   * @param {{version?: string, update?: boolean}} [options]
   */
  async function heal(name, options = {}) {
    const bundleName = typeof name === 'string' ? name.trim() : '';
    if (!bundleName) return { ok: false, reason: 'a bundle name is required' };
    if (state.inFlight.has(bundleName)) {
      return { ok: false, busy: true, bundle: bundleName, reason: 'a repair of this bundle is already running' };
    }
    state.inFlight.add(bundleName);
    state.attempts.set(bundleName, Date.now());
    try {
      const released = await release(bundleName);
      if (refusedRelease(released)) {
        log('heal-refused', { bundle: bundleName });
        return { ok: false, step: 'release', bundle: bundleName, reason: released.reason, release: released };
      }
      const stillBlocked = released.released?.[0]?.ok !== true;
      if (stillBlocked) {
        log('heal-blocked', { bundle: bundleName });
        return {
          ok: false,
          step: 'release',
          bundle: bundleName,
          reason: 'a live entry survived the release; restart DSH to finish',
          release: released,
          needsRestart: true,
        };
      }
      const shouldUpdate = options.update === true || (options.update !== false && config.autoUpdate);
      if (!shouldUpdate) {
        log('heal-released', { bundle: bundleName });
        return { ok: true, step: 'release', bundle: bundleName, released: summarizeRelease(released), note: 'released only; retry the update in the marketplace or pass update: true' };
      }
      const updated = await runUpdate(bundleName, options.version);
      log(updated.ok ? 'heal' : 'heal-failed', { bundle: bundleName, step: updated.step, code: updated.error?.code ?? updated.result?.result?.error?.code ?? null });
      return { ...updated, released: summarizeRelease(released) };
    } finally {
      state.inFlight.delete(bundleName);
    }
  }

  /** Whether the automatic repair of this bundle is inside its cooldown window. */
  function inCooldown(name) {
    const last = state.attempts.get(name);
    return typeof last === 'number' && Date.now() - last < config.cooldownMs;
  }

  return { services, inUse, status, release, update, remove, heal, inCooldown, liveEntries, runUpdate, runtime };
}

function summarizeRelease(released) {
  const items = Array.isArray(released?.released) ? released.released : [];
  return items.map((item) => ({ bundle: item.bundle, ok: item.ok, released: item.steps.filter((step) => step.released).length, remaining: item.remaining.length }));
}
