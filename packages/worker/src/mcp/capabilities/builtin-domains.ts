import { type DomainSpec } from './types.ts'

/**
 * Builtin domains merged by `buildCapabilityRegistry` in `registry.ts`.
 *
 * Loaded through dynamic `import()` on purpose. Every domain module pulls in
 * its capability files, and each of those constructs Zod input/output schemas
 * at module scope — several hundred schemas across the fleet. With static
 * imports that work runs during Worker startup, which Cloudflare caps at a
 * fixed CPU budget measured at upload time; it was the single largest item in
 * the origin startup profile. esbuild keeps these modules in the same bundle
 * but evaluates them lazily, so the cost moves to the first request that
 * needs the registry and is then memoized for the isolate lifetime.
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
const builtinDomainLoaders: ReadonlyArray<() => Promise<DomainSpec>> = [
	() => import('./access/domain.ts').then((m) => m.accessDomain),
	() => import('./account/domain.ts').then((m) => m.accountDomain),
	() => import('./admin/domain.ts').then((m) => m.adminDomain),
	() => import('./apps/domain.ts').then((m) => m.appsDomain),
	() => import('./community/domain.ts').then((m) => m.communityDomain),
	() => import('./coding/domain.ts').then((m) => m.codingDomain),
	() => import('./email/domain.ts').then((m) => m.emailDomain),
	() =>
		import('./execution-contexts/domain.ts').then(
			(m) => m.executionContextsDomain,
		),
	() => import('./follow/domain.ts').then((m) => m.followDomain),
	() => import('./integrations/domain.ts').then((m) => m.integrationsDomain),
	() => import('./jobs/domain.ts').then((m) => m.jobsDomain),
	() => import('./mcp-servers/domain.ts').then((m) => m.mcpServersDomain),
	() => import('./meta/domain.ts').then((m) => m.metaDomain),
	() => import('./profiles/domain.ts').then((m) => m.profilesDomain),
	() => import('./orgs/domain.ts').then((m) => m.orgsDomain),
	() => import('./packages/domain.ts').then((m) => m.packagesDomain),
	() => import('./repo/domain.ts').then((m) => m.repoDomain),
	() => import('./runs/domain.ts').then((m) => m.runsDomain),
	() => import('./secrets/domain.ts').then((m) => m.secretsDomain),
	() => import('./storage/domain.ts').then((m) => m.storageDomain),
	() => import('./webhooks/domain.ts').then((m) => m.webhooksDomain),
]

let builtinDomainsMemo: Promise<ReadonlyArray<DomainSpec>> | null = null

export function loadBuiltinDomains(): Promise<ReadonlyArray<DomainSpec>> {
	builtinDomainsMemo ??= Promise.all(
		builtinDomainLoaders.map((load) => load()),
	).catch((error: unknown) => {
		// A failed load must not poison every later call for the isolate.
		builtinDomainsMemo = null
		throw error
	})
	return builtinDomainsMemo
}
