/**
 * The `plugin_unlock` tool.
 *
 * A tool (rather than only an HTTP route) because the assistant can then repair
 * the block itself the moment a user reports it, and because tools are the
 * surface every DSH front-end already exposes.
 */

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'in_use', 'release', 'update', 'remove', 'heal'],
      description:
        'status = list bundles and what blocks them; in_use = only the bundles blocked by a live entry; '
        + 'release = dispose those entries (stops the plugin, changes no file); '
        + 'update = release, then let the plugin manager update the bundle; '
        + 'remove = release, then let the plugin manager remove the bundle; '
        + 'heal = release and, unless update:false, finish the pending update.',
    },
    name: {
      type: 'string',
      description: 'Bundle name as the profile lists it, e.g. dsh-caveman. Omit for status/in_use.',
    },
    version: {
      type: 'string',
      description: 'Exact version for action=update. Omit to use the newest version the registry lists.',
    },
    update: {
      type: 'boolean',
      description: 'action=heal only: true finishes the update after the release, false stops at the release.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Whether the requested step succeeded.' },
    action: { type: 'string' },
    bundle: { type: 'string' },
    step: { type: 'string', description: 'The step that ran last: release, list-versions, update or remove.' },
    reason: { type: 'string', description: 'Why a step failed, in plain language.' },
    blocked: { type: 'array', description: 'Bundles blocked by live loader entries.' },
    bundles: { type: 'array', description: 'Every bundle the profile knows, with its block state.' },
    services: { type: 'object', description: 'Which Host services the plugin can see.' },
    hint: { type: 'string' },
  },
  additionalProperties: true,
};

const DESCRIPTION =
  'Repair a DSH plugin that the marketplace refuses to update or remove with "the plugin is in use". '
  + 'The desktop host keeps the plugin\'s fiber alive after a hot unload, and the plugin manager then aborts the '
  + 'removal ("bundle-in-use"). This tool releases those fibers and re-runs the manager\'s own update/remove, '
  + 'so the profile, lockfile and bundle bookkeeping stay exactly as the manager wrote them.';

/**
 * @param {ReturnType<import('./repair.js').createRepair>} repair
 */
export function createUnlockTool(repair) {
  return {
    name: 'plugin_unlock',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      const action = typeof args.action === 'string' ? args.action : 'status';
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
      try {
        if (action === 'status') {
          const result = await repair.status({ name });
          return { action, ...result, hint: hintFor(name, result) };
        }
        if (action === 'in_use') {
          const result = await repair.status({ name, includeEvents: false });
          return {
            action,
            ok: result.ok === true,
            generatedAt: result.generatedAt,
            blocked: result.blocked ?? [],
            counts: result.counts ?? null,
            services: result.services ?? null,
          };
        }
        if (action === 'release') return { action, ...(await repair.release(name)) };
        if (action === 'update') return { action, ...(await repair.update(name, { version: args.version })) };
        if (action === 'remove') return { action, ...(await repair.remove(name)) };
        if (action === 'heal') {
          return { action, ...(await repair.heal(name, { version: args.version, update: typeof args.update === 'boolean' ? args.update : undefined })) };
        }
        return { action, ok: false, reason: `unknown action: ${String(action)}` };
      } catch (error) {
        return {
          action,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          code: typeof (/** @type {any} */ (error)?.code) === 'string' ? /** @type {any} */ (error).code : null,
        };
      }
    },
  };
}

function hintFor(name, result) {
  if (result?.ok !== true) return 'The pluginManager service was not reachable, so nothing could be inspected.';
  if (!name) {
    const blocked = Array.isArray(result.blocked) ? result.blocked.length : 0;
    return blocked === 0
      ? 'No bundle is blocked right now.'
      : 'Run plugin_unlock with action=heal and one of these names to release it and finish the pending update.';
  }
  const bundle = Array.isArray(result.bundles) ? result.bundles.find((item) => item.name === name) : undefined;
  if (!bundle) return `${name} is not a bundle this profile lists.`;
  if (!bundle.blocked) return `${name} is not blocked; the marketplace can update or remove it.`;
  return `${name} is blocked by ${bundle.blockedBy.length} live loader ${bundle.blockedBy.length === 1 ? 'entry' : 'entries'}; run action=heal.`;
}
