import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	decryptWebhookHmacSecret,
	encryptWebhookHmacSecret,
	userWebhookHmacSecretContext,
} from '#mcp/secrets/crypto.ts'
import { liveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	clearWebhookEndpointPreviousHmacSecret,
	listWebhookEndpointsByHmacSecretName,
	setWebhookEndpointHmacVerificationState,
} from './repo.ts'
import {
	isWebhookPreviousHmacLive,
	type WebhookEndpointRecord,
	webhookHmacSecretRotationGraceExpiresAt,
} from './types.ts'

/**
 * Package scope wins over user for webhook-secret resolution. A user-scoped
 * value change must not attach previous_* onto an endpoint whose declared
 * secretName resolves to a package secret of the same name.
 *
 * Existence only — no decrypt. Inline SQL so this module stays outside the
 * credential-storage door (`getSecretEntry` is resolveCredential-only).
 */
async function packageOwnsWebhookSecretName(input: {
	db: D1Database
	userId: string
	packageId: string
	secretName: string
}): Promise<boolean> {
	const now = new Date().toISOString()
	const row = await input.db
		.prepare(
			`SELECT 1 AS hit
			FROM secret_buckets b
			JOIN secret_entries e ON e.bucket_id = b.id
			WHERE b.user_id = ?
				AND b.scope = 'package'
				AND b.binding_key = ?
				AND e.name = ?
				AND e.kind = 'secret'
				AND (b.expires_at IS NULL OR b.expires_at > ?)
				AND ${liveDeletedAtSql('b')}
				AND ${liveDeletedAtSql('e')}
			LIMIT 1`,
		)
		.bind(input.userId, input.packageId, input.secretName, now)
		.first<{ hit: number }>()
	return row != null
}

/**
 * Snapshot of the declared signing value for change detection. Platform
 * ciphertext only — never returned to package code or MCP.
 */
export async function encryptWebhookVerificationSnapshot(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	userId: OwnerId
	endpointId: string
	plaintext: string
}): Promise<string> {
	return encryptWebhookHmacSecret(
		input.env,
		input.plaintext,
		userWebhookHmacSecretContext(input.userId, input.endpointId),
	)
}

export async function decryptWebhookVerificationSnapshot(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	userId: OwnerId
	endpointId: string
	encrypted: string
}): Promise<string> {
	return decryptWebhookHmacSecret(
		input.env,
		input.encrypted,
		userWebhookHmacSecretContext(input.userId, input.endpointId),
	)
}

/**
 * After a user secret value changes, keep the outgoing plaintext as a
 * co-signer on every webhook that last reconciled that secretName. Writes
 * only identity + ciphertext columns on the endpoint — never package code.
 */
export async function rotateWebhookHmacSecretsForSecretValueChange(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	userId: OwnerId
	secretName: string
	previousPlaintext: string
	/** When known, advance the verification snapshot so ingress does not
	 * treat the same value change as a second rotation. */
	nextPlaintext?: string
	/**
	 * Package-scoped secret updates must pass the package id so another
	 * package's webhook with the same secretName is not rotated.
	 */
	packageId?: string
	now?: Date | string
}): Promise<number> {
	const now = input.now ?? new Date()
	const secretName = input.secretName.trim()
	if (!secretName || !input.previousPlaintext) return 0
	const endpoints = await listWebhookEndpointsByHmacSecretName({
		db: input.env.APP_DB,
		userId: input.userId,
		hmacSecretName: secretName,
		...(input.packageId ? { packageId: input.packageId } : {}),
	})
	const userScopedUpdate = !input.packageId
	let updated = 0
	for (const endpoint of endpoints) {
		if (userScopedUpdate) {
			if (
				await packageOwnsWebhookSecretName({
					db: input.env.APP_DB,
					userId: input.userId,
					packageId: endpoint.packageId,
					secretName,
				})
			) {
				continue
			}
			if (!endpoint.hmacVerificationSecretEncrypted) continue
			let snapshotPlaintext: string
			try {
				snapshotPlaintext = await decryptWebhookVerificationSnapshot({
					env: input.env,
					userId: input.userId,
					endpointId: endpoint.id,
					encrypted: endpoint.hmacVerificationSecretEncrypted,
				})
			} catch (error) {
				console.warn('webhook-rotation-snapshot-decrypt-failed', {
					endpointId: endpoint.id,
					error,
				})
				continue
			}
			if (snapshotPlaintext !== input.previousPlaintext) continue
		} else if (endpoint.hmacVerificationSecretEncrypted) {
			try {
				const snapshotPlaintext = await decryptWebhookVerificationSnapshot({
					env: input.env,
					userId: input.userId,
					endpointId: endpoint.id,
					encrypted: endpoint.hmacVerificationSecretEncrypted,
				})
				if (snapshotPlaintext !== input.previousPlaintext) continue
			} catch (error) {
				console.warn('webhook-rotation-snapshot-decrypt-failed', {
					endpointId: endpoint.id,
					error,
				})
				continue
			}
		}
		// Always encrypt the known outgoing plaintext. Reusing a concurrent
		// ingress snapshot can store the new value as previous_* and drop grace.
		const previousEncrypted = await encryptWebhookVerificationSnapshot({
			env: input.env,
			userId: input.userId,
			endpointId: endpoint.id,
			plaintext: input.previousPlaintext,
		})
		const nextSnapshot = input.nextPlaintext
			? await encryptWebhookVerificationSnapshot({
					env: input.env,
					userId: input.userId,
					endpointId: endpoint.id,
					plaintext: input.nextPlaintext,
				})
			: null
		const saved = await setWebhookEndpointHmacVerificationState({
			db: input.env.APP_DB,
			userId: input.userId,
			endpointId: endpoint.id,
			hmacSecretName: secretName,
			hmacVerificationSecretEncrypted: nextSnapshot,
			previousHmacSecretName: secretName,
			previousHmacSecretEncrypted: previousEncrypted,
			previousHmacSecretExpiresAt: webhookHmacSecretRotationGraceExpiresAt(now),
		})
		if (saved) updated += 1
	}
	return updated
}

/**
 * Reconcile last-seen secretName / declared snapshot on ingress.
 * Returns the endpoint with previous_* cleared when expired, and with
 * rotation columns written when the declared identity or value changed.
 */
export async function reconcileWebhookHmacVerificationRotation(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	endpoint: WebhookEndpointRecord
	secretName: string
	declaredPlaintext: string
	now?: Date | string
}): Promise<WebhookEndpointRecord> {
	const now = input.now ?? new Date()
	const secretName = input.secretName.trim()
	let endpoint = input.endpoint

	if (
		endpoint.previousHmacSecretEncrypted &&
		!isWebhookPreviousHmacLive(endpoint, now)
	) {
		await clearWebhookEndpointPreviousHmacSecret({
			db: input.env.APP_DB,
			userId: endpoint.userId,
			endpointId: endpoint.id,
			previousHmacSecretEncrypted: endpoint.previousHmacSecretEncrypted,
		})
		endpoint = {
			...endpoint,
			previousHmacSecretName: null,
			previousHmacSecretEncrypted: null,
			previousHmacSecretExpiresAt: null,
		}
	}

	const nextSnapshot = await encryptWebhookVerificationSnapshot({
		env: input.env,
		userId: endpoint.userId,
		endpointId: endpoint.id,
		plaintext: input.declaredPlaintext,
	})

	const trackedName = endpoint.hmacSecretName?.trim() ?? ''
	if (!trackedName) {
		const saved = await setWebhookEndpointHmacVerificationState({
			db: input.env.APP_DB,
			userId: endpoint.userId,
			endpointId: endpoint.id,
			hmacSecretName: secretName,
			hmacVerificationSecretEncrypted: nextSnapshot,
		})
		return (
			saved ?? {
				...endpoint,
				hmacSecretName: secretName,
				hmacVerificationSecretEncrypted: nextSnapshot,
			}
		)
	}

	let previousPlaintext: string | null = null
	if (endpoint.hmacVerificationSecretEncrypted) {
		try {
			previousPlaintext = await decryptWebhookVerificationSnapshot({
				env: input.env,
				userId: endpoint.userId,
				endpointId: endpoint.id,
				encrypted: endpoint.hmacVerificationSecretEncrypted,
			})
		} catch (error) {
			console.warn('webhook-verification-snapshot-decrypt-failed', {
				endpointId: endpoint.id,
				error,
			})
		}
	}

	const nameChanged = trackedName !== secretName
	const valueChanged =
		previousPlaintext !== null && previousPlaintext !== input.declaredPlaintext
	if (!nameChanged && !valueChanged) {
		if (!endpoint.hmacVerificationSecretEncrypted) {
			const saved = await setWebhookEndpointHmacVerificationState({
				db: input.env.APP_DB,
				userId: endpoint.userId,
				endpointId: endpoint.id,
				hmacSecretName: secretName,
				hmacVerificationSecretEncrypted: nextSnapshot,
			})
			return (
				saved ?? {
					...endpoint,
					hmacSecretName: secretName,
					hmacVerificationSecretEncrypted: nextSnapshot,
				}
			)
		}
		return endpoint
	}

	const previousEncrypted =
		endpoint.hmacVerificationSecretEncrypted ??
		(previousPlaintext
			? await encryptWebhookVerificationSnapshot({
					env: input.env,
					userId: endpoint.userId,
					endpointId: endpoint.id,
					plaintext: previousPlaintext,
				})
			: null)
	if (!previousEncrypted) {
		const saved = await setWebhookEndpointHmacVerificationState({
			db: input.env.APP_DB,
			userId: endpoint.userId,
			endpointId: endpoint.id,
			hmacSecretName: secretName,
			hmacVerificationSecretEncrypted: nextSnapshot,
		})
		return (
			saved ?? {
				...endpoint,
				hmacSecretName: secretName,
				hmacVerificationSecretEncrypted: nextSnapshot,
			}
		)
	}

	const saved = await setWebhookEndpointHmacVerificationState({
		db: input.env.APP_DB,
		userId: endpoint.userId,
		endpointId: endpoint.id,
		hmacSecretName: secretName,
		hmacVerificationSecretEncrypted: nextSnapshot,
		previousHmacSecretName: trackedName,
		previousHmacSecretEncrypted: previousEncrypted,
		previousHmacSecretExpiresAt: webhookHmacSecretRotationGraceExpiresAt(now),
	})
	return (
		saved ?? {
			...endpoint,
			hmacSecretName: secretName,
			hmacVerificationSecretEncrypted: nextSnapshot,
			previousHmacSecretName: trackedName,
			previousHmacSecretEncrypted: previousEncrypted,
			previousHmacSecretExpiresAt: webhookHmacSecretRotationGraceExpiresAt(now),
		}
	)
}
