import type {
	PackageCodemod,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export const kodyappsDevToKodyRunCodemodId = '0004-kodyapps-dev-to-kody-run'

/**
 * Matches `https://kodyapps.dev` and `https://{label}.kodyapps.dev` only when
 * the hostname ends there: not followed by more hostname characters, and not
 * followed by a `.` that starts another hostname label. A sentence-final
 * period (`visit https://alice.kodyapps.dev.`) still matches; a longer
 * hostname (`https://kodyapps.dev.evil.example`) never does. Nested labels
 * (`https://a.b.kodyapps.dev`) do not contain this prefix as a complete
 * hostname and are left for the mention scanner.
 *
 * Does not match kody.codes, heykody.app, heykody.dev, inbox hosts, MCP
 * paths on those origins, or status.heykody.dev.
 */
const legacyOriginPattern =
	/https:\/\/(?:([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.)?kodyapps\.dev(?!\.?[A-Za-z0-9-])/g

/**
 * Legacy hostname mentions that survive the origin rewrite (bare
 * `kodyapps.dev` prose, nested labels, and lookalike hosts such as
 * `kodyapps.dev.evil.example`). Reported for manual review, never rewritten.
 */
const legacyMentionPattern = /\bkodyapps\.dev\b/

function rewriteLegacyOrigin(_match: string, label: string | undefined) {
	return label ? `https://${label}.kody.run` : 'https://kody.run'
}

function hasManualMention(source: string) {
	legacyOriginPattern.lastIndex = 0
	return legacyMentionPattern.test(
		source.replace(legacyOriginPattern, rewriteLegacyOrigin),
	)
}

const rewriteMessage =
	'References a legacy package-app origin (https://kodyapps.dev or https://{user}.kodyapps.dev); rewrite to https://kody.run.'

const manualMentionMessage =
	'Mentions a legacy package-app hostname outside an https:// origin (bare hostname, nested label, or lookalike host); review and update manually where it means the hosted-app origin.'

const textFilePattern =
	/\.(?:[cm]?[jt]s|[jt]sx|json|jsonc|md|mdx|txt|html|css|ya?ml|toml)$/

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

function detectLegacyPackageAppOrigins(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> = []
	for (const path of listFilesMatching(files, (source) => {
		legacyOriginPattern.lastIndex = 0
		return legacyOriginPattern.test(source)
	})) {
		findings.push({ path, message: rewriteMessage })
	}
	for (const path of listFilesMatching(files, (source) =>
		hasManualMention(source),
	)) {
		if (findings.some((finding) => finding.path === path)) continue
		findings.push({ path, message: manualMentionMessage })
	}
	findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
	return findings
}

function transformLegacyPackageAppOrigins(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const [path, source] of Object.entries(files)) {
		if (!textFilePattern.test(path)) continue
		if (typeof source !== 'string') continue
		legacyOriginPattern.lastIndex = 0
		const rewritten = source.replace(legacyOriginPattern, rewriteLegacyOrigin)
		if (rewritten !== source) {
			nextFiles[path] = rewritten
			changedPaths.push(path)
		}
		if (hasManualMention(rewritten)) {
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
 * kody.run package-app origin migration (August 2026): rewrites full
 * kodyapps.dev apex and per-user subdomain origins to kody.run and flags
 * every other kodyapps.dev hostname mention for manual review. Kept
 * registered while any published package still references the legacy
 * package-app host.
 */
export const kodyappsDevToKodyRunCodemod = {
	id: kodyappsDevToKodyRunCodemodId,
	description:
		'Rewrite https://kodyapps.dev and https://{user}.kodyapps.dev origins to https://kody.run; flag bare legacy-hostname mentions for manual review.',
	detect: detectLegacyPackageAppOrigins,
	transform: transformLegacyPackageAppOrigins,
} satisfies PackageCodemod
