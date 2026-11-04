import { McpCallerError } from '#worker/mcp/caller-error.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { isPublishOffloadEnabledFor } from './flag.ts'
import { sha256Hex } from './module-hashes.ts'
import {
	publishBuildRejectionHint,
	publishBuildRetentionMs,
	publishBuildTicketTtlMs,
	type PublishBuildOrigin,
} from './policy.ts'
import type {
	PublishBuildDocument,
	PublishBuildStatus,
	UploadedPublishBuildRef,
} from './types.ts'

export type { UploadedPublishBuildRef } from './types.ts'

export type PublishBuildRow = {
	id: string
	package_id: string
	source_id: string
	owner_user_id: string
	requester_user_id: string
	org_id: string
	commit_sha: string
	origin: PublishBuildOrigin
	context_id: string | null
	context_name: string | null
	ticket_sha256: string
	status: PublishBuildStatus
	document_json: string | null
	message: string | null
	created_at: string
	updated_at: string
	expires_at: string
	committed_at: string | null
}

const ticketPrefix = 'kpb_'

export function publishBuildBlobKey(buildId: string, sha256: string) {
	return `publish-builds/${buildId}/${sha256}`
}

export function publishBuildBlobPrefix(buildId: string) {
	return `publish-builds/${buildId}/`
}

function randomToken(bytes = 32) {
	const buffer = crypto.getRandomValues(new Uint8Array(bytes))
	return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

export async function createPublishBuild(input: {
	db: D1Database
	packageId: string
	sourceId: string
	ownerUserId: string
	requesterUserId: string
	orgId: string
	commit: string
	origin: Exclude<PublishBuildOrigin, 'cloud'>
	contextId?: string | null
	contextName?: string | null
	now?: number
}) {
	const now = input.now ?? Date.now()
	const id = `pb_${randomToken(12)}`
	const ticket = `${ticketPrefix}${randomToken()}`
	const nowIso = new Date(now).toISOString()
	const expiresAt = new Date(now + publishBuildTicketTtlMs).toISOString()
	await input.db
		.prepare(
			`INSERT INTO publish_builds (
				id, package_id, source_id, owner_user_id, requester_user_id, org_id,
				commit_sha, origin, context_id, context_name, ticket_sha256, status,
				created_at, updated_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
		)
		.bind(
			id,
			input.packageId,
			input.sourceId,
			input.ownerUserId,
			input.requesterUserId,
			input.orgId,
			input.commit,
			input.origin,
			input.contextId ?? null,
			input.contextName ?? null,
			await sha256Hex(ticket),
			nowIso,
			nowIso,
			expiresAt,
		)
		.run()
	return { buildId: id, ticket, expiresAt }
}

export async function getPublishBuild(db: D1Database, buildId: string) {
	return await db
		.prepare(`SELECT * FROM publish_builds WHERE id = ?`)
		.bind(buildId)
		.first<PublishBuildRow>()
}

function timingSafeEqualHex(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let index = 0; index < a.length; index += 1) {
		diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
	}
	return diff === 0
}

/**
 * The upload ticket is the build's job token: it can add chunks to and seal
 * this one build, nothing else, and it is useless once the build is sealed
 * or expired. It grants no permission; publishing still needs the
 * publisher's own `package:write`.
 */
export async function authenticatePublishBuildTicket(input: {
	db: D1Database
	buildId: string
	ticket: string | null
	now?: number
}) {
	if (!input.ticket?.startsWith(ticketPrefix)) return null
	const row = await getPublishBuild(input.db, input.buildId)
	if (!row) return null
	if (!timingSafeEqualHex(await sha256Hex(input.ticket), row.ticket_sha256)) {
		return null
	}
	if (Date.parse(row.expires_at) <= (input.now ?? Date.now())) return null
	return row
}

export async function sealPublishBuild(input: {
	db: D1Database
	buildId: string
	document: PublishBuildDocument
}) {
	const result = await input.db
		.prepare(
			`UPDATE publish_builds
			SET status = 'sealed', document_json = ?, updated_at = ?
			WHERE id = ? AND status = 'uploading'`,
		)
		.bind(
			JSON.stringify(input.document),
			new Date().toISOString(),
			input.buildId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function finishPublishBuild(input: {
	db: D1Database
	buildId: string
	status: 'committed' | 'rejected'
	message?: string | null
}) {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`UPDATE publish_builds
			SET status = ?, message = ?, updated_at = ?,
				committed_at = CASE WHEN ? = 'committed' THEN ? ELSE committed_at END
			WHERE id = ? AND status IN ('sealed', 'committed')`,
		)
		.bind(
			input.status,
			input.message ?? null,
			now,
			input.status,
			now,
			input.buildId,
		)
		.run()
}

async function deletePublishBuildBlobs(bucket: R2Bucket, buildId: string) {
	let cursor: string | undefined
	do {
		const page = await bucket.list({
			prefix: publishBuildBlobPrefix(buildId),
			...(cursor ? { cursor } : {}),
		})
		const keys = page.objects.map((object) => object.key)
		if (keys.length > 0) await bucket.delete(keys)
		cursor = page.truncated ? page.cursor : undefined
	} while (cursor)
}

/**
 * Drops the chunks of builds whose ticket expired over a day ago (a
 * committed build's targets are already written by then). Committed rows
 * stay for their build origin (11B) with the manifest cleared; every other
 * row goes. Runs a few builds at a time whenever a build starts, so the
 * work tracks how many builds are made.
 */
export async function purgeExpiredPublishBuilds(input: {
	db: D1Database
	bucket: R2Bucket
	now?: number
	limit?: number
}) {
	const cutoff = new Date(
		(input.now ?? Date.now()) - publishBuildRetentionMs,
	).toISOString()
	const { results } = await input.db
		.prepare(
			`SELECT id, status FROM publish_builds
			WHERE expires_at < ?
				AND (status != 'committed' OR document_json IS NOT NULL)
			ORDER BY expires_at LIMIT ?`,
		)
		.bind(cutoff, input.limit ?? 10)
		.all<{ id: string; status: PublishBuildStatus }>()
	for (const row of results) {
		await deletePublishBuildBlobs(input.bucket, row.id)
		if (row.status === 'committed') {
			await input.db
				.prepare(
					`UPDATE publish_builds SET document_json = NULL, updated_at = ?
					WHERE id = ?`,
				)
				.bind(new Date().toISOString(), row.id)
				.run()
		} else {
			await input.db
				.prepare(
					`DELETE FROM publish_builds WHERE id = ? AND status != 'committed'`,
				)
				.bind(row.id)
				.run()
		}
	}
	return results.length
}

export function parsePublishBuildDocument(row: PublishBuildRow) {
	if (!row.document_json) return null
	return JSON.parse(row.document_json) as PublishBuildDocument
}

/** 11B: where the serving build of a commit was made, for package info. */
export async function getCommittedPublishBuildOrigin(input: {
	db: D1Database
	sourceId: string
	commit: string | null
}) {
	if (!input.commit) return null
	try {
		return await input.db
			.prepare(
				`SELECT origin, context_name FROM publish_builds
				WHERE source_id = ? AND commit_sha = ? AND status = 'committed'
				ORDER BY committed_at DESC LIMIT 1`,
			)
			.bind(input.sourceId, input.commit)
			.first<{ origin: PublishBuildOrigin; context_name: string | null }>()
	} catch {
		return null
	}
}

export async function isPackageCommunityListed(
	db: D1Database,
	packageId: string,
) {
	const row = await db
		.prepare(
			`SELECT 1 AS listed FROM community_listings
			WHERE ${communityListingPackageColumn} = ? AND status = 'active'
				AND deleted_at IS NULL
			LIMIT 1`,
		)
		.bind(packageId)
		.first<{ listed: number }>()
	return row != null
}

const communityListingPackageColumn = 'package_id'

function rejected(message: string) {
	return new McpCallerError(
		`Publish build rejected: ${message} ${publishBuildRejectionHint}`,
	)
}

/**
 * Commit-time gate for `packagePublishExternalPush({ publish_build_id })`:
 * the flag is on, the build belongs to this package, publisher and pushed
 * commit, and it is sealed. Its Kody package imports are linked and
 * checked when the upload is committed (6C).
 */
export async function resolveUploadedPublishBuildForPublish(input: {
	env: Env
	request: RequestContext | null | undefined
	buildId: string
	packageId: string
	sourceId: string
	commit: string
	requesterUserId: string
	orgId: string
}): Promise<UploadedPublishBuildRef> {
	if (
		!(await isPublishOffloadEnabledFor(
			input.env.APP_DB,
			input.requesterUserId,
			input.orgId,
		))
	) {
		throw new McpCallerError(
			'publish_build_id needs the publish-offload feature flag, which is off for this account. Publish without it to build on Kody cloud.',
		)
	}
	const row = await getPublishBuild(input.env.APP_DB, input.buildId)
	if (
		!row ||
		row.package_id !== input.packageId ||
		row.source_id !== input.sourceId ||
		row.requester_user_id !== input.requesterUserId
	) {
		throw rejected(`no publish build "${input.buildId}" for this package.`)
	}
	if (row.commit_sha !== input.commit) {
		throw rejected(
			`the build is for commit ${row.commit_sha.slice(0, 12)}, but the package repo HEAD is ${input.commit.slice(0, 12)}.`,
		)
	}
	if (row.status === 'uploading') {
		throw rejected('the upload was never sealed; finish uploading first.')
	}
	if (row.status === 'rejected') {
		throw rejected(row.message ?? 'this build already failed verification.')
	}
	const document = parsePublishBuildDocument(row)
	if (!document) throw rejected('the build has no sealed manifest.')
	return {
		buildId: row.id,
		communityListed: await isPackageCommunityListed(
			input.env.APP_DB,
			input.packageId,
		).catch(() => false),
		origin: row.origin,
		contextName: row.context_name,
	}
}
