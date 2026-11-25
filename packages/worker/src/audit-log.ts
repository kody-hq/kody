import { toHex } from '@kody-internal/shared/hex.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'

export const auditEventCategories = [
	'account',
	'admin',
	'auth',
	'oauth',
] as const
export const auditEventResults = ['success', 'failure', 'rate_limited'] as const

export type AuditEventCategory = (typeof auditEventCategories)[number]
export type AuditEventResult = (typeof auditEventResults)[number]

type AuditEvent = {
	db: D1Database | null | undefined
	category: AuditEventCategory
	action: string
	result: AuditEventResult
	email?: string
	ip?: string
	clientId?: string
	path?: string
	reason?: string
}

export type AuditLogEntry = {
	id: number
	category: AuditEventCategory
	action: string
	result: AuditEventResult
	email_hash: string | null
	ip_hash: string | null
	client_id: string | null
	path: string | null
	reason: string | null
	timestamp: string
}

export type AuditLogQuery = {
	action?: string
	category?: AuditEventCategory
	result?: AuditEventResult
	user?: string
	emailHash?: string
	startTime?: string
	endTime?: string
	limit?: number
	page?: number
}

const defaultAuditLogLimit = 50
const maxAuditLogLimit = 100

async function hashIdentifier(value: string) {
	const data = new TextEncoder().encode(value.trim().toLowerCase())
	const digest = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(digest))
}

export function redactEmailRecipient(email: string) {
	const at = email.lastIndexOf('@')
	return at >= 0 ? `***@${email.slice(at + 1)}` : '***'
}

export function getRequestIp(request: Request) {
	const forwarded = request.headers.get('x-forwarded-for')
	const forwardedIp = forwarded?.split(',')[0]?.trim()
	return (
		request.headers.get('CF-Connecting-IP') ??
		(forwardedIp && forwardedIp.length > 0 ? forwardedIp : null)
	)
}

function normalizeOptionalString(value: string | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : undefined
}

async function buildAuditPayload(event: AuditEvent) {
	const [emailHash, ipHash] = await Promise.all([
		event.email ? hashIdentifier(event.email) : undefined,
		event.ip ? hashIdentifier(event.ip) : undefined,
	])
	return {
		category: event.category,
		action: event.action,
		result: event.result,
		emailHash,
		ipHash,
		clientId: event.clientId,
		path: event.path,
		reason: event.reason,
		timestamp: new Date().toISOString(),
	}
}

async function persistAuditEvent(
	db: D1Database | undefined,
	payload: Awaited<ReturnType<typeof buildAuditPayload>>,
) {
	if (!db) return
	await runD1WithRetry(() =>
		db
			.prepare(
				`INSERT INTO audit_events (
				category,
				action,
				result,
				email_hash,
				ip_hash,
				client_id,
				path,
				reason,
				timestamp
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				payload.category,
				payload.action,
				payload.result,
				payload.emailHash ?? null,
				payload.ipHash ?? null,
				payload.clientId ?? null,
				payload.path ?? null,
				payload.reason ?? null,
				payload.timestamp,
			)
			.run(),
	)
}

export function auditDatabaseFromEnv(runtimeEnv: {
	AUDIT_DB?: D1Database
	SENTRY_ENVIRONMENT?: string
}) {
	// Generic Workers tests opt into the real audit sink explicitly so they do
	// not all need to migrate a second database unrelated to their behavior.
	return runtimeEnv.SENTRY_ENVIRONMENT === 'test'
		? undefined
		: (runtimeEnv.AUDIT_DB ?? null)
}

export async function logAuditEvent(event: AuditEvent) {
	try {
		const payload = await buildAuditPayload(event)
		console.info('audit-event', JSON.stringify(payload))
		if (event.db === undefined) {
			return { persisted: false, failedSinks: [] }
		}
		if (event.db === null) {
			const error = new Error('Missing required AUDIT_DB binding.')
			console.warn('audit-event-write-failed', {
				failedSinks: ['AUDIT_DB'],
				errors: [error],
			})
			return { persisted: false, failedSinks: ['AUDIT_DB'] }
		}
		try {
			await persistAuditEvent(event.db, payload)
			return { persisted: true, failedSinks: [] }
		} catch (error) {
			console.warn('audit-event-write-failed', {
				failedSinks: ['AUDIT_DB'],
				errors: [error],
			})
			return { persisted: false, failedSinks: ['AUDIT_DB'] }
		}
	} catch (error) {
		console.warn('audit-event-failed', error)
		return { persisted: false, failedSinks: ['event'] }
	}
}

export async function queryAuditLog(db: D1Database, query: AuditLogQuery) {
	const limit = Math.max(
		1,
		Math.min(Math.floor(query.limit ?? defaultAuditLogLimit), maxAuditLogLimit),
	)
	const page = Math.max(1, Math.floor(query.page ?? 1))
	const offset = (page - 1) * limit
	const where: Array<string> = []
	const bindings: Array<string | number> = []

	const action = normalizeOptionalString(query.action)
	if (action) {
		where.push('action = ?')
		bindings.push(action)
	}
	if (query.category) {
		where.push('category = ?')
		bindings.push(query.category)
	}
	if (query.result) {
		where.push('result = ?')
		bindings.push(query.result)
	}
	const emailHash = normalizeOptionalString(query.emailHash)
	const user = normalizeOptionalString(query.user)
	const resolvedEmailHash =
		emailHash ?? (user ? await hashIdentifier(user) : null)
	if (resolvedEmailHash) {
		where.push('email_hash = ?')
		bindings.push(resolvedEmailHash)
	}
	const startTime = normalizeOptionalString(query.startTime)
	if (startTime) {
		where.push('timestamp >= ?')
		bindings.push(startTime)
	}
	const endTime = normalizeOptionalString(query.endTime)
	if (endTime) {
		where.push('timestamp <= ?')
		bindings.push(endTime)
	}

	const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
	const countStatement = db.prepare(
		`SELECT COUNT(*) AS total FROM audit_events ${whereSql}`,
	)
	const countQuery =
		bindings.length > 0 ? countStatement.bind(...bindings) : countStatement
	const [totalRow, rows] = await Promise.all([
		countQuery.first<{ total: number }>(),
		db
			.prepare(
				`SELECT
					id,
					category,
					action,
					result,
					email_hash,
					ip_hash,
					client_id,
					path,
					reason,
					timestamp
				 FROM audit_events
				 ${whereSql}
				 ORDER BY timestamp DESC, id DESC
				 LIMIT ? OFFSET ?`,
			)
			.bind(...bindings, limit, offset)
			.all<AuditLogEntry>(),
	])

	return {
		total: totalRow?.total ?? 0,
		page,
		limit,
		events: rows.results ?? [],
	}
}
