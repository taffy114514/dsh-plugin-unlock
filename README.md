# dsh-plugin-unlock

**Clears the DSH desktop refusal “这个插件正在使用中，桌面端不允许现在移除” / “the plugin is in use, and the desktop app will not remove it right now” and finishes the update the marketplace gave up on.**

When the DSH desktop marketplace tries to update or remove a plugin, `@deepseek-ai/dsh-plugin-manager` first unloads it, then checks whether any of its loader entries still runs a live fiber. If one does — which happens whenever the hot-module reload cannot fully unload a plugin — the operation fails with `bundle-in-use` and nothing happens: no update, no removal, no error detail.

`dsh-plugin-unlock` releases exactly those fibers and then hands the bundle back to the manager, so the marketplace's own update proceeds: pnpm remove → install → reload, with the profile `package.json`, the lockfile and `dsh.profile.bundles` left exactly as the manager writes them.

---

## What is actually wrong

The refusal is emitted by the manager in `dsh-plugin-manager/lib/index.js`:

```js
if ([...this.ctx.loader.entries()].some((entry) =>
      entry.fiber?.uid != null &&
      contributions.some((row) => row.id === entry.options.id && row.name === entry.options.name)))
  throw new ManagementFailure("bundle-in-use");
```

`entry.fiber.uid` is the liveness flag: a fiber that is still loaded owns a uid, and `Fiber.dispose()` sets it to `null`. So the question “is this plugin in use?” is really “did the hot unload actually stop it?”.

On the desktop the answer is regularly *no* — a plugin that owns a long-lived resource (a timer, a socket, a child process, a web route, an inbox loop) keeps its fiber alive, and the manager refuses to pull the package out from under a running plugin.

No file is wrong in that state. Only the running composition is. That is why “restart the app and try again” works, and why nothing in the marketplace can fix it in place.

## What the plugin does

1. **Find** the entries that block a bundle, using the manager's own predicate — `pluginManager.bundleRows(name)` for the (id, name) pairs the manager compares, then the live loader entries that match them.
2. **Release** them: `await entry.fiber.dispose()` for each, which clears `fiber.uid` and runs the plugin's teardown.
3. **Finish the job**: `pluginManager.updateBundle(name, version)` (or `removeBundle(name)`) now passes its own gate and does the real work.
4. **Prove it**: after the release it re-checks the predicate and reports what is left, so you never get a false "done".

It never edits `package.json`, never runs pnpm behind the manager's back and never forces the profile into a state the manager would not have written.

## Install

**From the DSH marketplace** — search for `dsh-plugin-unlock` and install it.

**From GitHub**

```bash
dsh plugin install github:YG/dsh-plugin-unlock
```

**Manually, into a profile**

```bash
cd ~/.dsh/profiles/desktop
pnpm add github:YG/dsh-plugin-unlock
```

then add `dsh-plugin-unlock` to `dsh.profile.bundles` in that `package.json` (or install it through the marketplace, which does both). Restart DSH once so the plugin itself loads.

No dependencies. Node ≥ 22, which DSH already requires.

## Use it

### Automatic (default)

When the marketplace's update or removal fails with `bundle-in-use`, the failure is reported on `plugin-manager/operation`. The plugin picks it up, releases the fibers, and re-runs the manager's update. You see the update succeed instead of the refusal.

Guard rails: one automatic repair per bundle per 10 minutes, never twice for the same operation, never for a bundle it is already repairing, and a 500 ms pause so the failed operation's file lock is released first.

### What it deliberately never touches

The Host itself. `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` and every other official or installation bundle keep dozens of live fibers by design — that is the running app, not a stuck update. The manager answers `not-removable` for them long before it reaches the in-use check, so their entries are reported under `blockedBy` and never disposed. Only bundles this profile installed itself (`availability: "profile"`, `removable: true`) are eligible, and `release` refuses anything else by name instead of tearing the Host apart.

### The `plugin_unlock` tool

| action | what it does |
| --- | --- |
| `status` | a summary of every installed bundle: blocked or not, and how many entries hold it. Pass `name` to see those entries |
| `in_use` | only the blocked bundles |
| `runtime` | whether the pnpm payload the Host installs through is actually on disk |
| `release` | dispose the blocking entries — stops the plugin, changes no file |
| `update` | release, then let the manager update to the newest (or a given) version |
| `remove` | release, then let the manager remove the package |
| `heal` | release and, unless `update: false`, finish the pending update |

```jsonc
{ "action": "heal", "name": "dsh-caveman" }
```

### HTTP, when you would rather not ask the assistant

The routes are mounted on the Host's own web server and use its normal request authentication: they accept the same signed browser cookie the GUI itself sends, and answer `401 {"ok":false,"error":"unauthorized"}` without it. Copy the cookie out of your browser's DevTools (Application → Cookies) into `-b`, or just use the tool and skip this section.

```bash
# the cookie the GUI already holds
COOKIE='dsh-…=<value>'

# what is blocked?
curl -s -b "$COOKIE" http://127.0.0.1:64511/dsh-plugin-unlock/status

# release and finish the update
curl -s -b "$COOKIE" -X POST http://127.0.0.1:64511/dsh-plugin-unlock/heal \
     -H 'content-type: application/json' \
     -d '{"name":"dsh-caveman"}'

# repair everything that is blocked
curl -s -b "$COOKIE" -X POST http://127.0.0.1:64511/dsh-plugin-unlock/heal-all
```

| route | method |
| --- | --- |
| `/dsh-plugin-unlock/` | GET — the surface itself |
| `/dsh-plugin-unlock/status[?name=…]` | GET |
| `/dsh-plugin-unlock/in-use[?name=…]` | GET |
| `/dsh-plugin-unlock/runtime` | GET — where the Host runs pnpm from, and whether it is there |
| `/dsh-plugin-unlock/release` | POST `{name?}` |
| `/dsh-plugin-unlock/update` | POST `{name, version?}` |
| `/dsh-plugin-unlock/remove` | POST `{name}` |
| `/dsh-plugin-unlock/heal` | POST `{name, version?, update?}` |
| `/dsh-plugin-unlock/heal-all` | POST `{update?}` |

## Configuration

In the bundle's patch row (`cordis.patch.yml`), or through the plugin's settings if your front-end exposes them:

| option | default | meaning |
| --- | --- | --- |
| `autoFix` | `true` | repair `bundle-in-use` failures automatically |
| `autoUpdate` | `true` | after a release, finish the update instead of stopping there |
| `cooldownMs` | `600000` | minimum gap between two automatic repairs of one bundle |
| `route` | `/dsh-plugin-unlock` | HTTP prefix |
| `log` | `true` | mirror repairs into the report file |
| `maxLogEvents` | `50` | events kept in memory for the status call |

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

Every repair is appended to `~/.dsh/plugins-data/dsh-plugin-unlock/report.jsonl` — if a repair ever fails, that file says which bundle, which step, and the manager's error code.

## When it cannot help

- **The manager says `not-removable`** — the package is a profile/protected bundle; nothing is released on its behalf.
- **The manager says `stop-profile`** — the Host runs without HMR and cannot hot-remove anything; restart DSH.
- **A fiber refuses to dispose** (its teardown throws) — the plugin reports `needsRestart` and leaves the profile untouched. Restart DSH, then retry the update.
- **The bundle comes from a pinned Git commit** — there is no version to update *to*; the plugin releases the block and tells you to retry the marketplace, which then removes and reinstalls from the new spec.
- **The runtime payload is missing** — a different defect that looks like the same one. The desktop runs every install and removal through the pnpm it ships at `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`. If that file is gone (an interrupted update, a half-unpacked or copied installation, a cleaner that emptied `resources/runtime`), the operation fails *after* the lock is cleared, with `MODULE_NOT_FOUND … pnpm.mjs` or `ERR_PNPM_UNEXPECTED_STORE`. Clearing fibers cannot bring a file back, so the plugin detects this up front, refuses to pretend, and answers `step: "runtime"` with `needsRuntimeRepair: true` and the exact path it checked. Repair or reinstall DeepSeek Harness, then retry. `action: "runtime"` (or `GET /dsh-plugin-unlock/runtime`) tells you which of the two problems you are looking at.

## Development

```bash
node --test          # 71 unit tests, no dependencies
```

`lib/keys.js` holds the single piece of knowledge the plugin is built on — the manager's own "in use" predicate — as pure functions, so the matching rules are testable without a Host. `lib/runtime.js` does the same for the other half of the problem: which pnpm the Host runs, where it should be, and whether it is there. Everything else is I/O over injected services.

## License

MIT
