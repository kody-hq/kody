import { importCapabilityManifest } from '#worker/capability-manifest-module.ts'
import type { Capability, DomainSpec } from './types.ts'
import { isolateMemo, isolateMemoByKey } from '#worker/isolate-memo.ts'

/**
 * Builtin domains merged by `buildCapabilityRegistry` in `registry.ts`.
 *
 * The registry is built from `capability-manifest.generated.mjs`: every
 * builtin capability's metadata, JSON Schemas, and type definitions,
 * precomputed from the real definitions. Search, listings, docs, access
 * filtering, and reindexing read only that data, so they never evaluate a
 * domain module. Each manifest capability's `handler` loads its own domain
 * module on first call, so a fresh isolate pays Zod schema construction and
 * handler module evaluation only for the domains a request dispatches into.
 *
 * The manifest is a separate generated module behind `import()`: Vite origin
 * emits it as its own chunk and Wrangler sibling workers upload it through
 * the allowlisted `find_additional_modules` rule, so it adds nothing to the
 * main script V8 parses on cold start. After changing a builtin capability
 * or domain, run `npm run capabilities:manifest`; the drift test in
 * `capability-manifest.node.test.ts` fails until the manifest matches.
 *
 * Do not import a `*\/domain.ts` module (or a capability definition file)
 * statically from anything on the startup path: one static edge makes esbuild
 * evaluate that module eagerly again. Shared helper modules
 * (`{domain}/shared.ts`) are the supported static entry points.
 *
 * For optional dynamic additions later: pass
 * `[...(await loadBuiltinDomains()), ...extraDomains]` where each extra domain
 * is a real `DomainSpec` with bundled `Capability` handlers.
 */
export const builtinDomainModuleLoaders: Readonly<
	Record<string, () => Promise<DomainSpec>>
> = {
	access: () => import('./access/domain.ts').then((m) => m.accessDomain),
	account: () => import('./account/domain.ts').then((m) => m.accountDomain),
	admin: () => import('./admin/domain.ts').then((m) => m.adminDomain),
	apps: () => import('./apps/domain.ts').then((m) => m.appsDomain),
	community: () =>
		import('./community/domain.ts').then((m) => m.communityDomain),
	coding: () => import('./coding/domain.ts').then((m) => m.codingDomain),
	email: () => import('./email/domain.ts').then((m) => m.emailDomain),
	executionContexts: () =>
		import('./execution-contexts/domain.ts').then(
			(m) => m.executionContextsDomain,
		),
	files: () => import('./files/domain.ts').then((m) => m.filesDomain),
	follow: () => import('./follow/domain.ts').then((m) => m.followDomain),
	integrations: () =>
		import('./integrations/domain.ts').then((m) => m.integrationsDomain),
	jobs: () => import('./jobs/domain.ts').then((m) => m.jobsDomain),
	mcpServers: () =>
		import('./mcp-servers/domain.ts').then((m) => m.mcpServersDomain),
	meta: () => import('./meta/domain.ts').then((m) => m.metaDomain),
	profiles: () => import('./profiles/domain.ts').then((m) => m.profilesDomain),
	orgs: () => import('./orgs/domain.ts').then((m) => m.orgsDomain),
	packages: () => import('./packages/domain.ts').then((m) => m.packagesDomain),
	repo: () => import('./repo/domain.ts').then((m) => m.repoDomain),
	runs: () => import('./runs/domain.ts').then((m) => m.runsDomain),
	secrets: () => import('./secrets/domain.ts').then((m) => m.secretsDomain),
	storage: () => import('./storage/domain.ts').then((m) => m.storageDomain),
	webhooks: () => import('./webhooks/domain.ts').then((m) => m.webhooksDomain),
}

const loadBuiltinDomainModuleMemo = isolateMemoByKey(
	(name) => {
		const load = builtinDomainModuleLoaders[name]
		if (!load) throw new Error(`Unknown builtin domain "${name}"`)
		return load()
	},
	{ limit: Number.POSITIVE_INFINITY },
)

/** Loads and memoizes one domain's real definitions and handlers per isolate. */
export function loadBuiltinDomainModule(name: string): Promise<DomainSpec> {
	if (!Object.hasOwn(builtinDomainModuleLoaders, name)) {
		return Promise.reject(new Error(`Unknown builtin domain "${name}"`))
	}
	return loadBuiltinDomainModuleMemo(name)
}

async function loadBuiltinCapabilityHandler(
	domainName: string,
	capabilityName: string,
): Promise<Capability['handler']> {
	const domain = await loadBuiltinDomainModule(domainName)
	const capability = domain.capabilities.find(
		(candidate) => candidate.name === capabilityName,
	)
	if (!capability) {
		throw new Error(
			`Builtin capability "${capabilityName}" is missing from domain "${domainName}"; run npm run capabilities:manifest`,
		)
	}
	return capability.handler
}

function createLazyHandler(
	domainName: string,
	capabilityName: string,
): Capability['handler'] {
	return async (args, ctx) =>
		(await loadBuiltinCapabilityHandler(domainName, capabilityName))(args, ctx)
}

/** Loads memoized manifest definitions; their handlers load domains on demand. */
export const loadBuiltinDomains: () => Promise<ReadonlyArray<DomainSpec>> =
	isolateMemo(() =>
		importCapabilityManifest().then(({ capabilityManifest }) =>
			capabilityManifest.domains.map(
				({ capabilities, ...domain }): DomainSpec => ({
					...domain,
					capabilities: capabilities.map((capability): Capability => ({
						...capability,
						handler: createLazyHandler(domain.name, capability.name),
					})),
				}),
			),
		),
	)
