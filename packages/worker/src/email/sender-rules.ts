import type {
	EmailSenderRuleEffect,
	EmailSenderRuleKind,
	EmailSenderRuleRecord,
} from './types.ts'

/** Flat cap; rules are created by the authenticated owner, this is just runaway-growth protection. */
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export const maxEmailSenderRulesPerUser = 200

export class EmailSenderRuleValidationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'EmailSenderRuleValidationError'
	}
}

export class EmailSenderRuleLimitError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'EmailSenderRuleLimitError'
	}
}

function nowIso() {
	return new Date().toISOString()
}

function normalizeSenderRuleValue(value: string) {
	return value.trim().toLowerCase()
}

function assertValidSenderRuleValue(kind: EmailSenderRuleKind, value: string) {
	if (kind === 'address') {
		const parts = value.split('@')
		if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(value)) {
			throw new EmailSenderRuleValidationError(
				'Address sender rules require exactly one "@" with non-empty local and domain parts and no whitespace.',
			)
		}
		return
	}

	if (kind === 'domain') {
		// `%` and `_` are SQLite LIKE wildcards and the stored value is used in
		// the subdomain-suffix LIKE pattern, so they must never reach storage.
		if (
			value.includes('@') ||
			/\s/.test(value) ||
			!value.includes('.') ||
			/[%_]/.test(value)
		) {
			throw new EmailSenderRuleValidationError(
				'Domain sender rules require a bare domain with at least one "." and no spaces, "@", "%", or "_".',
			)
		}
		return
	}

	const _exhaustive: never = kind
	throw new EmailSenderRuleValidationError(
		`Unsupported sender rule kind: ${String(_exhaustive)}`,
	)
}

function mapSenderRuleRow(row: Record<string, unknown>): EmailSenderRuleRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		kind: String(row['kind']) as EmailSenderRuleKind,
		value: String(row['value']),
		effect: String(row['effect']) as EmailSenderRuleEffect,
		note: row['note'] == null ? '' : String(row['note']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export async function listEmailSenderRules(input: {
	db: D1Database
	userId: string
}): Promise<Array<EmailSenderRuleRecord>> {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_rules
			WHERE user_id = ?${andLiveDeletedAtSql()}
			ORDER BY created_at ASC, id ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapSenderRuleRow)
}

export async function upsertEmailSenderRule(input: {
	db: D1Database
	userId: string
	kind: EmailSenderRuleKind
	value: string
	effect: EmailSenderRuleEffect
	note?: string
}): Promise<EmailSenderRuleRecord> {
	const value = normalizeSenderRuleValue(input.value)
	assertValidSenderRuleValue(input.kind, value)
	const note = input.note ?? ''
	const timestamp = nowIso()

	const existing = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_rules
			WHERE user_id = ?
				AND kind = ?
				AND value = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, input.kind, value)
		.first<Record<string, unknown>>()

	if (existing) {
		await input.db
			.prepare(
				`UPDATE email_sender_rules
				SET effect = ?,
					note = ?,
					updated_at = ?
				WHERE id = ?
					AND user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(input.effect, note, timestamp, String(existing['id']), input.userId)
			.run()
		return mapSenderRuleRow({
			...existing,
			effect: input.effect,
			note,
			updated_at: timestamp,
		})
	}

	// The cap is enforced inside the INSERT itself so concurrent upserts
	// cannot race past a separate count check.
	const id = crypto.randomUUID()
	const inserted = await input.db
		.prepare(
			`INSERT INTO email_sender_rules (
				id, user_id, kind, value, effect, note, created_at, updated_at
			)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?
			WHERE (
				SELECT COUNT(*) FROM email_sender_rules WHERE user_id = ?
			) < ?`,
		)
		.bind(
			id,
			input.userId,
			input.kind,
			value,
			input.effect,
			note,
			timestamp,
			timestamp,
			input.userId,
			maxEmailSenderRulesPerUser,
		)
		.run()
	if (Number(inserted.meta.changes ?? 0) === 0) {
		throw new EmailSenderRuleLimitError(
			`Sender rule limit reached: at most ${String(maxEmailSenderRulesPerUser)} rules per user.`,
		)
	}

	return {
		id,
		userId: input.userId,
		kind: input.kind,
		value,
		effect: input.effect,
		note,
		createdAt: timestamp,
		updatedAt: timestamp,
	}
}

export async function deleteEmailSenderRule(input: {
	db: D1Database
	userId: string
	ruleId: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`DELETE FROM email_sender_rules
			WHERE id = ?
				AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.ruleId, input.userId)
		.run()
	return Number(result.meta.changes ?? 0) > 0
}

export async function evaluateEmailSenderRules(input: {
	db: D1Database
	userId: string
	senderAddress: string
}): Promise<{
	effect: EmailSenderRuleEffect
	rule: EmailSenderRuleRecord
} | null> {
	const senderAddress = normalizeSenderRuleValue(input.senderAddress)
	if (!senderAddress) return null

	const addressRule = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_rules
			WHERE user_id = ?
				AND kind = 'address'
				AND value = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, senderAddress)
		.first<Record<string, unknown>>()
	if (addressRule) {
		const rule = mapSenderRuleRow(addressRule)
		return { effect: rule.effect, rule }
	}

	const atIndex = senderAddress.lastIndexOf('@')
	if (atIndex <= 0 || atIndex === senderAddress.length - 1) {
		return null
	}
	const senderDomain = senderAddress.slice(atIndex + 1)
	if (!senderDomain) return null

	const domainRule = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_rules
			WHERE user_id = ?
				AND kind = 'domain'
				AND (
					value = ?
					OR ? LIKE '%.' || value
				)${andLiveDeletedAtSql()}
			ORDER BY length(value) DESC, id ASC LIMIT 1`,
		)
		.bind(input.userId, senderDomain, senderDomain)
		.first<Record<string, unknown>>()
	if (!domainRule) return null

	const rule = mapSenderRuleRow(domainRule)
	return { effect: rule.effect, rule }
}
