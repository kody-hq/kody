import { sqlSourcesOf } from '@kody-internal/shared/state-machine.ts'
import { McpCallerError } from '#worker/mcp/caller-error.ts'
import {
	assertNever,
	reportHandledError,
} from '#worker/outbound/typed-failure.ts'
import {
	type DeadlineClock,
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import { isPublishOffloadEnabledFor } from './flag.ts'
import { sha256Hex } from './module-hashes.ts'
import { publishBuildState } from './publish-build-state.ts'
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
	document_sha256: string | null
	message: string | null
	created_at: string
	updated_at: string
	expires_at: string
	committed_at: string | null
}

const ticketPrefix = 'kpb_'
const sealGuard = sqlSourcesOf(publishBuildState, 'SEAL', ['uploading'])
const finishGuard = sqlSourcesOf(publishBuildState, 'COMMIT', [
	'sealed',
	'committed',
])

export function publishBuildBlobKey(buildId: string, sha256: string) {
	return `publish-builds/${buildId}/${sha256}`
}

export function publishBuildBlobPrefix(buildId: string) {
	return `publish-builds/${buildId}/`
}

/**
 * The sealed build document lives in R2, not D1: a large package's file and
 * module manifest outgrows the D1 import statement limit (see
 * backup-restore-safety.ts) and would make the APP_DB backup unrestorable.
 */
export function publishBuildDocumentKey(buildId: string, sha256: string) {
	return `${publishBuildDocumentPrefix(buildId)}${sha256}.json`
}

function publishBuildDocumentPrefix(buildId: string) {
	return `publish-build-documents/${buildId}/`
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
	clock?: DeadlineClock
}) {
	const now = input.now ?? Date.now()
	const id = `pb_${randomToken(12)}`
	const ticket = `${ticketPrefix}${randomToken()}`
	const nowIso = new Date(now).toISOString()
	const expiresAt = new Date(now + publishBuildTicketTtlMs).toISOString()
	const ticketSha256 = await sha256Hex(ticket)
	await withDeadline(
		{
			label: 'publish_builds.insert',
			timeoutMs: outboundTimeoutMs.d1,
			clock: input.clock,
		},
		() =>
			input.db
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
					ticketSha256,
					nowIso,
					nowIso,
					expiresAt,
				)
				.run(),
	)
	return { buildId: id, ticket, expiresAt }
}

/** Drops a build nothing took (the chain ended in Kody cloud). */
export async function discardUnstartedPublishBuild(
	db: D1Database,
	buildId: string,
) {
	await withDeadline(
		{ label: 'publish_builds.discard', timeoutMs: outboundTimeoutMs.d1 },
		() =>
			db
				.prepare(
					`DELETE FROM publish_builds WHERE id = ? AND status = 'uploading'`,
				)
				.bind(buildId)
				.run(),
	)
}

export async function getPublishBuild(
	db: D1Database,
	buildId: string,
	clock?: DeadlineClock,
) {
	return await withDeadline(
		{ label: 'publish_builds.get', timeoutMs: outboundTimeoutMs.d1, clock },
		() =>
			db
				.prepare(`SELECT * FROM publish_builds WHERE id = ?`)
				.bind(buildId)
				.first<PublishBuildRow>(),
	)
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
	clock?: DeadlineClock
}) {
	if (!input.ticket?.startsWith(ticketPrefix)) return null
	const row = await getPublishBuild(input.db, input.buildId, input.clock)
	if (!row) return null
	if (!timingSafeEqualHex(await sha256Hex(input.ticket), row.ticket_sha256)) {
		return null
	}
	if (Date.parse(row.expires_at) <= (input.now ?? Date.now())) return null
	return row
}

export async function sealPublishBuild(input: {
	db: D1Database
	bucket: R2Bucket
	buildId: string
	document: PublishBuildDocument
	clock?: DeadlineClock
}) {
	const body = JSON.stringify(input.document)
	const sha256 = await sha256Hex(body)
	await withDeadline(
		{
			label: 'publish_build_document.put',
			timeoutMs: outboundTimeoutMs.r2,
			clock: input.clock,
		},
		() =>
			input.bucket.put(publishBuildDocumentKey(input.buildId, sha256), body, {
				httpMetadata: { contentType: 'application/json' },
			}),
	)
	const result = await withDeadline(
		{
			label: 'publish_builds.seal',
			timeoutMs: outboundTimeoutMs.d1,
			clock: input.clock,
		},
		() =>
			input.db
				.prepare(
					`UPDATE publish_builds
					SET status = 'sealed', document_sha256 = ?, updated_at = ?
					WHERE id = ? AND status IN ${sealGuard}`,
				)
				.bind(sha256, new Date().toISOString(), input.buildId)
				.run(),
	)
	return (result.meta.changes ?? 0) > 0
}

export async function finishPublishBuild(input: {
	db: D1Database
	buildId: string
	status: 'committed' | 'rejected'
	message?: string | null
}) {
	const now = new Date().toISOString()
	await withDeadline(
		{ label: 'publish_builds.finish', timeoutMs: outboundTimeoutMs.d1 },
		() =>
			input.db
				.prepare(
					`UPDATE publish_builds
					SET status = ?, message = ?, updated_at = ?,
						committed_at = CASE WHEN ? = 'committed' THEN ? ELSE committed_at END
					WHERE id = ? AND status IN ${finishGuard}`,
				)
				.bind(
					input.status,
					input.message ?? null,
					now,
					input.status,
					now,
					input.buildId,
				)
				.run(),
	)
}

async function deletePrefix(bucket: R2Bucket, prefix: string) {
	let cursor: string | undefined
	do {
		const page = await withDeadline(
			{ label: 'publish_build_blobs.list', timeoutMs: outboundTimeoutMs.r2 },
			() => bucket.list({ prefix, ...(cursor ? { cursor } : {}) }),
		)
		const keys = page.objects.map((object) => object.key)
		if (keys.length > 0) {
			await withDeadline(
				{
					label: 'publish_build_blobs.delete',
					timeoutMs: outboundTimeoutMs.r2,
				},
				() => bucket.delete(keys),
			)
		}
		cursor = page.truncated ? page.cursor : undefined
	} while (cursor)
}

async function deletePublishBuildBlobs(bucket: R2Bucket, buildId: string) {
	await deletePrefix(bucket, publishBuildBlobPrefix(buildId))
	await deletePrefix(bucket, publishBuildDocumentPrefix(buildId))
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
	const { results } = await withDeadline(
		{ label: 'publish_builds.list_expired', timeoutMs: outboundTimeoutMs.d1 },
		() =>
			input.db
				.prepare(
					`SELECT id, status FROM publish_builds
					WHERE expires_at < ?
						AND (status != 'committed' OR document_sha256 IS NOT NULL)
					ORDER BY expires_at LIMIT ?`,
				)
				.bind(cutoff, input.limit ?? 10)
				.all<{ id: string; status: PublishBuildStatus }>(),
	)
	for (const row of results) {
		await deletePublishBuildBlobs(input.bucket, row.id)
		if (row.status === 'committed') {
			await withDeadline(
				{
					label: 'publish_builds.clear_manifest',
					timeoutMs: outboundTimeoutMs.d1,
				},
				() =>
					input.db
						.prepare(
							`UPDATE publish_builds SET document_sha256 = NULL, updated_at = ?
							WHERE id = ?`,
						)
						.bind(new Date().toISOString(), row.id)
						.run(),
			)
		} else {
			await withDeadline(
				{
					label: 'publish_builds.delete_expired',
					timeoutMs: outboundTimeoutMs.d1,
				},
				() =>
					input.db
						.prepare(
							`DELETE FROM publish_builds WHERE id = ? AND status != 'committed'`,
						)
						.bind(row.id)
						.run(),
			)
		}
	}
	return results.length
}

export async function readPublishBuildDocument(input: {
	bucket: R2Bucket
	row: Pick<PublishBuildRow, 'id' | 'document_sha256'>
}) {
	const sha256 = input.row.document_sha256
	if (!sha256) return null
	const text = await withDeadline(
		{ label: 'publish_build_document.get', timeoutMs: outboundTimeoutMs.r2 },
		async () => {
			const object = await input.bucket.get(
				publishBuildDocumentKey(input.row.id, sha256),
			)
			return object ? await object.text() : null
		},
	)
	if (text === null) return null
	return JSON.parse(text) as PublishBuildDocument
}

/** 11B: where the serving build of a commit was made, for package info. */
export async function getCommittedPublishBuildOrigin(input: {
	db: D1Database
	sourceId: string
	commit: string | null
}) {
	const commit = input.commit
	if (!commit) return null
	try {
		return await withDeadline(
			{
				label: 'publish_builds.committed_origin',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				input.db
					.prepare(
						`SELECT origin, context_name FROM publish_builds
						WHERE source_id = ? AND commit_sha = ? AND status = 'committed'
						ORDER BY committed_at DESC LIMIT 1`,
					)
					.bind(input.sourceId, commit)
					.first<{ origin: PublishBuildOrigin; context_name: string | null }>(),
		)
	} catch (error) {
		// Package info shows the build origin only when it can read it.
		reportHandledError('publish_builds.committed_origin', error)
		return null
	}
}

/** Why the commit-time gate refuses a publish build. */
export type UploadedPublishBuildFailure =
	| { kind: 'offload_disabled' }
	| { kind: 'not_found'; buildId: string }
	| { kind: 'commit_mismatch'; buildCommit: string; headCommit: string }
	| { kind: 'not_sealed' }
	| { kind: 'already_rejected'; message: string | null }
	| { kind: 'no_manifest' }

function rejected(message: string) {
	return new McpCallerError(
		`Publish build rejected: ${message} ${publishBuildRejectionHint}`,
	)
}

export function mapUploadedPublishBuildFailure(
	failure: UploadedPublishBuildFailure,
): McpCallerError {
	switch (failure.kind) {
		case 'offload_disabled':
			return new McpCallerError(
				'publish_build_id needs the publish-offload feature flag, which is off for this account. Publish without it to build on Kody cloud.',
			)
		case 'not_found':
			return rejected(`no publish build "${failure.buildId}" for this package.`)
		case 'commit_mismatch':
			return rejected(
				`the build is for commit ${failure.buildCommit.slice(0, 12)}, but the package repo HEAD is ${failure.headCommit.slice(0, 12)}.`,
			)
		case 'not_sealed':
			return rejected('the upload was never sealed; finish uploading first.')
		case 'already_rejected':
			return rejected(
				failure.message ?? 'this build already failed verification.',
			)
		case 'no_manifest':
			return rejected('the build has no sealed manifest.')
		default:
			return assertNever(failure, 'uploaded publish build failure')
	}
}

/**
 * Commit-time gate for `packagePublishExternalPush({ publish_build_id })`:
 * the flag is on, the build belongs to this package, publisher and pushed
 * commit, and it is sealed. Durable publish runs on the runtime Worker,
 * which doesn't have the upload bucket. RepoSession reads and verifies the
 * sealed document and links its Kody package imports before serving.
 */
export async function resolveUploadedPublishBuildForPublish(input: {
	db: D1Database
	buildId: string
	packageId: string
	sourceId: string
	commit: string
	requesterUserId: string
	orgId: string
}): Promise<UploadedPublishBuildRef> {
	const checked = await checkUploadedPublishBuild(input)
	if ('kind' in checked) throw mapUploadedPublishBuildFailure(checked)
	return checked
}

async function checkUploadedPublishBuild(input: {
	db: D1Database
	buildId: string
	packageId: string
	sourceId: string
	commit: string
	requesterUserId: string
	orgId: string
}): Promise<UploadedPublishBuildRef | UploadedPublishBuildFailure> {
	if (
		!(await isPublishOffloadEnabledFor(
			input.db,
			input.requesterUserId,
			input.orgId,
		))
	) {
		return { kind: 'offload_disabled' }
	}
	const row = await getPublishBuild(input.db, input.buildId)
	if (
		!row ||
		row.package_id !== input.packageId ||
		row.source_id !== input.sourceId ||
		row.requester_user_id !== input.requesterUserId
	) {
		return { kind: 'not_found', buildId: input.buildId }
	}
	if (row.commit_sha !== input.commit) {
		return {
			kind: 'commit_mismatch',
			buildCommit: row.commit_sha,
			headCommit: input.commit,
		}
	}
	if (row.status === 'uploading') return { kind: 'not_sealed' }
	if (row.status === 'rejected') {
		return { kind: 'already_rejected', message: row.message }
	}
	if (!row.document_sha256) return { kind: 'no_manifest' }
	return {
		buildId: row.id,
		origin: row.origin,
		contextName: row.context_name,
	}
}
