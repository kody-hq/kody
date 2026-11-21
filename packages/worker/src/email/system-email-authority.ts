import { Effect, Option, Schema } from 'effect'
import {
	type D1,
	type DatabaseError,
	fromD1Promise,
	sql,
} from '#worker/effect/d1.ts'
import { systemEmailOwnerId } from './email-owner.ts'

type SystemEmailAuthorityRow = {
	authority: string
	graph_mismatch_count: number
	provider_link_count: number
}

const unsupportedSystemProviderLinksSql = `(
	EXISTS (
		SELECT 1
		FROM email_outbound_provider_index provider_index
		WHERE provider_index.user_id = '${systemEmailOwnerId}'
	)
	OR EXISTS (
		SELECT 1
		FROM system_email_messages dedicated_message
		WHERE dedicated_message.provider_message_id IS NOT NULL
	)
)`

export async function assertSystemEmailGraphAuthority(db: D1Database) {
	const marker = await db
		.prepare(
			`SELECT authority, graph_mismatch_count, provider_link_count
			FROM system_email_graph_authority
			WHERE singleton = 1
			LIMIT 1`,
		)
		.first<SystemEmailAuthorityRow>()
	if (
		marker?.authority !== 'dedicated' ||
		Number(marker.graph_mismatch_count) !== 0 ||
		Number(marker.provider_link_count) !== 0
	) {
		throw new Error(
			'System email dedicated authority marker is missing or invalid.',
		)
	}
	const providerLinks = await db
		.prepare(`SELECT ${unsupportedSystemProviderLinksSql} AS unsupported`)
		.first<{ unsupported: number }>()
	if (Number(providerLinks?.unsupported ?? 1) !== 0) {
		throw new Error(
			'System email dedicated authority refuses unsupported provider links.',
		)
	}
}

/**
 * Transaction-local authority and provider gate. The SELECT emits singleton 2
 * only when the cutover invariant is broken; the marker CHECK then aborts and
 * rolls back the entire D1 batch.
 */
export function systemEmailAuthorityGuardStatement(db: D1Database) {
	return db.prepare(
		`INSERT INTO system_email_graph_authority (
			singleton, authority, cutover_at, graph_mismatch_count,
			provider_link_count
		)
		SELECT 2, 'dedicated', CURRENT_TIMESTAMP, 0, 0
		WHERE NOT EXISTS (
			SELECT 1
			FROM system_email_graph_authority
			WHERE singleton = 1
				AND authority = 'dedicated'
				AND graph_mismatch_count = 0
				AND provider_link_count = 0
		)
		OR ${unsupportedSystemProviderLinksSql}`,
	)
}

/**
 * Commit dedicated system-email statements with the authority/provider gate in
 * the same D1 batch. The final guard result is intentionally not exposed.
 */
export async function commitSystemEmailAuthorityBatch(input: {
	db: D1Database
	statements: ReadonlyArray<D1PreparedStatement>
}) {
	const results = await input.db.batch([
		...input.statements,
		systemEmailAuthorityGuardStatement(input.db),
	])
	return results.slice(0, input.statements.length)
}

/** The dedicated system-email authority marker or provider gate refused. */
export class SystemEmailAuthorityError extends Schema.TaggedError<SystemEmailAuthorityError>()(
	'SystemEmailAuthorityError',
	{ message: Schema.String },
) {}

const AuthorityRow = Schema.Struct({
	authority: Schema.String,
	graph_mismatch_count: Schema.Number,
	provider_link_count: Schema.Number,
})
const UnsupportedRow = Schema.Struct({ unsupported: Schema.Number })

export const assertSystemEmailGraphAuthorityEffect = Effect.fn(
	'SystemEmailAuthority.assert',
)(function* (
	d1: D1['Service'],
): Effect.fn.Return<void, DatabaseError | SystemEmailAuthorityError> {
	const marker = yield* d1.first(
		'system_email_graph_authority.read',
		AuthorityRow,
		sql(
			`SELECT authority, graph_mismatch_count, provider_link_count
			FROM system_email_graph_authority
			WHERE singleton = 1
			LIMIT 1`,
		),
	)
	if (
		Option.isNone(marker) ||
		marker.value.authority !== 'dedicated' ||
		marker.value.graph_mismatch_count !== 0 ||
		marker.value.provider_link_count !== 0
	) {
		return yield* new SystemEmailAuthorityError({
			message: 'System email dedicated authority marker is missing or invalid.',
		})
	}
	const providerLinks = yield* d1.first(
		'system_email_graph_authority.provider_links',
		UnsupportedRow,
		sql(`SELECT ${unsupportedSystemProviderLinksSql} AS unsupported`),
	)
	if (
		Option.match(providerLinks, {
			onNone: () => 1,
			onSome: (row) => row.unsupported,
		}) !== 0
	) {
		return yield* new SystemEmailAuthorityError({
			message:
				'System email dedicated authority refuses unsupported provider links.',
		})
	}
})

/** `commitSystemEmailAuthorityBatch` with a typed D1 failure and deadline. */
export const commitSystemEmailAuthorityBatchEffect = (input: {
	db: D1Database
	statements: ReadonlyArray<D1PreparedStatement>
}) =>
	fromD1Promise('system_email.authority_batch', () =>
		commitSystemEmailAuthorityBatch(input),
	).pipe(Effect.map((results) => results.map((r) => r.meta?.changes ?? 0)))
