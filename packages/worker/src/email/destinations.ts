import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'
import { normalizeEmailAddress } from './address.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import {
	identityEmailDestinationId,
	maxAdditionalEmailNotificationDestinations,
	type EmailNotificationDestination,
} from '#universal/email-destinations.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export {
	identityEmailDestinationId,
	maxAdditionalEmailNotificationDestinations,
	type EmailNotificationDestination,
}

export type EmailDestinationErrorCode =
	| 'invalid_email'
	| 'identity_email'
	| 'already_added'
	| 'not_found'
	| 'not_verified'
	| 'at_cap'
	| 'cannot_remove_identity'
	| 'rate_limited'
	| 'user_daily_cap'
	| 'recipient_daily_cap'
	| 'account_too_new'

export class EmailDestinationError extends Error {
	readonly code: EmailDestinationErrorCode
	/** Seconds until the caller can retry, when this error is a temporary cap. */
	readonly retryAfterSeconds: number | null

	constructor(
		code: EmailDestinationErrorCode,
		message: string,
		options?: { retryAfterSeconds?: number },
	) {
		super(message)
		this.name = 'EmailDestinationError'
		this.code = code
		this.retryAfterSeconds = options?.retryAfterSeconds ?? null
	}
}

export type EmailDestinationAccount = {
	id: number
	email: string
	emailVerifiedAt: string | null
	stableUserId: string
}

type DestinationRow = {
	id: string
	email: string
	verified_at: string | null
	is_default: number
}

export function getEmailDestinationValidationError(email: string) {
	if (!email.trim()) return 'Email is required.'
	if (email.length > 254) return 'Email is too long.'
	if (!normalizeEmailAddress(email)) {
		return 'Enter a valid email address.'
	}
	return null
}

function requireCanonicalDestinationEmail(email: string) {
	const validationError = getEmailDestinationValidationError(email)
	if (validationError) {
		throw new EmailDestinationError('invalid_email', validationError)
	}
	return normalizeEmailAddress(email) as string
}

function canonicalizeStoredEmail(email: string) {
	return normalizeEmailAddress(email) ?? normalizeEmail(email)
}

export async function loadEmailDestinationAccount(input: {
	db: D1Database
	dbUserId?: number
	stableUserId?: string
}): Promise<EmailDestinationAccount | null> {
	if (input.dbUserId != null) {
		const row = await input.db
			.prepare(
				`SELECT id, email, email_verified_at, stable_user_id
				 FROM users
				 WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
			)
			.bind(input.dbUserId)
			.first<{
				id: number
				email: string
				email_verified_at: string | null
				stable_user_id: string
			}>()
		if (!row) return null
		return {
			id: row.id,
			email: row.email,
			emailVerifiedAt: row.email_verified_at,
			stableUserId: row.stable_user_id,
		}
	}
	if (input.stableUserId) {
		const row = await input.db
			.prepare(
				`SELECT id, email, email_verified_at, stable_user_id
				 FROM users
				 WHERE stable_user_id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
			)
			.bind(input.stableUserId)
			.first<{
				id: number
				email: string
				email_verified_at: string | null
				stable_user_id: string
			}>()
		if (!row) return null
		return {
			id: row.id,
			email: row.email,
			emailVerifiedAt: row.email_verified_at,
			stableUserId: row.stable_user_id,
		}
	}
	return null
}

async function requireEmailDestinationAccount(input: {
	db: D1Database
	dbUserId?: number
	stableUserId?: string
}): Promise<EmailDestinationAccount> {
	const account = await loadEmailDestinationAccount(input)
	if (!account) {
		throw new AccountDeletionInProgressError()
	}
	return account
}

async function listAdditionalDestinationRows(
	db: D1Database,
	userId: number,
): Promise<Array<DestinationRow>> {
	const result = await db
		.prepare(
			`SELECT id, email, verified_at, is_default
			 FROM email_notification_destinations
			 WHERE user_id = ?
			${andLiveDeletedAtSql()} ORDER BY created_at ASC, email ASC`,
		)
		.bind(userId)
		.all<DestinationRow>()
	return result.results ?? []
}

export async function listEmailNotificationDestinations(input: {
	db: D1Database
	dbUserId?: number
	stableUserId?: string
	accountEmail?: string
	accountEmailVerified?: boolean
}): Promise<Array<EmailNotificationDestination>> {
	const account = await loadEmailDestinationAccount(input)
	const identityEmail = canonicalizeStoredEmail(
		input.accountEmail ?? account?.email ?? '',
	)
	const identityVerified =
		input.accountEmailVerified ?? Boolean(account?.emailVerifiedAt)
	if (!identityEmail) return []

	const extras = account
		? await listAdditionalDestinationRows(input.db, account.id)
		: []
	const extraIsDefault = extras.some((row) => row.is_default === 1)
	return [
		{
			id: identityEmailDestinationId,
			email: identityEmail,
			kind: 'identity',
			verified: identityVerified,
			isDefault: !extraIsDefault,
			canRemove: false,
		},
		...extras.map((row) => ({
			id: row.id,
			email: canonicalizeStoredEmail(row.email),
			kind: 'additional' as const,
			verified: row.verified_at != null,
			isDefault: row.is_default === 1,
			canRemove: true,
		})),
	]
}

export function buildEmailDestinationsLoaderData(
	destinations: Array<EmailNotificationDestination>,
) {
	const additionalCount = destinations.filter(
		(destination) => destination.kind === 'additional',
	).length
	return {
		ok: true as const,
		destinations,
		additionalLimit: maxAdditionalEmailNotificationDestinations,
		additionalRemaining: Math.max(
			0,
			maxAdditionalEmailNotificationDestinations - additionalCount,
		),
	}
}

export async function addEmailNotificationDestination(input: {
	db: D1Database
	dbUserId: number
	email: string
	now?: Date
}): Promise<{
	destination: EmailNotificationDestination
	created: boolean
}> {
	const account = await requireEmailDestinationAccount({
		db: input.db,
		dbUserId: input.dbUserId,
	})
	const email = requireCanonicalDestinationEmail(input.email)
	if (email === canonicalizeStoredEmail(account.email)) {
		throw new EmailDestinationError(
			'identity_email',
			'That address is already your account email.',
		)
	}

	const existing = await input.db
		.prepare(
			`SELECT id, email, verified_at, is_default
			 FROM email_notification_destinations
			 WHERE user_id = ? AND email = ?${andLiveDeletedAtSql()}`,
		)
		.bind(account.id, email)
		.first<DestinationRow>()
	if (existing) {
		if (existing.verified_at) {
			throw new EmailDestinationError(
				'already_added',
				'That address is already an email destination.',
			)
		}
		return {
			destination: {
				id: existing.id,
				email: existing.email,
				kind: 'additional',
				verified: false,
				isDefault: existing.is_default === 1,
				canRemove: true,
			},
			created: false,
		}
	}

	const id = crypto.randomUUID()
	const inserted = await input.db
		.prepare(
			`INSERT INTO email_notification_destinations (id, user_id, email, verified_at, is_default)
			 SELECT ?, id, ?, NULL, 0
			 FROM users
			 WHERE id = ? AND deleting_at IS NULL
			   AND (
				 SELECT COUNT(*)
				 FROM email_notification_destinations
				 WHERE user_id = users.id
			   ) < ?`,
		)
		.bind(id, email, account.id, maxAdditionalEmailNotificationDestinations)
		.run()
	if ((inserted.meta.changes ?? 0) !== 1) {
		const stillPresent = await loadEmailDestinationAccount({
			db: input.db,
			dbUserId: account.id,
		})
		if (!stillPresent) {
			throw new AccountDeletionInProgressError()
		}
		throw new EmailDestinationError(
			'at_cap',
			`You can add up to ${maxAdditionalEmailNotificationDestinations} extra email destinations.`,
		)
	}

	return {
		destination: {
			id,
			email,
			kind: 'additional',
			verified: false,
			isDefault: false,
			canRemove: true,
		},
		created: true,
	}
}

export async function markEmailNotificationDestinationVerified(input: {
	db: D1Database
	destinationId: string
	userId: number
	now?: Date
}): Promise<EmailNotificationDestination | null> {
	const verifiedAt = (input.now ?? new Date()).toISOString()
	const row = await input.db
		.prepare(
			`UPDATE email_notification_destinations
			 SET verified_at = COALESCE(verified_at, ?)
			 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}
			 RETURNING id, email, verified_at, is_default`,
		)
		.bind(verifiedAt, input.destinationId, input.userId)
		.first<DestinationRow>()
	if (!row) return null
	return {
		id: row.id,
		email: row.email,
		kind: 'additional',
		verified: row.verified_at != null,
		isDefault: row.is_default === 1,
		canRemove: true,
	}
}

export async function changeDefaultEmailNotificationDestination(input: {
	db: D1Database
	dbUserId: number
	destinationId: string
}): Promise<void> {
	const account = await requireEmailDestinationAccount({
		db: input.db,
		dbUserId: input.dbUserId,
	})

	if (input.destinationId === identityEmailDestinationId) {
		await input.db
			.prepare(
				`UPDATE email_notification_destinations
				 SET is_default = 0
				 WHERE user_id = ? AND is_default = 1${andLiveDeletedAtSql()}`,
			)
			.bind(account.id)
			.run()
		return
	}

	const row = await input.db
		.prepare(
			`SELECT id, email, verified_at, is_default
			 FROM email_notification_destinations
			 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.destinationId, account.id)
		.first<DestinationRow>()
	if (!row) {
		throw new EmailDestinationError(
			'not_found',
			'Email destination was not found.',
		)
	}
	if (!row.verified_at) {
		throw new EmailDestinationError(
			'not_verified',
			'Verify this address before making it the default.',
		)
	}

	await input.db.batch([
		input.db
			.prepare(
				`UPDATE email_notification_destinations
				 SET is_default = 0
				 WHERE user_id = ? AND is_default = 1${andLiveDeletedAtSql()}`,
			)
			.bind(account.id),
		input.db
			.prepare(
				`UPDATE email_notification_destinations
				 SET is_default = 1
				 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(row.id, account.id),
	])
}

export async function deleteEmailNotificationDestination(input: {
	db: D1Database
	dbUserId: number
	destinationId: string
}): Promise<void> {
	if (input.destinationId === identityEmailDestinationId) {
		throw new EmailDestinationError(
			'cannot_remove_identity',
			'The account email stays on the destination list. Change it from account settings.',
		)
	}

	const account = await requireEmailDestinationAccount({
		db: input.db,
		dbUserId: input.dbUserId,
	})
	const deleted = await input.db
		.prepare(
			`DELETE FROM email_notification_destinations
			 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.destinationId, account.id)
		.run()
	if ((deleted.meta.changes ?? 0) !== 1) {
		throw new EmailDestinationError(
			'not_found',
			'Email destination was not found.',
		)
	}
}

export async function setDefaultEmailNotificationDestination(
	input: Parameters<typeof changeDefaultEmailNotificationDestination>[0],
) {
	await changeDefaultEmailNotificationDestination(input)
	return listEmailNotificationDestinations({
		db: input.db,
		dbUserId: input.dbUserId,
	})
}

export async function removeEmailNotificationDestination(
	input: Parameters<typeof deleteEmailNotificationDestination>[0],
) {
	await deleteEmailNotificationDestination(input)
	return listEmailNotificationDestinations({
		db: input.db,
		dbUserId: input.dbUserId,
	})
}

export async function deleteEmailNotificationDestinationRow(input: {
	db: D1Database
	destinationId: string
	userId: number
}) {
	await input.db
		.prepare(
			`DELETE FROM email_notification_destinations
			 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.destinationId, input.userId)
		.run()
}

/**
 * When identity email changes to an address that was an extra destination,
 * drop that extra row so the address is owned only by the identity flow.
 */
export async function reconcileDestinationsAfterIdentityEmailChange(input: {
	db: D1Database
	userId: number
	newEmail: string
}) {
	const email = canonicalizeStoredEmail(input.newEmail)
	await input.db
		.prepare(
			`DELETE FROM email_notification_destinations
			 WHERE user_id = ? AND email = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, email)
		.run()
}

export function collectAcceptableNotificationEmails(input: {
	accountEmail: string
	accountEmailVerified: boolean
	extras: Array<Pick<DestinationRow, 'email' | 'verified_at'>>
}) {
	const acceptable = new Set<string>()
	const identity = canonicalizeStoredEmail(input.accountEmail)
	if (input.accountEmailVerified && identity) {
		acceptable.add(identity)
	}
	for (const extra of input.extras) {
		if (!extra.verified_at) continue
		const email = canonicalizeStoredEmail(extra.email)
		if (email) acceptable.add(email)
	}
	return acceptable
}

export async function resolveDefaultNotificationEmail(input: {
	db: D1Database
	stableUserId: string
	accountEmail: string
}): Promise<string> {
	const identity = canonicalizeStoredEmail(input.accountEmail)
	const account = await loadEmailDestinationAccount({
		db: input.db,
		stableUserId: input.stableUserId,
	})
	if (!account) return identity
	const defaultExtra = await input.db
		.prepare(
			`SELECT email
			 FROM email_notification_destinations
			 WHERE user_id = ? AND is_default = 1 AND verified_at IS NOT NULL${andLiveDeletedAtSql()}`,
		)
		.bind(account.id)
		.first<{ email: string }>()
	return defaultExtra ? canonicalizeStoredEmail(defaultExtra.email) : identity
}

export async function resolveAcceptableNotificationEmails(input: {
	db: D1Database
	stableUserId: string
	accountEmail: string
}): Promise<{
	acceptable: Set<string>
	defaultEmail: string
}> {
	const identity = canonicalizeStoredEmail(input.accountEmail)
	const account = await loadEmailDestinationAccount({
		db: input.db,
		stableUserId: input.stableUserId,
	})
	const extras = account
		? await listAdditionalDestinationRows(input.db, account.id)
		: []
	const acceptable = collectAcceptableNotificationEmails({
		accountEmail: identity,
		accountEmailVerified: Boolean(account?.emailVerifiedAt),
		extras,
	})
	const defaultExtra = extras.find(
		(row) => row.is_default === 1 && row.verified_at != null,
	)
	return {
		acceptable,
		defaultEmail: defaultExtra
			? canonicalizeStoredEmail(defaultExtra.email)
			: identity,
	}
}
