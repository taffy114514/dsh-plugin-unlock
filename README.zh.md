# dsh-plugin-unlock

**专治 DSH 桌面端的「这个插件正在使用中，桌面端不允许现在移除」，并把市场放弃的那次更新做完。**

DSH 桌面端插件市场更新或卸载插件时，`@deepseek-ai/dsh-plugin-manager` 会先卸载插件，再检查这个插件的 loader 条目里是否还有活着的 fiber。只要有一条还活着（热更新没能真正把它停下），操作就以 `bundle-in-use` 失败——不更新、不卸载、也不告诉你到底卡在哪。

`dsh-plugin-unlock` 就是把这些 fiber 释放掉，再把 bundle 交回给插件管理器，让市场原本的更新流程正常跑完：pnpm remove → install → reload，profile 的 `package.json`、lockfile 和 `dsh.profile.bundles` 全部仍由管理器自己写。

---

## 到底卡在哪

拒绝来自 `dsh-plugin-manager/lib/index.js`：

```js
if ([...this.ctx.loader.entries()].some((entry) =>
      entry.fiber?.uid != null &&
      contributions.some((row) => row.id === entry.options.id && row.name === entry.options.name)))
  throw new ManagementFailure("bundle-in-use");
```

`entry.fiber.uid` 就是"是否还活着"的标志：加载中的 fiber 持有 uid，`Fiber.dispose()` 会把它设成 `null`。所以"这个插件正在使用中"问的其实是"热卸载到底有没有把它停掉"。

在桌面端，答案经常是**没有**——插件如果持有长生命周期的东西（定时器、socket、子进程、Web 路由、消息循环），fiber 就会存活下来，管理器则拒绝在插件还在跑的时候把包从磁盘上抽走。

这种状态下没有任何文件是坏的，坏的只是运行中的组合。所以"重启应用再试一次"往往就好了，而市场本身没法就地修。

## 它做了什么

1. **找出**挡路的条目：用管理器自己的判据——`pluginManager.bundleRows(name)` 拿到它要比对的 (id, name) 对，再匹配当前存活的 loader 条目。
2. **释放**：逐条 `await entry.fiber.dispose()`，清掉 `fiber.uid` 并跑插件的 teardown。
3. **把活干完**：此时 `pluginManager.updateBundle(name, version)`（或 `removeBundle(name)`）自己的闸门就能过，真正的卸载、安装、重载由管理器完成。
4. **自证**：释放后重新跑一遍判据，把剩下的条目如实报出来，不会给你一个假的 "done"。

它不改 `package.json`、不绕过管理器跑 pnpm、也不把 profile 推到管理器不会写出的状态。

## 安装

**从 DSH 插件市场**：搜索 `dsh-plugin-unlock` 安装即可。

**从 GitHub**

```bash
dsh plugin install github:YG/dsh-plugin-unlock
```

**手动装进某个 profile**

```bash
cd ~/.dsh/profiles/desktop
pnpm add github:YG/dsh-plugin-unlock
```

然后把 `dsh-plugin-unlock` 加进该 `package.json` 的 `dsh.profile.bundles`（用市场装的话这两步它自己会做）。重启一次 DSH，让插件本身加载起来。

无任何依赖，要求 Node ≥ 22（DSH 本身就需要）。

## 用法

### 自动（默认）

市场更新/卸载失败时，管理器会把这次失败报到 `plugin-manager/operation` 事件上。插件接到 `bundle-in-use` 就释放 fiber，再让管理器重跑更新——你看到的是更新成功，而不是那句拒绝。

护栏：同一个 bundle 10 分钟内只自动修一次；同一次操作不重复；自己正在修的 bundle 不重入；失败操作先等 500 ms，让文件锁释放完。

### 它故意永远不动的东西

Host 本体。`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 和其它官方/安装自带 bundle 天生就有几十个常驻 fiber——那是跑着的应用，不是卡住的更新。管理器对它们给的是 `not-removable`，远早于"占用"检查，所以它们的条目只在 `blockedBy` 里被报告、永不被释放。只有这个 profile 自己装的 bundle（`availability: "profile"`、`removable: true`）才会被处理；按名字指名一个核心 bundle 时，`release` 会直接回绝，而不是把 Host 拆掉。

### `plugin_unlock` 工具

| action | 作用 |
| --- | --- |
| `status` | 每个已装 bundle 的一行摘要：有没有被挡、被几个条目挡住；给 `name` 才展开那些条目 |
| `in_use` | 只列被挡的 |
| `runtime` | Host 跑安装用的那份 pnpm 到底在不在盘上 |
| `release` | 释放挡路条目（停掉插件，不动任何文件） |
| `update` | 释放后交给管理器更新到最新（或指定）版本 |
| `remove` | 释放后交给管理器卸载 |
| `heal` | 释放后把待办的更新做完（`update: false` 则只释放） |

```jsonc
{ "action": "heal", "name": "dsh-caveman" }
```

### HTTP（不想通过助手时）

路由挂在 Host 自己的 web server 上，走它原有的请求鉴权：认的是 GUI 自己发的那枚签名浏览器 cookie，没有它就返回 `401 {"ok":false,"error":"unauthorized"}`。从浏览器 DevTools 里（Application → Cookies）把 cookie 复制出来塞进 `-b`，或者干脆用工具、跳过这一节。

```bash
# GUI 手里已有的那枚 cookie
COOKIE='dsh-…=<value>'

# 现在有什么被挡住了？
curl -s -b "$COOKIE" http://127.0.0.1:64511/dsh-plugin-unlock/status

# 释放并把更新做完
curl -s -b "$COOKIE" -X POST http://127.0.0.1:64511/dsh-plugin-unlock/heal \
     -H 'content-type: application/json' \
     -d '{"name":"dsh-caveman"}'

# 把所有被挡的都修一遍
curl -s -b "$COOKIE" -X POST http://127.0.0.1:64511/dsh-plugin-unlock/heal-all
```

| 路由 | 方法 |
| --- | --- |
| `/dsh-plugin-unlock/` | GET —— 接口自述 |
| `/dsh-plugin-unlock/status[?name=…]` | GET |
| `/dsh-plugin-unlock/in-use[?name=…]` | GET |
| `/dsh-plugin-unlock/runtime` | GET——Host 从哪个 pnpm 跑，那份载荷在不在 |
| `/dsh-plugin-unlock/release` | POST `{name?}` |
| `/dsh-plugin-unlock/update` | POST `{name, version?}` |
| `/dsh-plugin-unlock/remove` | POST `{name}` |
| `/dsh-plugin-unlock/heal` | POST `{name, version?, update?}` |
| `/dsh-plugin-unlock/heal-all` | POST `{update?}` |

## 配置

在 bundle 的 patch 行里（`cordis.patch.yml`），或在前端提供的插件设置里：

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `autoFix` | `true` | 自动修复 `bundle-in-use` 失败 |
| `autoUpdate` | `true` | 释放后是否顺带把更新做完 |
| `cooldownMs` | `600000` | 同一 bundle 两次自动修复的最小间隔 |
| `route` | `/dsh-plugin-unlock` | HTTP 前缀 |
| `log` | `true` | 是否把修复过程写进报告文件 |
| `maxLogEvents` | `50` | 内存里保留多少条事件给 status |

```yaml
- insert:
    - id: dsh-plugin-unlock
      name: dsh-plugin-unlock
      config:
        autoFix: true
        autoUpdate: true
        cooldownMs: 600000
        route: /dsh-plugin-unlock
        log: true
```

每次修复都会追加到 `~/.dsh/plugins-data/dsh-plugin-unlock/report.jsonl`——真出问题时，那份文件会写清是哪个 bundle、哪一步、管理器的哪个错误码。

## 它修不了的情况

- **管理器报 `not-removable`**：这是 profile 自身或受保护的 bundle，不会替它释放任何东西。
- **管理器报 `stop-profile`**：Host 没有 HMR，不支持热卸载，只能重启 DSH。
- **某个 fiber 拒绝 dispose**（teardown 抛错）：插件返回 `needsRestart`，不动 profile。重启 DSH 后再重试更新。
- **bundle 来自固定 Git commit**：没有"更新到哪个版本"可言；插件只解除阻塞，然后告诉你回市场重试——那时它会按新的 spec 卸载重装。
- **运行时载荷缺失**：这是另一个缺陷，症状却很像。桌面端所有安装/卸载都走它自带的 pnpm：`resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`。这个文件没了（更新中断、目录被清理、安装被复制得只剩一半），操作就会在**解除锁之后**失败，报 `MODULE_NOT_FOUND … pnpm.mjs` 或 `ERR_PNPM_UNEXPECTED_STORE`。释放 fiber 变不出一个文件来，所以插件会先查这件事、不假装能修，返回 `step: "runtime"`、`needsRuntimeRepair: true` 和它查的确切路径。修复或重装 DeepSeek Harness 后再重试；`action: "runtime"`（或 `GET /dsh-plugin-unlock/runtime`）能直接告诉你是哪一种问题。

## 开发

```bash
node --test          # 83 个单元测试，零依赖
```

`lib/runtime.js` 处理另一半问题：Host 到底用哪份 pnpm、它该在哪、在不在。`lib/keys.js` 里放着这个插件唯一的核心知识——管理器自己那套"是否在使用中"的判据——写成纯函数，所以匹配规则不需要 Host 就能测。其余都是对注入服务的 I/O。

## 许可

MIT

## 0.1.4：先释放，再让管理器检查

0.1.3 之前只有在市场报错之后才补救。0.1.4 改成抢先一步：

- 管理器每次操作都会在 `plugin-manager/operation` 上广播 `phase: "started"`。只要阶段是 `remove` 或 `update`，插件立刻释放该 bundle 残留的 fiber——赶在管理器 `deselect → reload → 检查 fiber.uid` 之前。检查一次通过，pnpm 正常执行，市场根本不会弹出"这个插件正在使用中"。
- 万一某次仍然以 `errorCode: "bundle-in-use"` 失败（老版本 Host、竞态、被别的插件重新挂载），插件再按原来的路径补救：释放后自己接管 `updateBundle()`。
- 0.1.3 又踩了一个冷启动的坑：`tools` / `webServer` 可能比本插件晚挂载，一次性 `ctx.get()` 会静默注册空效果，插件"加载了但看不见"。0.1.4 改用 `ctx.inject(['tools'])` / `ctx.inject(['webServer'])`，等服务就绪再注册。
- 每个管理器调用都有 `deadlineMs`（默认 180 秒）兜底：注册表拉取或 pnpm 安装卡住时返回超时，而不是永远等下去。
- 自动修复永远不会碰本插件自己的 fiber，也不会碰 `@deepseek-ai/dsh-base` 这类核心 bundle。

## 0.2.0 / 0.2.1：适配 DeepSeek Harness 0.2.2-rc.5

判据本身没变（还是 `bundle-in-use` 看 `fiber.uid`，还是 `Fiber.dispose()` 清零），变的是它周围的三件事：

- **多了一种失败方式：`incompatible-version`。** 目标版本的 `engines.dsh` / `peerDependencies` 不接受当前 Harness 时，管理器直接拒绝；`listVersions()` 会给这些版本打上 `incompatible`。所以插件不再盲取 `versions[0]`：它挑当前 Harness 接受的最新版本，把跳过的版本列在 `skippedIncompatible` 里；当**所有**更新的版本都不兼容时，它照样解除锁，但一个包都不装，返回 `step: "compatible-version"` 和 `needsCompatibleVersion: true`，不会让你误以为锁还在。
- **注册表查询支持 `AbortSignal`。** `deadlineMs`（默认 180 秒）现在是真正的取消，而不只是丢弃一个 promise；`updateBundle()` 不接受 signal，仍由超时兜底。
- **抢先释放改成了同步的。** `reportOperation()` 广播 `plugin-manager/operation` 时**不等监听器返回**，所以先 `await listBundles()` 再去 dispose 有可能输给管理器自己的 `deselect → reload → 检查 fiber.uid`。现在 preventative 路径在收到事件的同一个 tick 里就调 `fiber.dispose()`（`dispose()` 在第一个 `await` 之前就把 `fiber.uid` 清空），之后才 await teardown 汇报结果——检查到它的时候锁早没了。
- **更新带 `requestId`。** 插件发起的每次更新都有自己的 id，会像市场更新一样出现在 Host 的 `plugin-manager/update-state` 进度流里，结果里也会返回这个 id，方便对上管理器的日志。

`status` 的 `runtime` 里现在还多了 `dshVersion`（从 `<安装目录>/resources/app/dsh/package.json` 读），和 pnpm 载荷状态并排显示——"版本比 Harness 还老"这件事直接写在答案里。

清单里**故意不写** `engines.dsh`：写 `>=0.2.2-rc.5` 今天好看，但 semver 的预发布只满足同 `major.minor.patch` 的比较器，下一个 `0.2.3-rc.1` 会把本插件判成不兼容直接跳过——那正是它要防的事。
