/**
 * Login sessions persisted across isolates and runs (ADR 0068, 2026-10-29).
 * The session token is encrypted with its own purpose and bound to the
 * credential id and revision, so an edit to the value, exchange, hosts, or
 * inject strands it. One exchange runs at a time per credential: the caller
 * that wins the D1 lease runs it and writes the session; the others poll and
 * reuse that session, so a rotating provider never sees one refresh token
 * twice. A crashed holder's lease lapses after `leaseMs`. Credential ids are
 * global, so a claim re-points `user_id` after an org transfer; the old
 * owner's ciphertext is bound to that owner and never decrypts for the new one.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	decryptLoginCredentialSession,
	encryptLoginCredentialSession,
	loginCredentialSessionContext,
} from '#mcp/secrets/crypto.ts'
import { CredentialLoginFailedError } from './credential-request.ts'

/**
 * A replacement login value the exchange returned (a rotated refresh token):
 * `valueStatement` writes it only while the credential is unchanged, and the
 * session is stored under `revision` only when that write landed.
 */
/** The credential changed after the caller read it; re-read and retry. */
export class StaleLoginCredentialError extends Error {
	constructor() {
		super('The login credential changed while waiting for its session.')
		this.name = 'StaleLoginCredentialError'
	}
}

export type LoginValueReplacement = {
	valueStatement: D1PreparedStatement
	credentialId: string
	encryptedValue: string
	revision: string
}

/** `expiresAt` is null when the response says the token is already expired. */
export type LoginSession = {
	token: string
	expiresAt: number | null
	replacement?: LoginValueReplacement
}

export type ObtainedLoginSession = {
	session: LoginSession
	source: 'stored' | 'new'
	/** Null when the session was not stored (already expired). */
	sessionId: string | null
	/** Whether a replacement login value from the exchange was saved. */
	valueReplaced: boolean
}

export type StoredLoginSession = {
	sessionId: string
	token: string
	expiresAt: number
}

type SessionEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>

type SessionKey = {
	ownerId: OwnerId
	credentialId: string
	revision: string
}

const defaultLeaseMs = 60_000
const defaultPollMs = 250

export async function readStoredLoginSession(
	input: SessionKey & { env: SessionEnv; now?: number },
): Promise<StoredLoginSession | null> {
	const row = await input.env.APP_DB.prepare(
		`SELECT revision, session_id, session_encrypted, expires_at
		FROM login_credential_sessions
		WHERE credential_id = ? AND user_id = ?`,
	)
		.bind(input.credentialId, input.ownerId)
		.first<{
			revision: string | null
			session_id: string | null
			session_encrypted: string | null
			expires_at: number | null
		}>()
	if (
		!row ||
		row.revision !== input.revision ||
		!row.session_id ||
		!row.session_encrypted ||
		row.expires_at === null ||
		row.expires_at <= (input.now ?? Date.now())
	) {
		return null
	}
	try {
		const token = await decryptLoginCredentialSession(
			input.env,
			row.session_encrypted,
			loginCredentialSessionContext(input),
		)
		return { sessionId: row.session_id, token, expiresAt: row.expires_at }
	} catch {
		return null
	}
}

/** The credential still exists, undeleted, under this owner. */
const liveCredentialSql = `SELECT 1 FROM secret_entries AS e
	JOIN secret_buckets AS b ON b.id = e.bucket_id
	WHERE e.id = ? AND b.user_id = ?
		AND e.deleted_at IS NULL AND b.deleted_at IS NULL`

async function credentialIsLive(db: D1Database, input: SessionKey) {
	const row = await db
		.prepare(liveCredentialSql)
		.bind(input.credentialId, input.ownerId)
		.first()
	return row !== null
}

async function claimLease(
	input: SessionKey & {
		db: D1Database
		leaseId: string
		now: number
		leaseMs: number
	},
) {
	const result = await input.db
		.prepare(
			`INSERT INTO login_credential_sessions
				(credential_id, user_id, lease_id, lease_expires_at, updated_at)
			SELECT ?, ?, ?, ?, ?
			WHERE EXISTS (${liveCredentialSql})
			ON CONFLICT (credential_id) DO UPDATE SET
				user_id = excluded.user_id,
				lease_id = excluded.lease_id,
				lease_expires_at = excluded.lease_expires_at,
				updated_at = excluded.updated_at
			WHERE login_credential_sessions.lease_id IS NULL
				OR login_credential_sessions.lease_expires_at IS NULL
				OR login_credential_sessions.lease_expires_at <= ?`,
		)
		.bind(
			input.credentialId,
			input.ownerId,
			input.leaseId,
			input.now + input.leaseMs,
			new Date(input.now).toISOString(),
			input.credentialId,
			input.ownerId,
			input.now,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

async function releaseLease(
	db: D1Database,
	credentialId: string,
	leaseId: string,
) {
	await db
		.prepare(
			`UPDATE login_credential_sessions
			SET lease_id = NULL, lease_expires_at = NULL
			WHERE credential_id = ? AND lease_id = ?`,
		)
		.bind(credentialId, leaseId)
		.run()
}

/**
 * Writes the session only while `leaseId` still holds the lease. With a
 * replacement value, the value write and the session write run in one batch,
 * and the session lands only when the value write did.
 */
async function writeSessionUnderLease(
	input: SessionKey & {
		env: SessionEnv
		leaseId: string
		session: LoginSession
	},
): Promise<{ sessionId: string | null; valueReplaced: boolean }> {
	const db = input.env.APP_DB
	const { replacement, expiresAt } = input.session
	const revision = replacement?.revision ?? input.revision
	const sessionId = expiresAt === null ? null : crypto.randomUUID()
	const encrypted =
		expiresAt === null
			? null
			: await encryptLoginCredentialSession(
					input.env,
					input.session.token,
					loginCredentialSessionContext({ ...input, revision }),
				)
	const guard = replacement
		? `AND EXISTS (SELECT 1 FROM secret_entries WHERE id = ? AND encrypted_value = ?)`
		: ''
	const guardBindings = replacement
		? [replacement.credentialId, replacement.encryptedValue]
		: []
	const sessionWrite = db
		.prepare(
			`UPDATE login_credential_sessions
			SET revision = ?, session_id = ?, session_encrypted = ?, expires_at = ?,
				lease_id = NULL, lease_expires_at = NULL, updated_at = ?
			WHERE credential_id = ? AND user_id = ? AND lease_id = ? ${guard}`,
		)
		.bind(
			revision,
			sessionId,
			encrypted,
			expiresAt,
			new Date().toISOString(),
			input.credentialId,
			input.ownerId,
			input.leaseId,
			...guardBindings,
		)
	if (!replacement) {
		const result = await sessionWrite.run()
		return {
			sessionId: (result.meta.changes ?? 0) > 0 ? sessionId : null,
			valueReplaced: false,
		}
	}
	const [valueResult, sessionResult] = await db.batch([
		replacement.valueStatement,
		sessionWrite,
	])
	const valueReplaced = (valueResult?.meta.changes ?? 0) > 0
	if (!valueReplaced) await releaseLease(db, input.credentialId, input.leaseId)
	return {
		sessionId:
			valueReplaced && (sessionResult?.meta.changes ?? 0) > 0
				? sessionId
				: null,
		valueReplaced,
	}
}

/** Drops the stored session only if it is still the one a host rejected. */
async function dropRejectedSession(
	db: D1Database,
	credentialId: string,
	sessionId: string,
) {
	await db
		.prepare(
			`UPDATE login_credential_sessions
			SET session_id = NULL, session_encrypted = NULL, expires_at = NULL
			WHERE credential_id = ? AND session_id = ?`,
		)
		.bind(credentialId, sessionId)
		.run()
}

/**
 * The credential's live session: a stored one for this revision, or one
 * `exchange` mints while this caller holds the lease. Callers that lose the
 * lease wait (up to twice the lease) for the holder's session. A
 * `rejectedSessionId` (a host answered 401 to it) is dropped first, unless
 * another caller already replaced it, in which case its session is reused.
 */
export async function obtainLoginSession(
	input: SessionKey & {
		env: SessionEnv
		exchange: () => Promise<LoginSession>
		/** Whether the credential still matches what the caller read. */
		isCurrent?: () => Promise<boolean>
		rejectedSessionId?: string | null
		leaseMs?: number
		pollMs?: number
	},
): Promise<ObtainedLoginSession> {
	const leaseMs = input.leaseMs ?? defaultLeaseMs
	const pollMs = input.pollMs ?? defaultPollMs
	const deadline = Date.now() + leaseMs * 2
	const leaseId = crypto.randomUUID()
	if (input.rejectedSessionId) {
		await dropRejectedSession(
			input.env.APP_DB,
			input.credentialId,
			input.rejectedSessionId,
		)
	}
	for (;;) {
		const stored = await readStoredLoginSession(input)
		if (stored) {
			return {
				session: stored,
				source: 'stored',
				sessionId: stored.sessionId,
				valueReplaced: false,
			}
		}
		const now = Date.now()
		if (
			await claimLease({
				...input,
				db: input.env.APP_DB,
				leaseId,
				now,
				leaseMs,
			})
		) {
			let leaseCleared = false
			try {
				// The holder may have published between the read and the claim.
				const storedAfterClaim = await readStoredLoginSession(input)
				if (storedAfterClaim) {
					return {
						session: storedAfterClaim,
						source: 'stored',
						sessionId: storedAfterClaim.sessionId,
						valueReplaced: false,
					}
				}
				// A rotation may have committed after the caller read the credential.
				if (input.isCurrent && !(await input.isCurrent())) {
					throw new StaleLoginCredentialError()
				}
				const session = await input.exchange()
				if (session.expiresAt === null && !session.replacement) {
					return {
						session,
						source: 'new',
						sessionId: null,
						valueReplaced: false,
					}
				}
				const written = await writeSessionUnderLease({
					...input,
					leaseId,
					session,
				})
				leaseCleared = true
				return { session, source: 'new', ...written }
			} finally {
				if (!leaseCleared) {
					await releaseLease(input.env.APP_DB, input.credentialId, leaseId)
				}
			}
		}
		if (!(await credentialIsLive(input.env.APP_DB, input))) {
			throw new CredentialLoginFailedError(null)
		}
		if (Date.now() + pollMs > deadline)
			throw new CredentialLoginFailedError(null)
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
}

/** Statement that deletes the sessions of the credentials `credentialIdSql` selects. */
export function deleteLoginSessionsStatement(
	db: D1Database,
	input: { credentialIdSql: string; credentialIdBindings: Array<unknown> },
): D1PreparedStatement {
	return db
		.prepare(
			`DELETE FROM login_credential_sessions
			WHERE credential_id IN (${input.credentialIdSql})`,
		)
		.bind(...input.credentialIdBindings)
}
