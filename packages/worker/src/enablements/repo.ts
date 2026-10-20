import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	canonicalizeEnablementSender,
	isCompleteEnablementSender,
} from './sender-match.ts'
import {
	enablementPausedReasons,
	enablementTriggerKinds,
	enablementSenderKinds,
	type EnablementOrigin,
	type EnablementPause,
	type EnablementPausedReason,
	type EnablementRecord,
	type EnablementSenderKind,
	type EnablementState,
	type EnablementTriggerKind,
} from './types.ts'

type EnablementRow = {
	id: string
	org_id: string
	package_id: string
	trigger_kind: string
	trigger_name: string
	instance_id: string
	enabler_user_id: string
	state: string
	paused_reason: string | null
	paused_permission: string | null
	paused_resource_type: string | null
	paused_resource_id: string | null
	paused_credential_id: string | null
	paused_at: string | null
	origin: string
	sender_kind: string | null
	sender_value: string | null
	enabled_at: string
	disabled_at: string | null
	updated_at: string
}

const enablementColumns = `id, org_id, package_id, trigger_kind, trigger_name,
	instance_id, enabler_user_id, state, paused_reason, paused_permission,
	paused_resource_type, paused_resource_id, paused_credential_id, paused_at,
	origin, sender_kind, sender_value, enabled_at, disabled_at, updated_at`

function isTriggerKind(value: string): value is EnablementTriggerKind {
	return (enablementTriggerKinds as ReadonlyArray<string>).includes(value)
}

function isPausedReason(value: string): value is EnablementPausedReason {
	return (enablementPausedReasons as ReadonlyArray<string>).includes(value)
}

function toSenderKind(value: string | null): EnablementSenderKind | null {
	if (value === null) return null
	if ((enablementSenderKinds as ReadonlyArray<string>).includes(value)) {
		return value as EnablementSenderKind
	}
	throw new Error(`Unknown enablement sender kind: ${value}`)
}

function toState(value: string): EnablementState {
	if (value === 'on' || value === 'paused' || value === 'off') return value
	throw new Error(`Unknown enablement state: ${value}`)
}

function toPause(row: EnablementRow): EnablementPause | null {
	if (row.state !== 'paused' || !row.paused_reason || !row.paused_at) {
		return null
	}
	if (!isPausedReason(row.paused_reason)) {
		throw new Error(`Unknown enablement pause reason: ${row.paused_reason}`)
	}
	return {
		reason: row.paused_reason,
		permission: row.paused_permission,
		resourceType: row.paused_resource_type,
		resourceId: row.paused_resource_id,
		credentialId: row.paused_credential_id,
		pausedAt: row.paused_at,
	}
}

function toRecord(row: EnablementRow): EnablementRecord {
	if (!isTriggerKind(row.trigger_kind)) {
		throw new Error(`Unknown enablement trigger kind: ${row.trigger_kind}`)
	}
	return {
		id: row.id,
		orgId: ownerIdFromStored(row.org_id),
		packageId: row.package_id,
		triggerKind: row.trigger_kind,
		triggerName: row.trigger_name,
		instanceId: row.instance_id,
		enablerUserId: personIdFromStored(row.enabler_user_id),
		state: toState(row.state),
		pause: toPause(row),
		origin: row.origin === 'migrated' ? 'migrated' : 'enabled',
		senderKind: toSenderKind(row.sender_kind),
		senderValue: row.sender_value,
		enabledAt: row.enabled_at,
		disabledAt: row.disabled_at,
		updatedAt: row.updated_at,
	}
}

export type NewEnablement = {
	id?: string
	orgId: string
	packageId: string
	triggerKind: EnablementTriggerKind
	triggerName: string
	instanceId: string
	enablerUserId: string
	origin: EnablementOrigin
	/** Inbound-email sender rule. Omit for triggers that are not email. */
	senderKind?: EnablementSenderKind | null
	senderValue?: string | null
}

export function buildInsertEnablementStatement(input: {
	db: D1Database
	enablement: NewEnablement
	now: string
}): { id: string; statement: D1PreparedStatement } {
	const id = input.enablement.id ?? crypto.randomUUID()
	const requestedKind = input.enablement.senderKind ?? null
	const sender = canonicalizeEnablementSender({
		senderKind: requestedKind,
		senderValue: input.enablement.senderValue,
	})
	if (requestedKind && !isCompleteEnablementSender(sender)) {
		throw new Error(
			'Inbound email enablement needs a usable sender_kind and sender_value.',
		)
	}
	const statement = input.db
		.prepare(
			`INSERT INTO enablements (
				id, org_id, package_id, trigger_kind, trigger_name, instance_id,
				enabler_user_id, state, origin, enabled_at, updated_at,
				sender_kind, sender_value
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'on', ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.enablement.orgId,
			input.enablement.packageId,
			input.enablement.triggerKind,
			input.enablement.triggerName,
			input.enablement.instanceId,
			input.enablement.enablerUserId,
			input.enablement.origin,
			input.now,
			input.now,
			sender.senderKind,
			sender.senderValue,
		)
	return { id, statement }
}

/**
 * The webhook variant of the insert: writes nothing (0 changes) when the
 * instance already has a non-off enablement, so one URL runs as one enabler
 * even when two approvals race. The `enablements_webhook_one_live` index
 * backs it up at the database level.
 */
export function buildInsertWebhookEnablementStatement(input: {
	db: D1Database
	enablement: NewEnablement
	now: string
}): { id: string; statement: D1PreparedStatement } {
	if (input.enablement.triggerKind !== 'webhook') {
		throw new Error('Only a webhook enablement uses the one-live insert.')
	}
	const id = input.enablement.id ?? crypto.randomUUID()
	const sender = canonicalizeEnablementSender({
		senderKind: input.enablement.senderKind,
		senderValue: input.enablement.senderValue,
	})
	const statement = input.db
		.prepare(
			`INSERT INTO enablements (
				id, org_id, package_id, trigger_kind, trigger_name, instance_id,
				enabler_user_id, state, origin, enabled_at, updated_at,
				sender_kind, sender_value
			)
			SELECT ?, ?, ?, 'webhook', ?, ?, ?, 'on', ?, ?, ?, ?, ?
			WHERE NOT EXISTS (
				SELECT 1 FROM enablements
				WHERE org_id = ? AND trigger_kind = 'webhook'
				  AND instance_id = ? AND state <> 'off'
			)`,
		)
		.bind(
			id,
			input.enablement.orgId,
			input.enablement.packageId,
			input.enablement.triggerName,
			input.enablement.instanceId,
			input.enablement.enablerUserId,
			input.enablement.origin,
			input.now,
			input.now,
			sender.senderKind,
			sender.senderValue,
			input.enablement.orgId,
			input.enablement.instanceId,
		)
	return { id, statement }
}

/**
 * A batch statement that fails (malformed JSON, so the whole batch rolls back)
 * unless enablement `id` exists. Follows a webhook's one-live insert, which
 * writes nothing when another enabler got there first.
 */
export function buildEnablementInsertedGuardStatement(input: {
	db: D1Database
	id: string
}): D1PreparedStatement {
	return input.db
		.prepare(
			`SELECT CASE WHEN EXISTS (SELECT 1 FROM enablements WHERE id = ?)
			THEN 1 ELSE json(?) END AS inserted`,
		)
		.bind(input.id, 'webhook enablement was not inserted')
}

/** True for the unique-index error of a second live webhook enablement. */
export function isWebhookOneLiveConflict(error: unknown) {
	let current = error
	while (current instanceof Error) {
		if (
			/enablements_webhook_one_live|unique constraint failed: enablements\.org_id, enablements\.instance_id(?!,)/i.test(
				current.message,
			)
		) {
			return true
		}
		current = current.cause
	}
	return false
}

/** True for the unique-index error of a second live inbound-email sender rule. */
export function isEmailSenderOneLiveConflict(error: unknown) {
	let current = error
	while (current instanceof Error) {
		if (/enablements_email_sender_one_live/i.test(current.message)) return true
		current = current.cause
	}
	return false
}

export const emailSenderEnablementConflictMessage =
	'This sender already has a live email enablement for another person. Only one live rule runs for a sender.'

/** Another person already holds the live rule for this sender. */
export class EmailSenderEnablementConflict extends Error {
	constructor(message = emailSenderEnablementConflictMessage) {
		super(message)
		this.name = 'EmailSenderEnablementConflict'
	}
}

/** The live inbound-email enablement for one sender, if one exists. */
export async function findLiveEmailSenderEnablement(input: {
	db: D1Database
	orgId: string
	instanceId: string
	triggerName: string
	senderKind: EnablementSenderKind
	senderValue: string | null
}): Promise<EnablementRecord | null> {
	const sender = canonicalizeEnablementSender({
		senderKind: input.senderKind,
		senderValue: input.senderValue,
	})
	if (!sender.senderKind) return null
	const row = await input.db
		.prepare(
			`SELECT ${enablementColumns} FROM enablements
			 WHERE org_id = ? AND instance_id = ? AND trigger_kind = 'subscription'
			   AND trigger_name = ? AND sender_kind = ?
			   AND IFNULL(sender_value, '') = IFNULL(?, '')
			   AND state <> 'off'
			 LIMIT 1`,
		)
		.bind(
			input.orgId,
			input.instanceId,
			input.triggerName,
			sender.senderKind,
			sender.senderValue,
		)
		.first<EnablementRow>()
	return row ? toRecord(row) : null
}

function sameEnablerAndSender(
	existing: EnablementRecord,
	enablement: NewEnablement,
) {
	const sender = canonicalizeEnablementSender({
		senderKind: enablement.senderKind,
		senderValue: enablement.senderValue,
	})
	return (
		String(existing.enablerUserId) === String(enablement.enablerUserId) &&
		existing.senderKind === sender.senderKind &&
		(existing.senderValue ?? '') === (sender.senderValue ?? '')
	)
}

export async function insertEnablement(input: {
	db: D1Database
	enablement: NewEnablement
	now?: string
}): Promise<EnablementRecord> {
	const now = input.now ?? new Date().toISOString()
	const { id, statement } = buildInsertEnablementStatement({
		db: input.db,
		enablement: input.enablement,
		now,
	})
	try {
		await statement.run()
	} catch (error) {
		if (!isEmailSenderOneLiveConflict(error) || !input.enablement.senderKind) {
			throw error
		}
		const existing = await findLiveEmailSenderEnablement({
			db: input.db,
			orgId: input.enablement.orgId,
			instanceId: input.enablement.instanceId,
			triggerName: input.enablement.triggerName,
			senderKind: input.enablement.senderKind,
			senderValue: input.enablement.senderValue ?? null,
		})
		if (existing && sameEnablerAndSender(existing, input.enablement)) {
			return existing
		}
		if (existing) throw new EmailSenderEnablementConflict()
		// Unique failed but the winner is not readable yet — surface the DB error.
		throw error
	}
	const record = await getEnablementById({
		db: input.db,
		orgId: input.enablement.orgId,
		id,
	})
	if (!record) throw new Error('Unable to read the new enablement.')
	return record
}

export async function getEnablementById(input: {
	db: D1Database
	orgId: string
	id: string
}): Promise<EnablementRecord | null> {
	const row = await input.db
		.prepare(
			`SELECT ${enablementColumns} FROM enablements
			 WHERE id = ? AND org_id = ?`,
		)
		.bind(input.id, input.orgId)
		.first<EnablementRow>()
	return row ? toRecord(row) : null
}

/**
 * Enablements of one trigger instance that are not off. Subscriptions pass
 * the topic as `triggerName`, since one package may subscribe to several.
 */
export async function listEnablementsForInstance(input: {
	db: D1Database
	orgId: string
	triggerKind: EnablementTriggerKind
	instanceId: string
	triggerName?: string
}): Promise<Array<EnablementRecord>> {
	const byName = input.triggerName !== undefined
	const result = await input.db
		.prepare(
			`SELECT ${enablementColumns} FROM enablements
			 WHERE org_id = ? AND trigger_kind = ? AND instance_id = ?
			   AND state <> 'off'${byName ? ' AND trigger_name = ?' : ''}
			 ORDER BY enabled_at, id`,
		)
		.bind(
			input.orgId,
			input.triggerKind,
			input.instanceId,
			...(byName ? [input.triggerName] : []),
		)
		.all<EnablementRow>()
	return (result.results ?? []).map(toRecord)
}

/** Every enablement in an org, including off ones, for listing and backfill. */
export async function listEnablementsForOrg(input: {
	db: D1Database
	orgId: string
	enablerUserId?: string
	includeOff?: boolean
}): Promise<Array<EnablementRecord>> {
	const clauses = ['org_id = ?']
	const binds: Array<string> = [input.orgId]
	if (input.enablerUserId) {
		clauses.push('enabler_user_id = ?')
		binds.push(input.enablerUserId)
	}
	if (!input.includeOff) clauses.push(`state <> 'off'`)
	const result = await input.db
		.prepare(
			`SELECT ${enablementColumns} FROM enablements
			 WHERE ${clauses.join(' AND ')}
			 ORDER BY trigger_kind, trigger_name, enabled_at, id`,
		)
		.bind(...binds)
		.all<EnablementRow>()
	return (result.results ?? []).map(toRecord)
}

export type EnablementPauseInput = {
	reason: EnablementPausedReason
	permission?: string | null
	resourceType?: string | null
	resourceId?: string | null
	credentialId?: string | null
}

/**
 * Pause an `on` enablement, or with `replace` also rewrite a paused one's
 * cause. Returns false when nothing was written.
 */
export async function pauseEnablement(input: {
	db: D1Database
	orgId: string
	id: string
	pause: EnablementPauseInput
	replace?: boolean
	now?: string
}): Promise<boolean> {
	const now = input.now ?? new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE enablements
			 SET state = 'paused', paused_reason = ?, paused_permission = ?,
			     paused_resource_type = ?, paused_resource_id = ?,
			     paused_credential_id = ?, paused_at = ?, updated_at = ?
			 WHERE id = ? AND org_id = ? AND state IN (${
					input.replace ? `'on', 'paused'` : `'on'`
				})`,
		)
		.bind(
			input.pause.reason,
			input.pause.permission ?? null,
			input.pause.resourceType ?? null,
			input.pause.resourceId ?? null,
			input.pause.credentialId ?? null,
			now,
			now,
			input.id,
			input.orgId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** Resume a paused enablement. Returns false when it was not paused. */
export async function resumeEnablement(input: {
	db: D1Database
	orgId: string
	id: string
	now?: string
}): Promise<boolean> {
	const now = input.now ?? new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE enablements
			 SET state = 'on', paused_reason = NULL, paused_permission = NULL,
			     paused_resource_type = NULL, paused_resource_id = NULL,
			     paused_credential_id = NULL, paused_at = NULL, updated_at = ?
			 WHERE id = ? AND org_id = ? AND state = 'paused'`,
		)
		.bind(now, input.id, input.orgId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** Turn an enablement off for good. Returns false when it was already off. */
export async function disableEnablement(input: {
	db: D1Database
	orgId: string
	id: string
	now?: string
}): Promise<boolean> {
	const now = input.now ?? new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE enablements
			 SET state = 'off', disabled_at = ?, updated_at = ?
			 WHERE id = ? AND org_id = ? AND state <> 'off'`,
		)
		.bind(now, now, input.id, input.orgId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * The org's earliest current Owner with a live account: the enabler when an
 * item has no live creator. There is no system owner.
 */
export async function loadEarliestLiveOwnerId(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT m.user_id AS user_id
			 FROM org_memberships m
			 INNER JOIN users u ON u.stable_user_id = m.user_id
			 WHERE m.org_id = ? AND m.role = 'owner' AND m.deleted_at IS NULL
			   AND u.deleted_at IS NULL AND u.deleting_at IS NULL
			   AND u.suspended_at IS NULL
			 ORDER BY m.created_at, m.user_id
			 LIMIT 1`,
		)
		.bind(orgId)
		.first<{ user_id: string }>()
	return row?.user_id ?? null
}
