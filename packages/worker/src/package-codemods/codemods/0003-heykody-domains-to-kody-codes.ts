import type {
	PackageCodemod,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export const heykodyDomainsToKodyCodesCodemodId =
	'0003-heykody-domains-to-kody-codes'

/**
 * Matches `https://heykody.app` / `https://heykody.dev` only when the
 * hostname ends there: not followed by more hostname characters, and not
 * followed by a `.` that starts another hostname label. A sentence-final
 * period (`visit https://heykody.app.`) still matches; a longer hostname
 * (`https://heykody.app.evil.example`) never does. Subdomain URLs such as
 * `https://status.heykody.dev` or `https://inbox.heykody.app` do not
 * contain this prefix and are untouched.
 */
const legacyOriginPattern = /https:\/\/heykody\.(?:app|dev)(?!\.?[A-Za-z0-9-])/g

/**
 * Legacy hostname mentions that survive the origin rewrite (bare
 * `heykody.app` prose, email addresses on `heykody.*` domains, subdomain
 * hosts, and lookalike hostnames such as `heykody.app.evil.example`).
 * These are reported for manual review, never rewritten: they can be data
 * (stored addresses, config values, historical notes) where a blind
 * rewrite silently changes meaning. Tested against the post-rewrite text
 * so every non-rewritable occurrence is flagged, including ones embedded
 * in an https:// origin the rewriter refused.
 */
const legacyMentionPattern = /\bheykody\.(?:app|dev)\b/

function hasManualMention(source: string) {
	legacyOriginPattern.lastIndex = 0
	return legacyMentionPattern.test(source.replace(legacyOriginPattern, ''))
}

const rewriteMessage =
	'References a legacy Kody origin (https://heykody.app or https://heykody.dev); rewrite to https://kody.codes.'

const manualMentionMessage =
	'Mentions a legacy Kody hostname outside an https:// origin (bare hostname, subdomain, or email address); review and update manually where it means the web origin.'

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

function detectLegacyDomains(
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

function transformLegacyDomains(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const [path, source] of Object.entries(files)) {
		if (!textFilePattern.test(path)) continue
		if (typeof source !== 'string') continue
		legacyOriginPattern.lastIndex = 0
		const rewritten = source.replace(legacyOriginPattern, 'https://kody.codes')
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
 * kody.codes migration (August 2026): rewrites full legacy web origins to
 * the canonical https://kody.codes and flags every other legacy-hostname
 * mention for manual review. Kept registered while any published package
 * still references a heykody origin.
 */
export const heykodyDomainsToKodyCodesCodemod = {
	id: heykodyDomainsToKodyCodesCodemodId,
	description:
		'Rewrite https://heykody.app and https://heykody.dev origins to https://kody.codes; flag bare legacy-hostname mentions for manual review.',
	detect: detectLegacyDomains,
	transform: transformLegacyDomains,
} satisfies PackageCodemod
