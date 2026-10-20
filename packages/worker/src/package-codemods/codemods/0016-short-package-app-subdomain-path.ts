import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const shortPackageAppSubdomainPathCodemodId =
	'0016-short-package-app-subdomain-path'

/**
 * Matches `https://{label}.kody.run/packages/{leaf}` (and optional rest /
 * query / hash) only when the hostname is a single-label kody.run subdomain
 * and the next path segment after `packages` is a package leaf. Does not
 * match:
 * - app-origin paths (`https://kody.codes/@user/packages/...`)
 * - apex `https://kody.run/packages/...`
 * - nested labels (`https://a.b.kody.run/...`)
 * - Open API paths (`/v1/packages/...`)
 */
const legacySubdomainMountPattern =
	/https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.kody\.run\/packages\/([a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?)(?!\.?[A-Za-z0-9_-])/g

/**
 * Ambiguous bare `/packages/{leaf}` mounts that may mean the hosted subdomain
 * path (or may mean the app-origin `/@user/packages/...` / Open API surface).
 * Reported for manual review; never rewritten.
 */
const ambiguousBareMountPattern =
	/(?<![@/\w.-])\/packages\/([a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?)(?!\.?[A-Za-z0-9_-])/

const rewriteMessage =
	'References a legacy package-app subdomain mount (https://{user}.kody.run/packages/{leaf}); rewrite to https://{user}.kody.run/{leaf}.'

const manualMentionMessage =
	'Mentions a bare /packages/{leaf} mount that may mean the hosted subdomain path; review and update manually (keep /@user/packages/... and /v1/packages/... as-is).'

const textFilePattern =
	/\.(?:[cm]?[jt]s|[jt]sx|json|jsonc|md|mdx|txt|html|css|ya?ml|toml)$/

function rewriteLegacySubdomainMount(
	_match: string,
	label: string,
	leaf: string,
) {
	return `https://${label}.kody.run/${leaf}`
}

function listFilesMatching(
	files: Record<string, string>,
	test: (source: string) => boolean,
) {
	const paths: Array<string> = []
	for (const [path, source] of Object.entries(files)) {
		if (!textFilePattern.test(path)) continue
		if (typeof source !== 'string') continue
		if (test(source)) paths.push(path)
	}
	return paths.sort((left, right) => left.localeCompare(right))
}

function hasAmbiguousBareMount(source: string) {
	legacySubdomainMountPattern.lastIndex = 0
	const withoutRewritable = source.replace(
		legacySubdomainMountPattern,
		rewriteLegacySubdomainMount,
	)
	return ambiguousBareMountPattern.test(withoutRewritable)
}

function detectLegacySubdomainMounts(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> = []
	for (const path of listFilesMatching(files, (source) => {
		legacySubdomainMountPattern.lastIndex = 0
		return legacySubdomainMountPattern.test(source)
	})) {
		findings.push({ path, message: rewriteMessage })
	}
	for (const path of listFilesMatching(files, (source) =>
		hasAmbiguousBareMount(source),
	)) {
		findings.push({ path, message: manualMentionMessage })
	}
	findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
	return findings
}

function transformLegacySubdomainMounts(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const [path, source] of Object.entries(files)) {
		if (!textFilePattern.test(path)) continue
		if (typeof source !== 'string') continue
		legacySubdomainMountPattern.lastIndex = 0
		const rewritten = source.replace(
			legacySubdomainMountPattern,
			rewriteLegacySubdomainMount,
		)
		if (rewritten !== source) {
			nextFiles[path] = rewritten
			changedPaths.push(path)
		}
		if (hasAmbiguousBareMount(rewritten)) {
			needsManual.push({ path, message: manualMentionMessage })
		}
	}
	changedPaths.sort((left, right) => left.localeCompare(right))
	needsManual.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual,
	}
}

/**
 * Short subdomain mount migration: rewrites
 * `https://{user}.kody.run/packages/{leaf}` to `https://{user}.kody.run/{leaf}`
 * and flags ambiguous bare `/packages/{leaf}` mentions for manual review.
 * App-origin `/@user/packages/...` and Open API `/v1/packages/...` are left
 * alone.
 */
export const shortPackageAppSubdomainPathCodemod = {
	id: shortPackageAppSubdomainPathCodemodId,
	description:
		'Rewrite https://{user}.kody.run/packages/{leaf} to https://{user}.kody.run/{leaf}; flag ambiguous bare /packages/{leaf} mounts for manual review.',
	detect: detectLegacySubdomainMounts,
	transform: transformLegacySubdomainMounts,
} satisfies PackageCodemod
