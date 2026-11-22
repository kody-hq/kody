import { sqlSourcesOf } from '@kody-internal/shared/state-machine.ts'
import { Clock, Effect, Option, Schema } from 'effect'
import { D1, sql } from '#worker/effect/d1.ts'
import { digestSha256Hex } from './digest.ts'
import {
	PublishBuildDocumentUnreadable,
	PublishBuildRejected,
	PublishBuildTicketInvalid,
	PublishOffloadDisabled,
} from './errors.ts'
import { isPublishOffloadEnabledFor } from './flag.ts'
import { publishBuildState } from './publish-build-state.ts'
import {
	publishBuildLeaseMs,
	publishBuildMaxLeaseMs,
	publishBuildRetentionMs,
	type PublishBuildOrigin,
} from './policy.ts'
import * as Schemas from './schemas.ts'
import { PublishBuildBucket } from './services.ts'
import type { PublishBuildDocument, UploadedPublishBuildRef } from './types.ts'

export type { UploadedPublishBuildRef } from './types.ts'

export type PublishBuildRow = typeof Schemas.PublishBuildRow.Type

const ticketPrefix = 'kpb_'
const sealGuard = sqlSourcesOf(publishBuildState, 'SEAL', ['uploading'])
const abandonGuard = sqlSourcesOf(publishBuildState, 'ABANDON', ['uploading'])
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

const randomToken = (bytes = 32) =>
	Effect.sync(() =>
		Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join(''),
	)

const nowIso = Effect.map(Clock.currentTimeMillis, (now) =>
	new Date(now).toISOString(),
)

export type CreatedPublishBuild = {
	readonly buildId: string
	readonly ticket: string
	readonly expiresAt: string
}

export const createPublishBuild = Effect.fn('PublishBuildStore.create')(
	function* (input: {
		packageId: string
		sourceId: string
		ownerUserId: string
		requesterUserId: string
		orgId: string
		commit: string
		origin: Exclude<PublishBuildOrigin, 'cloud'>
		contextId?: string | null
		contextName?: string | null
	}) {
		const db = yield* D1
		const now = yield* Clock.currentTimeMillis
		const id = `pb_${yield* randomToken(12)}`
		const ticket = `${ticketPrefix}${yield* randomToken()}`
		const createdAt = new Date(now).toISOString()
		const expiresAt = new Date(now + publishBuildLeaseMs).toISOString()
		yield* db.run(
			'publish_builds.create',
			sql(
				`INSERT INTO publish_builds (
				id, package_id, source_id, owner_user_id, requester_user_id, org_id,
				commit_sha, origin, context_id, context_name, ticket_sha256, status,
				created_at, updated_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
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
				yield* digestSha256Hex(ticket),
				createdAt,
				createdAt,
				expiresAt,
			),
		)
		const created: CreatedPublishBuild = { buildId: id, ticket, expiresAt }
		return created
	},
)

/** Drops a build nothing took (the chain ended in Kody cloud). */
export const discardUnstartedPublishBuild = Effect.fn(
	'PublishBuildStore.discardUnstarted',
)(function* (buildId: string) {
	const db = yield* D1
	yield* db.run(
		'publish_builds.discard_unstarted',
		sql(
			`DELETE FROM publish_builds WHERE id = ? AND status = 'uploading'`,
			buildId,
		),
	)
})

export const getPublishBuild = Effect.fn('PublishBuildStore.get')(function* (
	buildId: string,
) {
	const db = yield* D1
	return yield* db.first(
		'publish_builds.get',
		Schemas.PublishBuildRow,
		sql(`SELECT * FROM publish_builds WHERE id = ?`, buildId),
	)
})

function timingSafeEqualHex(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let index = 0; index < a.length; index += 1) {
		diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
	}
	return diff === 0
}

/**
 * The upload ticket is the build's job token: it can add chunks to, seal or
 * abandon this one build, nothing else, and it is useless once the build is
 * sealed, abandoned or its lease expired. It grants no permission;
 * publishing still needs the publisher's own `package:write`.
 * `allowAbandoned` lets a repeated abandon find its build and answer the same.
 */
export const authenticatePublishBuildTicket = Effect.fn(
	'PublishBuildStore.authenticateTicket',
)(function* (input: {
	buildId: string
	ticket: string | null
	allowAbandoned?: boolean
}) {
	const ticket = input.ticket
	if (!ticket?.startsWith(ticketPrefix)) {
		return yield* new PublishBuildTicketInvalid()
	}
	const found = yield* getPublishBuild(input.buildId)
	if (Option.isNone(found)) return yield* new PublishBuildTicketInvalid()
	const row = found.value
	if (!timingSafeEqualHex(yield* digestSha256Hex(ticket), row.ticket_sha256)) {
		return yield* new PublishBuildTicketInvalid()
	}
	if (row.status === 'abandoned') {
		if (input.allowAbandoned) return row
		return yield* new PublishBuildTicketInvalid()
	}
	if (Date.parse(row.expires_at) <= (yield* Clock.currentTimeMillis)) {
		return yield* new PublishBuildTicketInvalid()
	}
	return row
})

/**
 * Renews the upload lease to `publishBuildLeaseMs` from now, capped at
 * `publishBuildMaxLeaseMs` after the build started. Never shortens a lease.
 * Returns the lease's expiry.
 */
export const renewPublishBuildLease = Effect.fn('PublishBuildStore.renewLease')(
	function* (row: Pick<PublishBuildRow, 'id' | 'created_at' | 'expires_at'>) {
		const db = yield* D1
		const now = yield* Clock.currentTimeMillis
		const renewed = new Date(
			Math.min(
				now + publishBuildLeaseMs,
				Date.parse(row.created_at) + publishBuildMaxLeaseMs,
			),
		).toISOString()
		if (renewed <= row.expires_at) return row.expires_at
		yield* db.run(
			'publish_builds.renew_lease',
			sql(
				`UPDATE publish_builds SET expires_at = ?
			WHERE id = ? AND status != 'abandoned' AND expires_at < ?`,
				renewed,
				row.id,
				renewed,
			),
		)
		return renewed
	},
)

/** Stores the document and seals the build; false when it was not uploading. */
export const sealPublishBuild = Effect.fn('PublishBuildStore.seal')(
	function* (input: { buildId: string; document: PublishBuildDocument }) {
		const db = yield* D1
		const bucket = yield* PublishBuildBucket
		const body = JSON.stringify(input.document)
		const sha256 = yield* digestSha256Hex(body)
		yield* bucket.put(publishBuildDocumentKey(input.buildId, sha256), body, {
			httpMetadata: { contentType: 'application/json' },
		})
		const result = yield* db.run(
			'publish_builds.seal',
			sql(
				`UPDATE publish_builds
			SET status = 'sealed', document_sha256 = ?, updated_at = ?
			WHERE id = ? AND status IN ${sealGuard}`,
				sha256,
				yield* nowIso,
				input.buildId,
			),
		)
		return result.changes > 0
	},
)

export const finishPublishBuild = Effect.fn('PublishBuildStore.finish')(
	function* (input: {
		buildId: string
		status: 'committed' | 'rejected'
		message?: string | null
	}) {
		const db = yield* D1
		const now = yield* nowIso
		yield* db.run(
			'publish_builds.finish',
			sql(
				`UPDATE publish_builds
			SET status = ?, message = ?, updated_at = ?,
				committed_at = CASE WHEN ? = 'committed' THEN ? ELSE committed_at END
			WHERE id = ? AND status IN ${finishGuard}`,
				input.status,
				input.message ?? null,
				now,
				input.status,
				now,
				input.buildId,
			),
		)
	},
)

const deletePrefix = Effect.fnUntraced(function* (prefix: string) {
	const bucket = yield* PublishBuildBucket
	let cursor: string | undefined
	do {
		const page = yield* bucket.listPage(prefix, cursor)
		if (page.keys.length > 0) yield* bucket.delete(page.keys)
		cursor = page.cursor
	} while (cursor)
})

/**
 * Abandons an uploading build: the ticket stops working and the lease ends
 * now, so the expired-build sweep counts its retention from here. Then drops
 * the uploaded chunks; chunks a failed delete leaves behind go with that
 * sweep. False when the build was not uploading.
 */
export const abandonPublishBuild = Effect.fn('PublishBuildStore.abandon')(
	function* (buildId: string) {
		const db = yield* D1
		const now = yield* nowIso
		const result = yield* db.run(
			'publish_builds.abandon',
			sql(
				`UPDATE publish_builds
			SET status = 'abandoned', updated_at = ?, expires_at = ?
			WHERE id = ? AND status IN ${abandonGuard}`,
				now,
				now,
				buildId,
			),
		)
		if (result.changes === 0) return false
		yield* deletePrefix(publishBuildBlobPrefix(buildId)).pipe(
			Effect.catchTag('OutboundCallError', (error) =>
				Effect.logDebug('publish_build_abandon_delete_failed', {
					buildId,
					message: error.message,
				}),
			),
		)
		return true
	},
)

const ExpiredBuildRow = Schema.Struct({
	id: Schema.String,
	status: Schemas.PublishBuildStatus,
})

/**
 * Drops the chunks of builds whose ticket expired over a day ago (a
 * committed build's targets are already written by then). Committed rows
 * stay for their build origin (11B) with the manifest cleared; every other
 * row (rejected, abandoned, or never sealed) goes. Runs a few builds at a
 * time whenever a build starts, so the work tracks how many builds are made.
 */
export const purgeExpiredPublishBuilds = Effect.fn(
	'PublishBuildStore.purgeExpired',
)(function* (input: { limit?: number } = {}) {
	const db = yield* D1
	const cutoff = new Date(
		(yield* Clock.currentTimeMillis) - publishBuildRetentionMs,
	).toISOString()
	const rows = yield* db.all(
		'publish_builds.list_expired',
		ExpiredBuildRow,
		sql(
			`SELECT id, status FROM publish_builds
			WHERE expires_at < ?
				AND (status != 'committed' OR document_sha256 IS NOT NULL)
			ORDER BY expires_at LIMIT ?`,
			cutoff,
			input.limit ?? 10,
		),
	)
	for (const row of rows) {
		yield* deletePrefix(publishBuildBlobPrefix(row.id))
		yield* deletePrefix(publishBuildDocumentPrefix(row.id))
		if (row.status === 'committed') {
			yield* db.run(
				'publish_builds.clear_document',
				sql(
					`UPDATE publish_builds SET document_sha256 = NULL, updated_at = ?
					WHERE id = ?`,
					yield* nowIso,
					row.id,
				),
			)
		} else {
			yield* db.run(
				'publish_builds.delete_expired',
				sql(
					`DELETE FROM publish_builds WHERE id = ? AND status != 'committed'`,
					row.id,
				),
			)
		}
	}
	return rows.length
})

export const readPublishBuildDocument = Effect.fn(
	'PublishBuildStore.readDocument',
)(function* (input: { row: Pick<PublishBuildRow, 'id' | 'document_sha256'> }) {
	if (!input.row.document_sha256) return null
	const bucket = yield* PublishBuildBucket
	const text = yield* bucket.getText(
		publishBuildDocumentKey(input.row.id, input.row.document_sha256),
	)
	if (text === null) return null
	return yield* Schema.decodeUnknownEffect(Schemas.PublishBuildDocumentJson)(
		text,
	).pipe(
		Effect.mapError(
			(cause) =>
				new PublishBuildDocumentUnreadable({
					buildId: input.row.id,
					message: cause.message,
				}),
		),
	)
})

const CommittedOriginRow = Schema.Struct({
	origin: Schemas.PublishBuildOrigin,
	context_name: Schema.NullOr(Schema.String),
})

/** 11B: where the serving build of a commit was made, for package info. */
export const getCommittedPublishBuildOrigin = Effect.fn(
	'PublishBuildStore.committedOrigin',
)(function* (input: { sourceId: string; commit: string | null }) {
	if (!input.commit) return null
	const db = yield* D1
	return yield* db
		.first(
			'publish_builds.committed_origin',
			CommittedOriginRow,
			sql(
				`SELECT origin, context_name FROM publish_builds
				WHERE source_id = ? AND commit_sha = ? AND status = 'committed'
				ORDER BY committed_at DESC LIMIT 1`,
				input.sourceId,
				input.commit,
			),
		)
		.pipe(
			Effect.map(Option.getOrNull),
			Effect.catchTag('DatabaseError', (error) =>
				Effect.as(
					Effect.logDebug('publish_build_origin_read_failed', {
						message: error.message,
					}),
					null,
				),
			),
		)
})

const rejected = (reason: string) => new PublishBuildRejected({ reason })

const { fields } = Schemas.PublishBuildRow
/** The columns the commit-time gate reads. */
const PublishBuildGateRow = Schema.Struct({
	id: fields.id,
	package_id: fields.package_id,
	source_id: fields.source_id,
	requester_user_id: fields.requester_user_id,
	commit_sha: fields.commit_sha,
	status: fields.status,
	document_sha256: fields.document_sha256,
	message: fields.message,
	origin: fields.origin,
	context_name: fields.context_name,
})

/**
 * Commit-time gate for `packagePublishExternalPush({ publish_build_id })`:
 * the flag is on, the build belongs to this package, publisher and pushed
 * commit, and it is sealed. Durable publish runs on the runtime Worker,
 * which doesn't have the upload bucket. RepoSession reads and verifies the
 * sealed document and links its Kody package imports before serving.
 */
export const resolveUploadedPublishBuildForPublish = Effect.fn(
	'PublishBuildStore.resolveForPublish',
)(function* (input: {
	buildId: string
	packageId: string
	sourceId: string
	commit: string
	requesterUserId: string
	orgId: string
}) {
	if (
		!(yield* isPublishOffloadEnabledFor(input.requesterUserId, input.orgId))
	) {
		return yield* new PublishOffloadDisabled({
			message:
				'publish_build_id needs the publish-offload feature flag, which is off for this account. Publish without it to build on Kody cloud.',
		})
	}
	const db = yield* D1
	const found = yield* db.first(
		'publish_builds.get_for_publish',
		PublishBuildGateRow,
		sql(
			`SELECT ${Object.keys(PublishBuildGateRow.fields).join(', ')}
			FROM publish_builds WHERE id = ?`,
			input.buildId,
		),
	)
	const row = Option.getOrUndefined(found)
	if (
		!row ||
		row.package_id !== input.packageId ||
		row.source_id !== input.sourceId ||
		row.requester_user_id !== input.requesterUserId
	) {
		return yield* rejected(
			`no publish build "${input.buildId}" for this package.`,
		)
	}
	if (row.commit_sha !== input.commit) {
		return yield* rejected(
			`the build is for commit ${row.commit_sha.slice(0, 12)}, but the package repo HEAD is ${input.commit.slice(0, 12)}.`,
		)
	}
	if (row.status === 'uploading') {
		return yield* rejected(
			'the upload was never sealed; finish uploading first.',
		)
	}
	if (row.status === 'rejected') {
		return yield* rejected(
			row.message ?? 'this build already failed verification.',
		)
	}
	if (row.status === 'abandoned') {
		return yield* rejected(
			'the upload was abandoned before it was sealed; start a new build.',
		)
	}
	if (!row.document_sha256) {
		return yield* rejected('the build has no sealed manifest.')
	}
	const ref: UploadedPublishBuildRef = {
		buildId: row.id,
		origin: row.origin,
		contextName: row.context_name,
	}
	return ref
})
