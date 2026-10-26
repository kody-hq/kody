/**
 * Which `kody:runtime` exports a per-package facade binds to the declaring
 * package. The hosted facade (`createPackageRuntimeModuleSource`) and the
 * local execute facade (`createLocalExecutePackageRuntimeModuleSource`) both
 * build their bound exports from this one list, so an export that reaches a
 * credential cannot act as the package on one surface and as the caller on
 * the other (GHSA-5fv3).
 *
 * Every public export is classified: bound here, or shared in
 * {@link sharedRuntimeExportReasons} with the reason it carries no package
 * authority. A test fails when a new export is in neither list.
 */
export const packageBoundRuntimeExports = [
	{ name: 'kody', creator: '__kodyCreatePackageBoundKody' },
	{ name: 'packageStorage', creator: '__kodyCreatePackageBoundStorage' },
	{ name: 'packageSecrets', creator: '__kodyCreatePackageBoundSecrets' },
	{
		name: 'createAuthenticatedFetch',
		creator: '__kodyCreatePackageBoundAuthenticatedFetch',
	},
	{
		name: 'oauthClientCredentials',
		creator: '__kodyCreatePackageBoundOauthClientCredentials',
	},
	{ name: 'credential', creator: '__kodyCreatePackageBoundCredentialRuntime' },
	{ name: 'credentials', creator: '__kodyCreatePackageBoundCredentialRuntime' },
] as const

export type PackageBoundRuntimeExportName =
	(typeof packageBoundRuntimeExports)[number]['name']

export const packageBoundRuntimeExportNames: ReadonlyArray<PackageBoundRuntimeExportName> =
	packageBoundRuntimeExports.map((entry) => entry.name)

/** Shared exports and why each needs no package binding. */
export const sharedRuntimeExportReasons = {
	secretHeaders:
		'Builds placeholder strings only. The module fetch that sends them is bound.',
	packageContext: 'Read-only run metadata.',
	email: 'Reads and replies to the run trigger email.',
	workflows: 'Starts workflows for the run.',
	packages: 'Run-level package helpers.',
	events: 'Dispatches events for the run.',
	hasScope: 'Reads platform-set visitor consent metadata from a request.',
	hasVisitorCredential:
		'Reads platform-set visitor consent metadata from a request.',
} as const

const credentialRuntimeName = '__kodyPackageCredentialRuntime'

/**
 * Creator names a facade imports from its base runtime module, plus the
 * lexical `fetch` creator every stamped module uses.
 */
export function packageBoundRuntimeCreatorNames() {
	// Lexical `fetch` and `kody` creators go last, the order bundles have
	// used since GHSA-5fv3, so stored-bundle tooling that edits that import
	// keeps matching.
	const lexical = [
		'__kodyCreatePackageBoundFetch',
		'__kodyCreatePackageBoundKody',
	]
	return [
		...new Set(
			packageBoundRuntimeExports
				.map((entry) => entry.creator as string)
				.filter((creator) => !lexical.includes(creator)),
		),
		...lexical,
	]
}

/**
 * `export const` lines that bind every listed export (and the lexical
 * `__kodyBoundFetch`) to `packageId`.
 */
export function createPackageBoundRuntimeExportLines(packageId: string) {
	const id = JSON.stringify(packageId)
	const lines = [
		`export const __kodyBoundFetch = __kodyCreatePackageBoundFetch(${id});`,
	]
	let credentialRuntimeEmitted = false
	for (const entry of packageBoundRuntimeExports) {
		if (entry.creator === '__kodyCreatePackageBoundCredentialRuntime') {
			if (!credentialRuntimeEmitted) {
				lines.push(`const ${credentialRuntimeName} = ${entry.creator}(${id});`)
				credentialRuntimeEmitted = true
			}
			lines.push(
				`export const ${entry.name} = ${credentialRuntimeName}.${entry.name};`,
			)
			continue
		}
		lines.push(`export const ${entry.name} = ${entry.creator}(${id});`)
	}
	return lines.join('\n')
}
