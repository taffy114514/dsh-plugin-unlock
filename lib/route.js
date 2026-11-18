/**
 * HTTP surface, mounted on the Host's own web server under `config.route`
 * (default `/dsh-plugin-unlock`), so the repair is reachable without the
 * assistant — a browser tab or a curl one-liner is enough.
 *
 *   GET  /dsh-plugin-unlock/            → what this plugin is and its routes
 *   GET  /dsh-plugin-unlock/status      → every bundle and what blocks it
 *   GET  /dsh-plugin-unlock/in-use      → only the blocked bundles
 *   POST /dsh-plugin-unlock/release     → {"name": "…"} release one or all
 *   POST /dsh-plugin-unlock/update      → {"name": "…", "version": "…"}
 *   POST /dsh-plugin-unlock/remove      → {"name": "…"}
 *   POST /dsh-plugin-unlock/heal        → {"name": "…", "update": true}
 *   POST /dsh-plugin-unlock/heal-all    → repair every blocked bundle
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
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('request body is not valid JSON');
  }
}

/** The text one POST must carry to target a bundle. */
function nameOf(body) {
  return typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
}

/**
 * @param {{ctx: any, repair: any, config: any}} input
 */
export function createHandler({ ctx, repair, config }) {
  function rejectionOf(req) {
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
      sendJson(res, rejection, { ok: false, error: 'unauthorized' });
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
          purpose: 'Release DSH plugins stuck "in use" so the marketplace can update or remove them.',
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
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
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
      sendJson(res, 404, { ok: false, error: `no route for ${action}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/**
 * Mount the routes on the Host's web server.
 * @param {{ctx: any, repair: any, config: any}} input
 * @returns {() => void} disposer
 */
export function registerRoutes({ ctx, repair, config, log }) {
  const webServer = ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    log?.('routes-unavailable', { reason: 'the webServer service is not available' });
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
