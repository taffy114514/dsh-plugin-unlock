/**
 * HTTP 界面，挂在宿主自己的 web 服务上（前缀取 `config.route`，默认
 * `/dsh-plugin-unlock`），这样不经过助手也能用——一个浏览器标签页或一行 curl
 * 就够了。
 *
 *   GET  /dsh-plugin-unlock/            → 这个插件是什么、有哪些路由
 *   GET  /dsh-plugin-unlock/status      → 每个插件包与被什么挡住
 *   GET  /dsh-plugin-unlock/in-use      → 只看被挡住的
 *   GET  /dsh-plugin-unlock/runtime     → 宿主跑 pnpm 用的 payload 在不在
 *   POST /dsh-plugin-unlock/release     → {"name": "…"} 释放一个或全部
 *   POST /dsh-plugin-unlock/update      → {"name": "…", "version": "…"}
 *   POST /dsh-plugin-unlock/remove      → {"name": "…"}
 *   POST /dsh-plugin-unlock/heal        → {"name": "…", "update": true}
 *   POST /dsh-plugin-unlock/heal-all    → 修复所有被挡住的包
 */

const MAX_BODY_BYTES = 65536;

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('请求体不是合法的 JSON');
  }
}

/** 一次 POST 里用来指定插件包的那个字段。 */
function nameOf(body) {
  return typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
}

/**
 * @param {{ctx: any, repair: any, config: any}} input
 */
export function createHandler({ ctx, repair, config }) {
  function rejectionOf(req) {
    // 复用宿主自己的鉴权：GUI 怎么校验请求，这里就怎么校验，绝不自己开一个口子。
    let rejection = 503;
    try {
      const connection = ctx.get('connection');
      const value = connection && typeof connection.requestRejection === 'function'
        ? connection.requestRejection(req)
        : undefined;
      if (typeof value === 'number') rejection = value;
      else if (value === undefined && connection) rejection = 0;
    } catch {
      rejection = 503;
    }
    return rejection;
  }

  return async function handler(req, res) {
    const rejection = rejectionOf(req);
    if (rejection !== 0) {
      sendJson(res, rejection, { ok: false, error: '未授权' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const action = url.pathname.slice(config.route.length) || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      if (action === '/' || action === '') {
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-plugin-unlock',
          route: config.route,
          purpose: '释放被“正在使用中”卡住的 DSH 插件，让市场能更新或卸载它们。',
          actions: [
            'GET  status',
            'GET  in-use',
            'GET  runtime',
            'POST release    {name?}',
            'POST update     {name, version?}',
            'POST remove     {name}',
            'POST heal       {name, version?, update?}',
            'POST heal-all',
          ],
        });
        return;
      }
      if (action === '/status' && method === 'GET') {
        sendJson(res, 200, await repair.status({ name: url.searchParams.get('name') ?? undefined }));
        return;
      }
      if (action === '/in-use' && method === 'GET') {
        const result = await repair.status({ name: url.searchParams.get('name') ?? undefined, includeEvents: false });
        sendJson(res, 200, { ok: result.ok === true, blocked: result.blocked ?? [], counts: result.counts ?? null });
        return;
      }
      if (action === '/runtime' && method === 'GET') {
        const runtime = repair.runtime();
        sendJson(res, 200, { ok: runtime.ok === true, runtime });
        return;
      }

      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '不支持这个方法' });
        return;
      }

      const body = await readJsonBody(req);
      if (action === '/release') {
        sendJson(res, 200, { action: 'release', ...(await repair.release(nameOf(body))) });
        return;
      }
      if (action === '/update') {
        sendJson(res, 200, { action: 'update', ...(await repair.update(nameOf(body), { version: typeof body.version === 'string' ? body.version : undefined })) });
        return;
      }
      if (action === '/remove') {
        sendJson(res, 200, { action: 'remove', ...(await repair.remove(nameOf(body))) });
        return;
      }
      if (action === '/heal') {
        sendJson(res, 200, {
          action: 'heal',
          ...(await repair.heal(nameOf(body), {
            version: typeof body.version === 'string' ? body.version : undefined,
            update: typeof body.update === 'boolean' ? body.update : undefined,
          })),
        });
        return;
      }
      if (action === '/heal-all') {
        const status = await repair.status({ includeEvents: false });
        const names = (status.blocked ?? []).map((item) => item.name);
        const results = [];
        for (const name of names) results.push(await repair.heal(name, { update: body.update !== false }));
        sendJson(res, 200, { action: 'heal-all', ok: results.every((item) => item.ok), repaired: results });
        return;
      }
      sendJson(res, 404, { ok: false, error: `没有这个路由：${action}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/**
 * 把路由挂到宿主的 web 服务上。
 * @param {{ctx: any, repair: any, config: any}} input
 * @returns {() => void} 卸载函数
 */
export function registerRoutes({ ctx, repair, config, log }) {
  const webServer = ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    log?.('routes-unavailable', { reason: '拿不到 webServer 服务' });
    return () => {};
  }
  const dispose = webServer.register({
    kind: 'prefix',
    path: config.route,
    handler: createHandler({ ctx, repair, config }),
  });
  log?.('routes-registered', { route: config.route });
  return typeof dispose === 'function' ? dispose : () => {};
}
