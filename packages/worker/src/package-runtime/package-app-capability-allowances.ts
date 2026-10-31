/**
 * Per-app-version capability allowances (ADR 0089 amendment 2026-10-31).
 *
 * A row lets one published commit of one app keep calling one capability its
 * `kody.app.capabilities` does not list. Rows are data seeded from the
 * visitor-fallback telemetry, never a global loosening: a new publish has a
 * new commit and gets no allowance, so publish and `kody dev check` name what
 * to add before that publish goes live.
 */
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export async function loadPackageAppCapabilityAllowance(
	db: D1Database,
	input: { packageId: string; publishedCommit: string | null | undefined },
): Promise<Array<string>> {
	const publishedCommit = input.publishedCommit?.trim()
	if (!publishedCommit) return []
	const rows = await db
		.prepare(
			`SELECT capability_name FROM package_app_capability_allowances
			 WHERE package_id = ? AND published_commit = ?
			 ORDER BY capability_name`,
		)
		.bind(input.packageId, publishedCommit)
		.all<{ capability_name: string }>()
	return (rows.results ?? []).map((row) => row.capability_name)
}

/**
 * The allowance of the version currently published for this app, found by
 * its entity source or, for a local dev check, its owner and package name.
 */
export async function loadPublishedCapabilityAllowance(
	db: D1Database,
	input: {
		sourceId: string | null
		ownerId: string | null
		packageName: string | null | undefined
	},
): Promise<Array<string>> {
	const select = `SELECT p.id AS package_id, s.published_commit AS published_commit
		FROM saved_packages p
		JOIN entity_sources s ON s.id = p.source_id`
	const row = input.sourceId
		? await db
				.prepare(
					`${select} WHERE p.source_id = ?${andLiveDeletedAtSql('p')} LIMIT 1`,
				)
				.bind(input.sourceId)
				.first<{ package_id: string; published_commit: string | null }>()
		: input.ownerId && input.packageName
			? await db
					.prepare(
						`${select} WHERE p.user_id = ? AND p.name = ?${andLiveDeletedAtSql('p')} LIMIT 1`,
					)
					.bind(input.ownerId, input.packageName)
					.first<{ package_id: string; published_commit: string | null }>()
			: null
	if (!row) return []
	return await loadPackageAppCapabilityAllowance(db, {
		packageId: row.package_id,
		publishedCommit: row.published_commit,
	})
}

/** Allowed capabilities a source does not declare yet, sorted. */
export function undeclaredAllowedCapabilities(input: {
	allowance: ReadonlyArray<string>
	declared: ReadonlySet<string>
}): Array<string> {
	return [...new Set(input.allowance)]
		.filter((name) => !input.declared.has(name))
		.sort((left, right) => left.localeCompare(right))
}

export function capabilityAllowanceExample(names: ReadonlyArray<string>) {
	return `"kody": { "app": { "capabilities": [${names.map((name) => JSON.stringify(name)).join(', ')}] } }`
}

/**
 * Publish and dev check warning for an app whose published version runs on
 * an allowance this source does not declare.
 */
export function buildCapabilityAllowanceCheck(input: {
	allowance: ReadonlyArray<string>
	declared: ReadonlySet<string>
}): { kind: 'capabilities'; ok: true; message: string } | null {
	const missing = undeclaredAllowedCapabilities(input)
	if (missing.length === 0) return null
	return {
		kind: 'capabilities',
		ok: true,
		message: [
			`Action needed before this publish: your published version calls ${missing.length} capability name(s) that \`kody.app.capabilities\` does not list. Kody lets that published version keep calling them, but the allowance does not carry over to a new version. Once you publish without them, these calls fail.`,
			...missing.map((name) => `- \`${name}\``),
			`Add them to \`kody.app.capabilities\` in package.json, for example: ${capabilityAllowanceExample(missing)}`,
		].join('\n'),
	}
}
