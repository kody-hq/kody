import {
	isUsageCampaignOrigin,
	isUsageCampaignState,
	type UsageCampaignMailTemplate,
	type UsageCampaignOrigin,
	type UsageCampaignState,
} from './campaign-states.ts'
import type { UsageCampaignPersisted } from './campaign-evaluator.ts'

export type UsageCampaignRow = {
	user_id: string
	state: UsageCampaignState
	entered_at: string
	send_count: number
	last_sent_at: string | null
	last_evaluated_at: string
	origin: UsageCampaignOrigin
	cooling_terminal: number
	ever_activated: number
	first_activated_at: string | null
	advocate_sent_at: string | null
	created_at: string
	updated_at: string
}

export function campaignRowToPersisted(
	row: UsageCampaignRow | null,
): UsageCampaignPersisted {
	if (!row) {
		return {
			state: null,
			enteredAt: null,
			sendCount: 0,
			lastSentAt: null,
			origin: null,
			coolingTerminal: false,
			everActivated: false,
			firstActivatedAt: null,
			advocateSentAt: null,
		}
	}
	return {
		state: row.state,
		enteredAt: row.entered_at,
		sendCount: row.send_count,
		lastSentAt: row.last_sent_at,
		origin: row.origin,
		coolingTerminal: row.cooling_terminal === 1,
		everActivated: row.ever_activated === 1,
		firstActivatedAt: row.first_activated_at,
		advocateSentAt: row.advocate_sent_at,
	}
}

export async function readUsageCampaign(
	db: D1Database,
	userId: string,
): Promise<UsageCampaignRow | null> {
	const row = await db
		.prepare(
			`SELECT user_id, state, entered_at, send_count, last_sent_at,
			        last_evaluated_at, origin, cooling_terminal, ever_activated,
			        first_activated_at, advocate_sent_at,
			        created_at, updated_at
			 FROM user_usage_campaigns WHERE user_id = ?`,
		)
		.bind(userId)
		.first<UsageCampaignRow>()
	return row ? parseCampaignRow(row) : null
}

export async function upsertUsageCampaign(input: {
	db: D1Database
	userId: string
	state: UsageCampaignState
	enteredAt: string
	sendCount: number
	lastSentAt: string | null
	origin: UsageCampaignOrigin
	coolingTerminal: boolean
	everActivated: boolean
	firstActivatedAt?: string | null
	advocateSentAt?: string | null
	now: Date
}) {
	const nowIso = input.now.toISOString()
	await input.db
		.prepare(
			`INSERT INTO user_usage_campaigns (
				user_id, state, entered_at, send_count, last_sent_at,
				last_evaluated_at, origin, cooling_terminal, ever_activated,
				first_activated_at, advocate_sent_at,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				state = excluded.state,
				entered_at = excluded.entered_at,
				send_count = CASE
					WHEN excluded.state = user_usage_campaigns.state
						THEN MAX(user_usage_campaigns.send_count, excluded.send_count)
					ELSE excluded.send_count
				END,
				last_sent_at = CASE
					WHEN excluded.state != user_usage_campaigns.state
						THEN excluded.last_sent_at
					WHEN excluded.last_sent_at IS NULL
						THEN user_usage_campaigns.last_sent_at
					WHEN user_usage_campaigns.last_sent_at IS NULL
						THEN excluded.last_sent_at
					WHEN excluded.last_sent_at > user_usage_campaigns.last_sent_at
						THEN excluded.last_sent_at
					ELSE user_usage_campaigns.last_sent_at
				END,
				last_evaluated_at = excluded.last_evaluated_at,
				origin = CASE
					WHEN user_usage_campaigns.origin = 'event' THEN 'event'
					ELSE excluded.origin
				END,
				cooling_terminal = MAX(
					user_usage_campaigns.cooling_terminal,
					excluded.cooling_terminal
				),
				ever_activated = MAX(
					user_usage_campaigns.ever_activated,
					excluded.ever_activated
				),
				first_activated_at = COALESCE(
					user_usage_campaigns.first_activated_at,
					excluded.first_activated_at
				),
				advocate_sent_at = COALESCE(
					user_usage_campaigns.advocate_sent_at,
					excluded.advocate_sent_at
				),
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.userId,
			input.state,
			input.enteredAt,
			input.sendCount,
			input.lastSentAt,
			nowIso,
			input.origin,
			input.coolingTerminal ? 1 : 0,
			input.everActivated ? 1 : 0,
			input.firstActivatedAt ?? null,
			input.advocateSentAt ?? null,
			nowIso,
			nowIso,
		)
		.run()
}

/**
 * Claim one send in the ledger. UNIQUE(user_id, state, send_index) makes
 * the claim idempotent across overlapping hourly sweeps.
 */
export async function claimUsageCampaignSend(input: {
	db: D1Database
	userId: string
	state: UsageCampaignState
	template: UsageCampaignMailTemplate
	sendIndex: number
	now: Date
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`INSERT OR IGNORE INTO user_usage_campaign_sends (
				user_id, state, template, send_index, sent_at
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(
			input.userId,
			input.state,
			input.template,
			input.sendIndex,
			input.now.toISOString(),
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function releaseUsageCampaignSend(input: {
	db: D1Database
	userId: string
	state: UsageCampaignState
	sendIndex: number
}) {
	await input.db
		.prepare(
			`DELETE FROM user_usage_campaign_sends
			 WHERE user_id = ? AND state = ? AND send_index = ?`,
		)
		.bind(input.userId, input.state, input.sendIndex)
		.run()
}

export async function listUsageCampaignSends(db: D1Database, userId: string) {
	const result = await db
		.prepare(
			`SELECT user_id, state, template, send_index, sent_at
			 FROM user_usage_campaign_sends
			 WHERE user_id = ?
			 ORDER BY sent_at, send_index`,
		)
		.bind(userId)
		.all<{
			user_id: string
			state: string
			template: string
			send_index: number
			sent_at: string
		}>()
	return result.results ?? []
}

function parseCampaignRow(row: UsageCampaignRow): UsageCampaignRow {
	if (!isUsageCampaignState(row.state)) {
		throw new Error('Stored usage campaign state is not a registered state.')
	}
	if (!isUsageCampaignOrigin(row.origin)) {
		throw new Error('Stored usage campaign origin is not a registered origin.')
	}
	return {
		...row,
		send_count: Number(row.send_count),
		cooling_terminal: Number(row.cooling_terminal),
		ever_activated: Number(row.ever_activated),
	}
}
