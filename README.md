# dsh-plugin-unlock

**清掉 DSH 桌面端那句「这个插件正在使用中，桌面端不允许现在移除」，并把市场放弃的那次更新做完。**

在 DSH 桌面端的插件市场里更新或卸载一个插件时，`@deepseek-ai/dsh-plugin-manager` 会先把插件卸下来，然后检查它的 loader 条目里还有没有活着的 fiber。只要还有一个——热卸载没能把插件完全停掉时就是这样——操作就以 `bundle-in-use` 失败，什么也不会发生：不更新、不卸载、也没有更多错误细节。

`dsh-plugin-unlock` 释放的正是这些 fiber，然后把包交还给管理器，让市场自己的更新流程继续跑：pnpm remove → install → reload，而 profile 的 `package.json`、lockfile 和 `dsh.profile.bundles` 完全保持管理器亲手写下的样子。

---

## 原理：为什么会出现「这个插件正在使用中」

这一节是整个项目的知识核心。看懂它，剩下的代码都只是搬运。

### 1. 插件不是文件，是「组合里的一个条目」

DSH 启动时会读 profile 的 `dsh.profile.bundles`，把每个 bundle 的 `cordis.patch.yml` 展开成若干「条目」（entry），再交给 cordis 的插件加载器真正挂载。一个插件在跑，在运行时里就表现为**一个活着（live）的条目**。

每个条目背后有一个 `Fiber`。判断「活着」的标志位很朴素：

```js
entry.fiber.uid != null   // 有 uid → 还活着
```

而 `Fiber.dispose()` 的**第一条语句**（`@deepseek-ai/cordis/lib/index.js` 里 dispose 的收尾函数）就是：

```js
this.uid = null;          // 立刻失效
```

后面才是逐层卸载、等待各插件自己的回收函数。也就是说：**「停掉一个插件」在网络/IO 意义上可能是异步的，但在「它是否还占着这个 uid」这个意义上，是调用即生效的。** 这就是本插件全部技巧的物理基础。

### 2. 管理器为什么拒绝

`PluginManager#removeBundle` 的顺序是：先把这个 bundle 从组合里摘掉（deselect），重载组合，然后问一句「还有活着的条目属于它吗」：

```js
if ([...this.ctx.loader.entries()].some((entry) =>
      entry.fiber?.uid != null &&
      contributions.some((row) => row.id === entry.options.id && row.name === entry.options.name)))
  throw new ManagementFailure("bundle-in-use");
```

`contributions` 是管理器自己从该 bundle 的 patch 行算出来的 `(id, name)` 列表——所以它比的是**管理器认为这个包应该贡献哪些条目**，而不是谁在文件系统里留了东西。

桌面端（`withHmr`）下，市场的更新走的是「先卸载、再安装」：`updateBundle()` 内部直接 `removeBundle()`。于是那句拒绝在**卸载那一步**就抛出来了，用户看到的「更新失败」其实是「卸不掉」。

### 3. 为什么错误是「这个插件正在使用中」，而不是「某个定时器没清」

因为管理器**不允许**自己在插件还在跑的代码下面把包抽走——那会留下半加载的插件。它宁可整体拒绝，也不做局部清理。于是状态变成：

- 文件没错：`node_modules` 里那份代码完好；
- 组合没错：`dsh.profile.bundles` 也没问题；
- **只有当前这份运行中的组合是「脏」的**：上一次热卸载留下了活条目。

这解释了两件用户早就观察到的事：为什么「重启一下就好了」（重启会从磁盘重新组合，所有 uid 都是新的），以及为什么市场里点什么按钮都修不好（它在同一个脏组合上重试）。

### 4. 本插件怎么修：把 uid 清掉，剩下的交给管理器

既然拒绝的唯一依据是 `entry.fiber?.uid != null`，那就把它清掉：

```
找出挡路的条目（用管理器自己的判据）→ 逐个 fiber.dispose() → 再把动作交还给管理器
```

`dispose()` 之后，管理器那句 `some(...)` 就是 `false`，它自己的 remove/install/reload 全部照常执行。**我们从不替它跑 pnpm、从不改 `package.json`、从不自己写 lockfile**——记账权始终在管理器手里，所以修完之后 profile 的状态和市场自己更新成功时一模一样。

### 5. 为什么必须「同一个 tick」内释放（0.2.1 的关键修正）

管理器的广播是不等人：

```js
this.ownerContext.parallel("plugin-manager/operation", operation)   // 不 await
```

它在 `phase: "started"` 时就广播，然后**立刻继续**往下走去 deselect、reload、检查 uid。所以监听器里只要先 `await` 了任何东西（比如为了安全先 `await listBundles()` 确认这个包可不可以动），检查就已经跑完了——修得太晚，等于没修。

正确做法是利用第 1 节那条性质：**同步调用 `fiber.dispose()`**。它的第一条语句就清 uid，所以在同一个 tick 里返回时，锁已经没了；返回的 promise 只用来事后汇报「回收干净了没有」。

这就是为什么插件有两条路径：

- **抢先路径（默认，`phase: "started"`）**：同步释放，管理器的检查第一次就通过，市场**根本不会显示那句拒绝**；
- **兜底路径（`phase: "settled"` + `failed` + `errorCode: "bundle-in-use"`）**：给老版本宿主、竞态、或别的什么东西又把包加载回来的情况兜底——释放完再替用户把更新做完。

### 6. 第二个故障：pnpm 的运行时 payload 不见了

锁清掉之后，管理器要用**它自己那份 pnpm** 去装包：

```
<安装目录>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs
```

宿主把该根目录导出为 `DSH_PRIMARY_RUNTIME`，再 spawn 这个文件。如果它不在（更新被打断、安装包被复制/解压不全、清理工具掏空了 `resources/runtime`），**每一步插件操作都会失败**，报 `MODULE_NOT_FOUND ... pnpm.mjs` 或 `ERR_PNPM_UNEXPECTED_STORE`。

这看起来和「插件正在使用中」是同一个病，其实完全无关：锁早就清干净了，缺的是一个文件。所以插件会在动手之前先 stat 这条路径，用 `step: "runtime"` + `needsRuntimeRepair: true` 把话说清楚，而不是让用户继续怀疑锁。`action: "runtime"`（或 `GET /dsh-plugin-unlock/runtime`）就是专门看这个的。

### 7. Harness 0.2.2-rc.5 起多出来的第三种失败：版本不兼容

新版本管理器在目标包的 `engines.dsh` / `peerDependencies` 不接受当前 Harness 时，会抛 `ManagementFailure("incompatible-version", ...)`；`listVersions()` 会给每个这样的版本打上 `incompatible`。如果盲目取「最新版本」，更新就会撞上它，而用户看到的还是一条失败。

所以挑版本时先过滤掉本宿主会拒绝的那些，装最新的**可用**版本，并把跳过的版本写进 `skippedIncompatible`；如果更新的版本**全都**被拒绝，就明确回答 `step: "compatible-version"`（+ `needsCompatibleVersion: true`），锁照旧释放，但绝不说成「锁没释放」。

### 8. 安全边界：核心包永远不动

`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 这些官方/安装层 bundle **按设计**就带着几十个活 fiber——那就是正在运行的宿主本身。管理器在走到「是否在用」检查之前早就用 `not-removable` 把它们拒了，所以它们的条目只被报告（`blockedBy`），永远不被 dispose。

只有这个 profile 自己装的包（`availability: "profile"`、`removable: true`）才会被动手；显式点名的核心包会直接被拒绝，而不是把宿主拆掉。

---

## 它具体做了哪几步

0. **抢先**：管理器广播 `phase: "started"` 的 `remove`/`update` 操作时，在同一 tick 内释放该包的 fiber，让即将到来的检查直接通过。
1. **找出**挡路的条目：用管理器的判据（`pluginManager.bundleRows(name)` 给出的 `(id, name)` 对，再匹配存活的 loader 条目）。
2. **释放**：逐个 `fiber.dispose()`，清掉 `fiber.uid` 并执行插件自己的回收。
3. **做完**：把包交回 `pluginManager.updateBundle()` / `removeBundle()`，由它自己 remove → install → reload。
4. **自证**：释放后重新检查一次判据，把还剩下的东西如实报出来，绝不假装成功。

它不编辑 `package.json`、不在管理器背后跑 pnpm、也不把 profile 改成管理器不会写成的样子。

## 安装

**从 DSH 市场** —— 搜索 `dsh-plugin-unlock` 安装即可。

**从 GitHub**

```bash
dsh plugin install github:taffy114514/dsh-plugin-unlock
```

**手动装进某个 profile**

```bash
cd ~/.dsh/profiles/desktop
pnpm add https://github.com/taffy114514/dsh-plugin-unlock
```

然后把 `dsh-plugin-unlock` 加进该 `package.json` 的 `dsh.profile.bundles`（或者直接走市场，它会一起做）。重启一次 DSH，插件本体才会加载。

无依赖，Node ≥ 22（DSH 本来就要求）。针对 DeepSeek Harness **0.2.2-rc.5** 开发与验证。

## 使用

### 自动（默认）

两条路径，第一条才是「市场按钮真的能用」的原因：

- **抢先**：任何管理操作都会以 `phase: "started"` 广播到 `plugin-manager/operation`。当 stage 是 `remove` 或 `update` 时，插件当场（同一 tick）把该包残存的 fiber 释放掉——在管理器 deselect、reload、检查之前。闸门通过、pnpm 跑起来、新版本挂上。
- **兜底**：如果操作仍然以 `failed` + `errorCode: "bundle-in-use"` 结案（老宿主、竞态、被别的东西重新加载），插件再释放一次，并自己调 `updateBundle()` 把更新做完。

护栏：同一个包 10 分钟内只自动修一次、同一个操作绝不修两次、正在修的包不再触发、绝不动本插件自己的 fiber、失败操作要留 500 ms 让文件锁先释放。每一次管理器调用都受 `deadlineMs`（默认 3 分钟）限制，卡住的 registry 查询会报超时，而不是一直等下去。

### 它故意永远不动的东西

宿主本身。`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 以及所有官方/安装层 bundle 按设计就有几十个活 fiber——那是正在运行的应用，不是卡住的更新。管理器在「是否在用」检查之前就以 `not-removable` 拒掉它们，所以它们的条目只会出现在 `blockedBy` 里，永不被 dispose。只有本 profile 自己装的包（`availability: "profile"`、`removable: true`）才会被动手。

### `plugin_unlock` 工具

| action | 作用 |
| --- | --- |
| `status` | 每个已装包的摘要：是否被挡、有几个条目挡着。传 `name` 看具体条目 |
| `in_use` | 只看被挡住的包 |
| `runtime` | 宿主用来跑 pnpm 的那份 payload 到底在不在 |
| `release` | 释放挡路的条目——只停插件，不改任何文件 |
| `update` | 先释放，再让管理器更新到最新（或指定）版本 |
| `remove` | 先释放，再让管理器卸载这个包 |
| `heal` | 先释放，并在 `update` 不为 false 时把挂起的更新做完 |

```jsonc
{ "action": "heal", "name": "dsh-caveman" }
```

### HTTP（不想经过助手时）

路由挂在宿主自己的 web 服务上，用的是它正常的请求鉴权：只接受 GUI 自己也发的那枚签名浏览器 Cookie，没有就回 `401 {"ok":false,"error":"未授权"}`。把 Cookie 从浏览器 DevTools（Application → Cookies）里复制到 `-b` 即可，或者干脆用上面的工具。

```bash
# GUI 已经持有的 Cookie
COOKIE='dsh-…=<value>'

# 现在什么被挡住了？
curl -s -b "$COOKIE" http://127.0.0.1:64511/dsh-plugin-unlock/status

# 释放并把更新做完
curl -s -b "$COOKIE" -X POST http://127.0.0.1:64511/dsh-plugin-unlock/heal \
     -H 'content-type: application/json' \
     -d '{"name":"dsh-caveman"}'

# 修复所有被挡住的
curl -s -b "$COOKIE" -X POST http://127.0.0.1:64511/dsh-plugin-unlock/heal-all
```

| 路由 | 方法 |
| --- | --- |
| `/dsh-plugin-unlock/` | GET — 界面本身 |
| `/dsh-plugin-unlock/status[?name=…]` | GET |
| `/dsh-plugin-unlock/in-use[?name=…]` | GET |
| `/dsh-plugin-unlock/runtime` | GET — 宿主从哪跑 pnpm、在不在 |
| `/dsh-plugin-unlock/release` | POST `{name?}` |
| `/dsh-plugin-unlock/update` | POST `{name, version?}` |
| `/dsh-plugin-unlock/remove` | POST `{name}` |
| `/dsh-plugin-unlock/heal` | POST `{name, version?, update?}` |
| `/dsh-plugin-unlock/heal-all` | POST `{update?}` |

## 配置

写在 bundle 的 patch 行（`cordis.patch.yml`）里，或者在前端暴露了设置的地方改：

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `autoFix` | `true` | 自动修复 `bundle-in-use` 失败 |
| `autoUpdate` | `true` | 释放之后把更新做完，而不是停在那儿 |
| `cooldownMs` | `600000` | 同一个包两次自动修复的最小间隔 |
| `route` | `/dsh-plugin-unlock` | HTTP 前缀 |
| `log` | `true` | 把修复过程镜像进报告文件 |
| `deadlineMs` | `180000` | 单次管理器调用的上限 |
| `maxLogEvents` | `50` | status 里保留的事件条数 |

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

每次修复都会追加到 `~/.dsh/plugins-data/dsh-plugin-unlock/report.jsonl`——真出问题时，那个文件会告诉你哪个包、哪一步、管理器给的什么错误码。

## 什么时候它帮不上

- **管理器回 `not-removable`** —— 这是 profile/受保护的 bundle，不会替它释放任何东西。
- **管理器回 `stop-profile`** —— 宿主没开 HMR，热卸载不了，只能重启 DSH。
- **fiber 拒绝 dispose**（回收函数自己抛错）—— 插件报 `needsRestart`，profile 一个字都不动。重启 DSH 再试。
- **包来自钉死的 Git commit** —— 没有「可以更新到」的版本；插件释放阻塞后让你回市场重试，市场会按新的 spec 卸载再装。
- **运行时 payload 缺失** —— 另一个故障，长得像同一个。桌面端所有安装/卸载都走它随包发出的 pnpm（`resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`）。这个文件没了，操作会在**锁清掉之后**以 `MODULE_NOT_FOUND … pnpm.mjs` 或 `ERR_PNPM_UNEXPECTED_STORE` 失败。清 fiber 变不出一个文件，所以插件提前探测、据实回答 `step: "runtime"` + `needsRuntimeRepair: true` 并给出检查到的确切路径。修复或重装 DeepSeek Harness 后重试。

## 开发

```bash
node --test          # 83 个单元测试，零依赖
```

`lib/keys.js` 装着这个插件唯一的那条知识——管理器自己的「是否在用」判据——写成纯函数，所以匹配规则可以脱离宿主测试。`lib/runtime.js` 处理问题的另一半：宿主跑的是哪个 pnpm、它应该在哪、在不在。其余都是对注入服务做 IO。

## 版本沿革

| 版本 | 内容 |
| --- | --- |
| 0.1.x | 释放残留 fiber、修 `bundle-in-use`；补上「运行时 payload 缺失」的识别；绝不释放核心包 |
| 0.2.0 | 适配 DeepSeek Harness 0.2.2-rc.5：`incompatible-version`、`AbortSignal`、`requestId`、`runtime.dshVersion` |
| 0.2.1 | 抢先释放改为同 tick 同步（`reportOperation` 不 await 监听器） |
| 0.2.2 | 文档、工具描述与提示全部改为中文，并补上原理说明 |

## 许可

MIT
