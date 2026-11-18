/**
 * 修复引擎。
 *
 * 这里的一切都走正在运行的宿主已经暴露的服务——`pluginManager`、`loader`、
 * `profileContext`——绝不经由文件系统，也绝不自己再跑一次 pnpm。这样 profile 的
 * package.json、pnpm lockfile 和 `dsh.profile.bundles` 的记账就完全保持插件管理器
 * 亲手写下的样子；而这正是桌面端一开始就拒绝卸载的原因：它想要干净地卸载插件，
 * 而不是留下一个卸了一半的包。
 *
 * 卡住的包按这个顺序处理：
 *   1. release — 把热卸载后仍存活的 loader 条目 dispose 掉（`Fiber.dispose()` 会清
 *                掉 `fiber.uid`，那恰好就是管理器检查的那个标志位）；
 *   2. update  — 把同一个包交回 `pluginManager.updateBundle()`，让管理器自己重跑
 *                remove → install → reload；
 *   3. remove  — 目标本来就是卸载时，改用 `pluginManager.removeBundle()`。
 *
 * 如果管理器仍然拒绝，调用方拿到的是管理器自己的错误码，而在它背后什么都没被改。
 */
import { randomUUID } from 'node:crypto';
import { describeEntry, inUseEntries, summarize } from './keys.js';
import { looksLikeRuntimeFailure, probeHost, probeRuntime, runtimeHint } from './runtime.js';

/**
 * 把抛出来的值描述成可 JSON 化的样子。
 * @param {unknown} error
 */
export function errorFact(error) {
  const code = typeof (/** @type {any} */ (error)?.code) === 'string' ? /** @type {any} */ (error).code : null;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

/** 这次 release 是一口回绝，而不是跑完了还留下条目。 */
function refusedRelease(released) {
  return released?.ok === false && !Array.isArray(released?.released);
}

/**
 * 给管理器调用加一个上限。宿主报成 settled 的市场操作，背后仍可能挂着一个没回音的
 * registry 查询或 pnpm 安装；没有超时的话，自动修复会一直等，用户只会看到“什么也
 * 没发生”。定时器 unref，免得一个悬着的 deadline 把 Node 吊住。
 * @param {Promise<any>} promise
 * @param {number} ms
 * @param {string} label
 */
function withDeadline(promise, ms, label) {
  if (!(ms > 0)) return promise;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} 在 ${Math.round(ms / 1000)} 秒内没有回应`);
      error.code = 'unlock-timeout';
      reject(error);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 给管理器的 registry 查询准备一个取消信号。
 *
 * `listVersions(name, options, signal)` 和 `inspect()` 都收 signal，管理器会把它
 * 一路传给 registry 客户端，所以在这里 abort 是真的把请求掐掉，而不只是丢掉它返回
 * 的 promise。`updateBundle()` 不收 signal，所以才改用 {@link withDeadline} 兜底。
 * @param {number} ms
 */
function deadlineSignal(ms) {
  if (!(ms > 0) || typeof AbortController !== 'function') return { signal: undefined, cancel() {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${Math.round(ms / 1000)} 秒后取消`)), ms);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
    },
  };
}

function safeGet(ctx, service) {
  try {
    return ctx?.get?.(service) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {{ctx: any, config: import('./config.js').UnlockConfig, state: {healing: Set<string>, inFlight: Set<string>, attempts: Map<string, number>}, log: Function, probe?: Function, hostProbe?: Function}} input
 */
export function createRepair({ ctx, config, state, log, probe = probeRuntime, hostProbe = probeHost }) {
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
   * 宿主自己那份 pnpm，查出来而不是假设。release 只能修锁；修不了一份不在磁盘上的
   * payload，而提前把这件事说出来，胜过让更新事后挂在 `MODULE_NOT_FOUND` 上。
   */
  function runtime() {
    const result = probe();
    return { ...result, ...host(), hint: runtimeHint(result) };
  }

  /** 这次修复跑在哪个 DeepSeek Harness 里（0.2.2-rc.5 及以后）。 */
  function host() {
    try {
      return hostProbe();
    } catch {
      return { dshVersion: null, manifestPath: null };
    }
  }

  /** 某个包的存活条目，已转成可写进报告的数据。 */
  function inUse(name) {
    return inUseEntries({ loader: loader(), manager: manager(), name }).map(describeEntry);
  }

  /** 原始条目，只在引擎内部用。 */
  function liveEntries(name) {
    return inUseEntries({ loader: loader(), manager: manager(), name });
  }

  /**
   * 管理器到底会不会去卸载这个包。
   *
   * 这是整个插件的安全闸。每个核心 bundle（`@deepseek-ai/dsh-base`、
   * `@deepseek-ai/dsh-web-app`）按设计就带着几十个活 fiber，安装层的 bundle 也根本
   * 不归这个 profile 管。它们的 fiber 命中自己的行是正常状态，不是卡住的更新——管理器
   * 在走到“是否在用”的检查之前，早就用 `not-removable` 把它们拒了。释放那些 fiber
   * 等于把正在跑的宿主拆掉，所以它们只被报告，永远不被修复。
   *
   * @param {any} bundle 一行 `listBundles()` 结果
   */
  function repairable(bundle) {
    if (!bundle || typeof bundle.name !== 'string') return false;
    if (bundle.removable === false) return false;
    if (bundle.official === true) return false;
    return bundle.availability === 'profile';
  }

  /** 管理器认识的所有包，按“卸载会不会被它挡住”整理。 */
  async function statuses(filter) {
    const m = manager();
    if (!m || typeof m.listBundles !== 'function') {
      return { ok: false, reason: '拿不到 pluginManager 服务', services: services() };
    }
    let listed;
    try {
      listed = await m.listBundles();
    } catch (error) {
      return { ok: false, reason: 'listBundles() 调用失败', error: errorFact(error), services: services() };
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
          // “blocked” 指的是市场会拒绝这个包——不是“它恰好加载了代码”，
          // 那是每一个装好的插件都有的状态。
          blocked: live.length > 0 && canRepair,
          repairable: canRepair,
        };
      });
    return { ok: true, bundles, services: services() };
  }

  /**
   * 一个包或全部包的状态，以及插件能对它们做什么。
   *
   * 不点名时保持摘要形态：一个真实 profile 有几十个包、几百个 fiber，把每个条目都
   * 倒出来会把答案（以及调用方的上下文）埋在 JSON 里。要看条目就按名字问。
   *
   * @param {{name?: string, includeEvents?: boolean}} [options]
   */
  async function status(options = {}) {
    const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : undefined;
    const result = await statuses(name);
    if (result.ok !== true) return { ...result, generatedAt: new Date().toISOString() };
    const blocked = result.bundles.filter((bundle) => bundle.blocked);
    const summary = (bundle) => ({
      name: bundle.name,
      version: bundle.version,
      blocked: bundle.blocked,
      repairable: bundle.repairable,
      entries: bundle.blockedBy.length,
      update: bundle.update ?? null,
    });
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
      blocked: blocked.map(summary),
      bundles: name
        ? result.bundles
        : result.bundles.filter((bundle) => bundle.blocked || bundle.installed).map(summary),
      reportFile: log?.file ?? null,
      ...(options.includeEvents === false ? {} : { events: log?.events?.slice(-config.maxLogEvents) ?? [] }),
    };
  }

  /**
   * 第 1 步——把挡住这个包的活 fiber 全部 dispose 掉。
   * 不往 profile 里写任何东西：这只是让正在跑的插件停下来。
   *
   * @param {string} [name] 包名；省略则释放所有被挡住的包。
   */
  async function release(name) {
    const m = manager();
    if (!m) return { ok: false, reason: '拿不到 pluginManager 服务', services: services() };

    const explicit = typeof name === 'string' && name.trim() ? name.trim() : null;
    if (explicit) {
      // 绝不去拆管理器本来就不会卸载的代码：核心 bundle 的 fiber 就是正在跑的宿主，
      // 不是卡住的更新。
      const listed = await statuses(explicit);
      if (listed.ok !== true) return { ok: false, bundle: explicit, reason: listed.reason, services: listed.services };
      const target = listed.bundles?.[0];
      if (!target) return { ok: false, bundle: explicit, reason: `${explicit} 不在这个 profile 的插件包里` };
      if (target.repairable !== true) {
        return {
          ok: false,
          bundle: explicit,
          blocked: target.blocked,
          reason: `${explicit} 属于${target.official ? '官方' : target.availability === 'installation' ? '安装层' : '受保护'} bundle；管理器在“是否在用”检查之前就以 not-removable 拒绝了它，所以它的条目只被报告，永不被释放`,
        };
      }
    }

    const names = explicit
      ? [explicit]
      : (await statuses()).bundles?.filter((bundle) => bundle.blocked).map((bundle) => bundle.name) ?? [];
    if (names.length === 0) return { ok: true, released: [], note: '当前没有包被存活条目挡住' };

    const released = [];
    for (const bundleName of names) {
      const before = liveEntries(bundleName);
      const steps = [];
      for (const entry of before) {
        const described = describeEntry(entry);
        try {
          if (!entry?.fiber || typeof entry.fiber.dispose !== 'function') {
            steps.push({ ...described, released: false, error: { code: 'no-fiber', message: '这个 loader 条目没有可 dispose 的 fiber' } });
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
   * 决定这次更新该瞄准哪个版本：调用方给了就用它，否则用 registry 上比已装版本更新的
   * 版本里**本宿主认可**的最新那个。
   *
   * 从 0.2.2-rc.5 起，运行中的 Harness 会拒绝的版本会被 `listVersions()` 标上
   * `incompatible`（`engines.dsh` / `peerDependencies` 对不上）。盲目取 `versions[0]`
   * 会把更新瞄向一个管理器随后以 `incompatible-version` 拒掉的版本，在用户看来就像
   * 锁还在。跳过这些并说明跳过了谁，才能把两种失败分开。
   */
  async function resolveVersion(m, name, requested) {
    if (typeof requested === 'string' && requested.trim()) return { version: requested.trim(), source: 'request' };
    if (typeof m.listVersions !== 'function') return { refusal: { status: 'refused', problem: 'no-list-versions', reason: '这个插件管理器不提供版本列表' } };
    const control = deadlineSignal(config.deadlineMs);
    let listing;
    try {
      listing = await withDeadline(m.listVersions(name, {}, control.signal), config.deadlineMs, 'listVersions()');
    } catch (error) {
      return { refusal: { status: 'refused', problem: 'list-versions-failed', reason: errorFact(error) } };
    } finally {
      control.cancel();
    }
    if (listing?.status === 'listed' && Array.isArray(listing.versions)) {
      const entries = listing.versions.filter((item) => item && typeof item.version === 'string');
      const skipped = entries
        .filter((item) => item.incompatible !== undefined && item.incompatible !== null)
        .map((item) => ({ version: item.version, incompatibility: item.incompatible }));
      const usable = entries.filter((item) => item.incompatible === undefined || item.incompatible === null);
      const meta = {
        installed: listing.installed ?? null,
        registry: listing.registry ?? null,
        newer: entries.length,
        omitted: listing.omitted ?? 0,
      };
      if (usable.length > 0) {
        return { version: usable[0].version, source: 'registry', listing: meta, skipped };
      }
      if (entries.length > 0) {
        const dshVersion = host().dshVersion;
        return {
          refusal: {
            status: 'refused',
            problem: 'incompatible-version',
            reason: `${name} 所有更新的版本都被这个 DeepSeek Harness 拒绝${dshVersion ? `（${dshVersion}）` : ''}：${skipped.map((item) => item.version).join(', ')}`,
            incompatible: skipped,
          },
          skipped,
        };
      }
      return { refusal: { status: 'refused', problem: 'no-newer-version', reason: `${name} 没有比已装版本更新的版本`, listing: meta }, skipped };
    }
    return { refusal: listing ?? { status: 'refused', problem: 'unknown', reason: '没有版本列表' } };
  }

  /**
   * 第 2 步——已经没人挡着了，交给管理器自己更新。
   * `updateBundle` 会 remove、install、reload；它自己失败时会把卸掉的版本装回去，
   * 所以一次失败的尝试不会把 profile 弄成别的样子。
   */
  async function runUpdate(name, requestedVersion) {
    const m = manager();
    if (!m || typeof m.updateBundle !== 'function') {
      return { ok: false, step: 'update', bundle: name, reason: 'pluginManager 服务没有暴露 updateBundle()' };
    }
    const target = await resolveVersion(m, name, requestedVersion);
    if (!target.version) {
      const timedOut = target.refusal?.reason?.code === 'unlock-timeout';
      if (timedOut) log('update-timeout', { bundle: name, step: 'list-versions', message: target.refusal.reason.message });
      if (target.refusal?.problem === 'incompatible-version') {
        log('update-incompatible', { bundle: name, versions: (target.refusal.incompatible ?? []).map((item) => item.version) });
        return {
          ok: false,
          step: 'compatible-version',
          bundle: name,
          reason: target.refusal.reason,
          incompatible: target.refusal.incompatible ?? [],
          needsCompatibleVersion: true,
          released: true,
          refusal: target.refusal,
        };
      }
      return {
        ok: false,
        step: 'list-versions',
        bundle: name,
        reason: timedOut
          ? '版本列表没有及时回应；锁已经释放，现在可以在市场里重试这次更新'
          : '没能确定更新的目标版本，因此只做了释放',
        timedOut,
        retryInMarket: true,
        refusal: target.refusal,
      };
    }
    // 0.2.2-rc.5 在更新过程中会流式广播 `plugin-manager/update-state`
    // { requestId, step }；市场自己发起这些请求，而一次自我修复也带上自己的 id，
    // 就能出现在同一个进度界面上，而不是变成一片没有解释的沉默。
    const requestId = randomUUID();
    try {
      const result = await withDeadline(m.updateBundle(name, target.version, { requestId }), config.deadlineMs, 'updateBundle()');
      const failed = result?.result?.application === 'failed' || Boolean(result?.result?.error);
      const code = result?.result?.error?.code ?? null;
      log('update', { bundle: name, to: target.version, ok: !failed, code, requestId });
      if (code === 'incompatible-version') {
        return {
          ok: false,
          step: 'compatible-version',
          bundle: name,
          from: result?.from ?? null,
          to: target.version,
          versionSource: target.source,
          reason: `${target.version} 被这个 DeepSeek Harness 判为不兼容并拒绝`,
          incompatible: result?.result?.error?.incompatible ?? [],
          needsCompatibleVersion: true,
          requestId,
          result,
        };
      }
      return {
        ok: !failed,
        step: 'update',
        bundle: name,
        from: result?.from ?? null,
        to: target.version,
        versionSource: target.source,
        ...(target.skipped?.length ? { skippedIncompatible: target.skipped } : {}),
        requestId,
        result,
      };
    } catch (error) {
      const fact = errorFact(error);
      log('update-failed', { bundle: name, code: fact.code, message: fact.message });
      if (fact.code === 'unlock-timeout') {
        return { ok: false, step: 'update', bundle: name, to: target.version, error: fact, timedOut: true };
      }
      if (looksLikeRuntimeFailure(error)) {
        return { ok: false, step: 'runtime', bundle: name, to: target.version, error: fact, runtime: runtime(), needsRuntimeRepair: true };
      }
      return { ok: false, step: 'update', bundle: name, to: target.version, error: fact };
    }
  }

  /**
   * 先释放，再把包交还给管理器更新。
   * @param {string} name
   * @param {{version?: string, update?: boolean}} [options]
   */
  async function update(name, options = {}) {
    const bundleName = typeof name === 'string' ? name.trim() : '';
    if (!bundleName) return { ok: false, reason: '必须给一个包名' };
    const released = await release(bundleName);
    if (refusedRelease(released)) {
      return { ok: false, step: 'release', bundle: bundleName, reason: released.reason, release: released };
    }
    if (released.released?.[0] && released.released[0].ok !== true) {
      return { ok: false, step: 'release', bundle: bundleName, reason: '释放之后仍有存活条目，所以没有继续更新', release: released };
    }
    const environment = runtime();
    if (environment.ok !== true) {
      return {
        ok: false,
        step: 'runtime',
        bundle: bundleName,
        reason: '锁已经清掉了，但宿主跑不了 pnpm：它的运行时 payload 不见了',
        runtime: environment,
        needsRuntimeRepair: true,
        released: summarizeRelease(released),
      };
    }
    return { ...(await runUpdate(bundleName, options.version)), released: summarizeRelease(released) };
  }

  /**
   * 先释放，再让管理器把这个包卸掉。
   * @param {string} name
   */
  async function remove(name) {
    const bundleName = typeof name === 'string' ? name.trim() : '';
    if (!bundleName) return { ok: false, reason: '必须给一个包名' };
    const m = manager();
    if (!m || typeof m.removeBundle !== 'function') {
      return { ok: false, reason: 'pluginManager 服务没有暴露 removeBundle()' };
    }
    const released = await release(bundleName);
    if (refusedRelease(released)) {
      return { ok: false, step: 'release', bundle: bundleName, reason: released.reason, release: released };
    }
    if (released.released?.[0] && released.released[0].ok !== true) {
      return { ok: false, step: 'release', bundle: bundleName, reason: '释放之后仍有存活条目，所以没有继续卸载', release: released };
    }
    const environment = runtime();
    if (environment.ok !== true) {
      return {
        ok: false,
        step: 'runtime',
        bundle: bundleName,
        reason: '锁已经清掉了，但宿主跑不了 pnpm：它的运行时 payload 不见了',
        runtime: environment,
        needsRuntimeRepair: true,
        released: summarizeRelease(released),
      };
    }
    try {
      const result = await withDeadline(m.removeBundle(bundleName), config.deadlineMs, 'removeBundle()');
      const failed = Boolean(result?.error) || result?.application === 'failed';
      log('remove', { bundle: bundleName, ok: !failed, code: result?.error?.code ?? null });
      return { ok: !failed, step: 'remove', bundle: bundleName, result, released: summarizeRelease(released) };
    } catch (error) {
      const fact = errorFact(error);
      log('remove-failed', { bundle: bundleName, code: fact.code, message: fact.message });
      if (fact.code === 'unlock-timeout') {
        return { ok: false, step: 'remove', bundle: bundleName, error: fact, timedOut: true, released: summarizeRelease(released) };
      }
      if (looksLikeRuntimeFailure(error)) {
        return { ok: false, step: 'runtime', bundle: bundleName, error: fact, runtime: runtime(), needsRuntimeRepair: true, released: summarizeRelease(released) };
      }
      return { ok: false, step: 'remove', bundle: bundleName, error: fact };
    }
  }

  /**
   * 卡住的人真正需要的那一个调用：先清掉阻塞，然后（除非调用方只要释放）把活干完。
   * @param {string} name
   * @param {{version?: string, update?: boolean}} [options]
   */
  async function heal(name, options = {}) {
    const bundleName = typeof name === 'string' ? name.trim() : '';
    if (!bundleName) return { ok: false, reason: '必须给一个包名' };
    if (state.inFlight.has(bundleName)) {
      return { ok: false, busy: true, bundle: bundleName, reason: '这个包的修复已经在跑了' };
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
          reason: '释放之后仍有存活条目；重启 DSH 即可收尾',
          release: released,
          needsRestart: true,
        };
      }
      const shouldUpdate = options.update === true || (options.update !== false && config.autoUpdate);
      if (!shouldUpdate) {
        log('heal-released', { bundle: bundleName });
        return { ok: true, step: 'release', bundle: bundleName, released: summarizeRelease(released), note: '只做了释放；请到市场里重试更新，或传 update: true' };
      }
      const updated = await runUpdate(bundleName, options.version);
      log(updated.ok ? 'heal' : 'heal-failed', { bundle: bundleName, step: updated.step, code: updated.error?.code ?? updated.result?.result?.error?.code ?? null });
      return { ...updated, released: summarizeRelease(released) };
    } finally {
      state.inFlight.delete(bundleName);
    }
  }

  /**
   * 在**当前这个 tick** 里把某个包的活 fiber dispose 掉——抢先路径。
   *
   * `reportOperation()` 广播 `plugin-manager/operation` 时不 await 监听器，所以一次
   * 先 await 了 `listBundles()` 的释放会让管理器自己的 `deselect → reload → 检查是否
   * 在用` 抢先跑完。`Fiber.dispose()` 的第一条语句就是清 `uid`，在任何 await 之前，
   * 因此只要同步地**调用**它就足以让管理器的检查通过；留着的 promise 只用于事后汇报
   * 收尾是否完成。
   *
   * 这里不做任何判断：调用方只有在管理器已经接受了一次 `remove`（它的 `not-removable`
   * 和 `stop-profile` 拒绝都在操作开始之前抛出）之后才会走到这里。
   *
   * @param {string} name
   */
  function releaseFast(name) {
    const entries = liveEntries(name);
    const startedAt = Date.now();
    const disposing = entries.map((entry) => {
      try {
        const result = entry?.fiber?.dispose?.();
        return result && typeof result.then === 'function' ? result : Promise.resolve(result);
      } catch (error) {
        return Promise.reject(error);
      }
    });
    return {
      bundle: name,
      entries: entries.map(describeEntry),
      started: entries.length,
      settled: Promise.allSettled(disposing).then((results) => ({
        ms: Date.now() - startedAt,
        failed: results.filter((item) => item.status === 'rejected').length,
        remaining: liveEntries(name).length,
      })),
    };
  }

  /** 这个包的自动修复是否还在冷却窗口内。 */
  function inCooldown(name) {
    const last = state.attempts.get(name);
    return typeof last === 'number' && Date.now() - last < config.cooldownMs;
  }

  return { services, inUse, status, release, releaseFast, update, remove, heal, inCooldown, liveEntries, runUpdate, runtime };
}

function summarizeRelease(released) {
  const items = Array.isArray(released?.released) ? released.released : [];
  return items.map((item) => ({ bundle: item.bundle, ok: item.ok, released: item.steps.filter((step) => step.released).length, remaining: item.remaining.length }));
}
