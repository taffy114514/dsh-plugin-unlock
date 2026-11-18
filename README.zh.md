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

### `plugin_unlock` 工具

| action | 作用 |
| --- | --- |
| `status` | 列出 profile 里所有 bundle、是否被挡、被哪些条目挡 |
| `in_use` | 只列被挡的 |
| `release` | 释放挡路条目（停掉插件，不动任何文件） |
| `update` | 释放后交给管理器更新到最新（或指定）版本 |
| `remove` | 释放后交给管理器卸载 |
| `heal` | 释放后把待办的更新做完（`update: false` 则只释放） |

```jsonc
{ "action": "heal", "name": "dsh-caveman" }
```

### HTTP（不想通过助手时）

路由挂在 Host 自己的 web server 上，走它原有的请求鉴权。

```bash
# 现在有什么被挡住了？
curl http://127.0.0.1:64511/dsh-plugin-unlock/status

# 释放并把更新做完
curl -X POST http://127.0.0.1:64511/dsh-plugin-unlock/heal \
     -H 'content-type: application/json' \
     -d '{"name":"dsh-caveman"}'

# 把所有被挡的都修一遍
curl -X POST http://127.0.0.1:64511/dsh-plugin-unlock/heal-all
```

| 路由 | 方法 |
| --- | --- |
| `/dsh-plugin-unlock/` | GET —— 接口自述 |
| `/dsh-plugin-unlock/status[?name=…]` | GET |
| `/dsh-plugin-unlock/in-use[?name=…]` | GET |
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

## 开发

```bash
node --test          # 57 个单元测试，零依赖
```

`lib/keys.js` 里放着这个插件唯一的核心知识——管理器自己那套"是否在使用中"的判据——写成纯函数，所以匹配规则不需要 Host 就能测。其余都是对注入服务的 I/O。

## 许可

MIT
