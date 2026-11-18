/**
 * 宿主真正用来装插件、卸插件的那套包管理器。
 *
 * 释放一个卡住的 fiber 只是一半，另一半是宿主自己的 `pnpm remove` / `pnpm add`；
 * 桌面端跑的是它随应用一起发出的那份 runtime payload：
 *
 *   <resources>/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs
 *
 * 宿主在 spawn pnpm 之前会把该根目录导出成 `DSH_PRIMARY_RUNTIME`，所以这里可以用
 * 同一套路径规则解析并检查它。一旦这份 payload 不见了（更新被打断、清理工具把
 * `resources/runtime` 掏空、安装包被复制或解压不全），锁清掉之后每一步插件操作仍会
 * 失败，报的是这个文件的 `MODULE_NOT_FOUND`——看起来像插件坏了，其实不是。
 * 把这件事说清楚，就是这个模块存在的理由：`bundle-in-use` 和 `pnpm.mjs 不见了`
 * 是两个不同的问题，只有前一个是锁。
 *
 * 这里不写文件、不 spawn 进程、不装任何东西，只 stat 两条路径、读一个清单。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** payload 里的入口文件，路径与桌面端拼出来的一致。 */
export const PNPM_ENTRY = ['dependencies', 'pnpm', 'bin', 'pnpm.mjs'];

/** 能证明整套 payload（node、python、pnpm）装好了的清单。 */
export const RUNTIME_MANIFEST = 'runtime.json';

function isFile(path) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * payload 可能出现的每个位置，可信度高的在前。
 * @param {{env?: Record<string, string | undefined>, execPath?: string}} [options]
 */
export function runtimeRoots(options = {}) {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const roots = [];
  const fromEnv = typeof env?.DSH_PRIMARY_RUNTIME === 'string' ? env.DSH_PRIMARY_RUNTIME.trim() : '';
  if (fromEnv) roots.push({ root: fromEnv, source: 'DSH_PRIMARY_RUNTIME' });
  if (typeof execPath === 'string' && execPath !== '') {
    // <install>/DeepSeek Harness.exe → <install>/resources/runtime/primary-runtime
    roots.push({ root: join(dirname(execPath), 'resources', 'runtime', 'primary-runtime'), source: 'execPath' });
  }
  return roots;
}

/**
 * 解析并 stat 宿主会跑的那个包管理器。
 * 只有宿主 spawn 的那个文件真的存在，`ok` 才为 true。
 * @param {{env?: Record<string, string | undefined>, execPath?: string}} [options]
 */
export function probeRuntime(options = {}) {
  const candidates = runtimeRoots(options).map(({ root, source }) => {
    const pnpmPath = join(root, ...PNPM_ENTRY);
    return {
      source,
      root,
      pnpmPath,
      present: isFile(pnpmPath),
      runtimeJson: isFile(join(root, RUNTIME_MANIFEST)),
    };
  });
  // 真的存在的那份，优先于一个指向空目录的环境变量。
  const found = candidates.find((candidate) => candidate.present) ?? candidates[0] ?? null;
  return {
    ok: found?.present === true,
    source: found?.source ?? 'none',
    root: found?.root ?? null,
    pnpmPath: found?.pnpmPath ?? null,
    runtimeJson: found?.runtimeJson === true,
    candidates: candidates.map(({ source, pnpmPath, present, runtimeJson }) => ({ source, pnpmPath, present, runtimeJson })),
  };
}

/**
 * 当前运行的 DeepSeek Harness 版本，从应用清单里读。
 *
 * 从 0.2.2-rc.5 起，目标包的 `engines.dsh` / `peerDependencies` 不接受本宿主时，
 * 管理器会以 `incompatible-version` 拒绝安装或更新，`listVersions()` 会给每个这样
 * 的版本打上 `incompatible`。把这个运行时版本和那个判断并排报出来，用户才能分清
 * “插件坏了”和“这个版本比我的 Harness 老”。只读；找不到清单时返回 null。
 *
 * @param {{execPath?: string, readFile?: (path: string) => string}} [options]
 */
export function probeHost(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  if (typeof execPath !== 'string' || execPath === '') return { dshVersion: null, manifestPath: null };
  // <install>/DeepSeek Harness.exe → <install>/resources/app/dsh/package.json
  const manifestPath = join(dirname(execPath), 'resources', 'app', 'dsh', 'package.json');
  try {
    const manifest = JSON.parse(readFile(manifestPath));
    const version = typeof manifest?.version === 'string' ? manifest.version : null;
    return { dshVersion: version, manifestPath };
  } catch {
    return { dshVersion: null, manifestPath };
  }
}

/** payload 缺失时该对用户说的话；一切正常时返回 null。 */
export function runtimeHint(probe) {
  if (probe?.ok === true) return null;
  const where = probe?.pnpmPath ?? '<resources>/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs';
  return `桌面端缺少它用来跑 pnpm 的运行时 payload（${where}）。它不在的时候，解锁没有任何意义：请修复或重装 DeepSeek Harness，让 resources/runtime/primary-runtime 恢复，然后再试。`;
}

const RUNTIME_CODES = /ERR_PNPM_UNEXPECTED_STORE|ERR_PNPM_NO_STORE|ERR_PNPM_META_FETCH_FAIL|MODULE_NOT_FOUND|ENOENT/;

/**
 * 判断抛出来的错误是 payload 在说话，还是锁。
 * 刻意收得很窄：找不到「某个包」同样会抛 ENOENT，所以报错里必须提到 payload 路径
 * 或包管理器本身才算。
 * @param {unknown} error
 */
export function looksLikeRuntimeFailure(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message === '') return false;
  if (/pnpm\.mjs|primary-runtime/i.test(message)) return true;
  return RUNTIME_CODES.test(message) && /pnpm|runtime|DSH_PRIMARY_RUNTIME/i.test(message);
}
