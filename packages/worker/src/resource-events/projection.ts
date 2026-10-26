/**
 * Resource change events: one generic `<resource>.created`, `.updated`, and
 * `.deleted` topic per resource kind, plus a few specific verbs
 * (`credential.rotated`, `credential.disconnected`, `package.published`).
 *
 * Every event is a projection of one newly inserted, successful org audit
 * row, so the org audit log is the single choke point: a change that is not
 * audited does not emit. This module is pure and small on purpose: the org
 * audit outbox imports it to decide whether a row emits at all, and loads the
 * delivery code (`dispatch.ts`) only when it does.
 */

export const resourceEventKinds = [
	'credential',
	'package',
	'job',
	'trigger',
	'membership',
	'memory',
] as const

export type ResourceEventKind = (typeof resourceEventKinds)[number]

/** Every topic a resource change event is delivered on. */
export const resourceEventTopics = [
	'credential.created',
	'credential.updated',
	'credential.deleted',
	'credential.rotated',
	'credential.disconnected',
	'package.created',
	'package.updated',
	'package.deleted',
	'package.published',
	'job.created',
	'job.updated',
	'job.deleted',
	'trigger.updated',
	'membership.created',
	'membership.updated',
	'membership.deleted',
	'memory.created',
	'memory.updated',
	'memory.deleted',
] as const

export type ResourceEventTopic = (typeof resourceEventTopics)[number]

/**
 * Fields with a fixed set of values. Only these carry before and after
 * values; every other change is sent as a changed field name only.
 */
export const resourceEventValueFields = [
	'role',
	'visibility',
	'enabled',
	'disabled_reason',
] as const

export type ResourceEventValueField = (typeof resourceEventValueFields)[number]

export type ResourceEventValueChange = { before: unknown; after: unknown }

/** Resource change event chains stop after this many hops. */
export const maxResourceEventDepth = 3

const credentialUpdateActions = new Set([
	'credential.renamed',
	'credential.allowed_packages_updated',
	'credential.hosts_updated',
	'credential.details_updated',
	'credential.enabled_changed',
	'credential.fields_updated',
	'credential.kind_set',
	'credential.personal_org_granted',
	'credential.personal_org_revoked',
])

const directActions: Record<string, ResourceEventTopic> = {
	'credential.created': 'credential.created',
	'credential.value_replaced': 'credential.rotated',
	'credential.deleted': 'credential.deleted',
	'credential.disconnected': 'credential.disconnected',
	'package.updated': 'package.updated',
	'package.deleted': 'package.deleted',
	'job.created': 'job.created',
	'job.updated': 'job.updated',
	'job.deleted': 'job.deleted',
	'job.toggled': 'job.updated',
	'enablement.toggled': 'trigger.updated',
	'member.added': 'membership.created',
	'member.role_changed': 'membership.updated',
	'member.removed': 'membership.deleted',
	'memory.created': 'memory.created',
	'memory.updated': 'memory.updated',
	'memory.deleted': 'memory.deleted',
}

const grantActions = new Set([
	'grant.created',
	'grant.updated',
	'grant.revoked',
])

const grantResourceKinds: Record<string, ResourceEventKind> = {
	credential: 'credential',
	package: 'package',
	job: 'job',
	memory: 'memory',
}

/** Whether a successful audit row with this action emits an event. */
export function isResourceChangeAuditAction(action: string) {
	return (
		action in directActions ||
		action === 'package.published' ||
		credentialUpdateActions.has(action) ||
		grantActions.has(action)
	)
}

export type ResourceChangeAuditRow = {
	action: string
	resourceType: string | null
	resourceId: string | null
	targetUserId: string | null
	detailsJson: string | null
}

export type ResourceChangeProjection = {
	topic: ResourceEventTopic
	kind: ResourceEventKind
	/** Internal: the audience check and name lookup. Never sent. */
	resourceId: string | null
	/** Internal: the member a membership event is about. Never sent. */
	targetUserId: string | null
	/** Display name from the audit row, when it has one. */
	name: string | null
	credentialKind: string | null
	changedFields: Array<string>
	changes: Partial<Record<ResourceEventValueField, ResourceEventValueChange>>
}

type Details = Record<string, unknown>

function parseDetails(json: string | null): Details {
	if (!json) return {}
	try {
		const parsed = JSON.parse(json) as unknown
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Details)
			: {}
	} catch {
		return {}
	}
}

function isValueChange(value: unknown): value is ResourceEventValueChange {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		'before' in value &&
		'after' in value
	)
}

function snakeCase(field: string) {
	return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function stringOrNull(value: unknown) {
	return typeof value === 'string' && value.trim() ? value : null
}

/** Field names from `details.fields`, else from its before and after keys. */
function detailFields(details: Details): Array<string> {
	if (Array.isArray(details.fields)) {
		return details.fields.filter(
			(field): field is string => typeof field === 'string',
		)
	}
	return Object.entries(details)
		.filter(([, value]) => isValueChange(value))
		.map(([key]) => snakeCase(key))
}

function sameValue(left: unknown, right: unknown) {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function topicFor(
	row: ResourceChangeAuditRow,
	details: Details,
): { topic: ResourceEventTopic; kind: ResourceEventKind } | null {
	if (credentialUpdateActions.has(row.action)) {
		return { topic: 'credential.updated', kind: 'credential' }
	}
	if (row.action === 'package.published') {
		return details.firstPublish === true
			? { topic: 'package.created', kind: 'package' }
			: { topic: 'package.published', kind: 'package' }
	}
	if (grantActions.has(row.action)) {
		const kind = grantResourceKinds[row.resourceType ?? '']
		return kind
			? { topic: `${kind}.updated` as ResourceEventTopic, kind }
			: null
	}
	const topic = directActions[row.action]
	if (!topic) return null
	return { topic, kind: topic.split('.')[0] as ResourceEventKind }
}

function toggleState(value: unknown) {
	return value === 'on' || value === 'off' || value === 'paused' ? value : null
}

/**
 * The event one audit row emits, or null when the row is not a resource
 * change. Values are never copied from the row except the fixed-option
 * fields in {@link resourceEventValueFields}.
 */
export function projectResourceChange(
	row: ResourceChangeAuditRow,
): ResourceChangeProjection | null {
	const details = parseDetails(row.detailsJson)
	const target = topicFor(row, details)
	if (!target) return null
	let changedFields = detailFields(details)
	const changes: ResourceChangeProjection['changes'] = {}
	switch (row.action) {
		case 'credential.value_replaced':
			changedFields = ['value']
			break
		case 'credential.personal_org_granted':
		case 'credential.personal_org_revoked':
			changedFields = ['shared_with_orgs']
			break
		case 'job.toggled':
		case 'enablement.toggled': {
			const from = toggleState(details.from)
			const to = toggleState(details.to)
			changedFields = ['enabled']
			changes.enabled = { before: from === 'on', after: to === 'on' }
			if (row.action === 'job.toggled') {
				const saved = details.disabledReason
				const disabledReason = isValueChange(saved)
					? saved
					: to === 'off' && from === 'on'
						? { before: null, after: stringOrNull(details.reason) }
						: null
				if (
					disabledReason &&
					!sameValue(disabledReason.before, disabledReason.after)
				) {
					changedFields.push('disabled_reason')
					changes.disabled_reason = disabledReason
				}
			}
			break
		}
		case 'member.added':
			changedFields = ['role']
			changes.role = { before: null, after: stringOrNull(details.role) }
			break
		case 'member.role_changed':
			changedFields = ['role']
			changes.role = {
				before: stringOrNull(details.previousRole),
				after: stringOrNull(details.role),
			}
			break
		case 'member.removed':
			changedFields = []
			break
		case 'grant.created':
		case 'grant.updated':
		case 'grant.revoked':
			changedFields = ['access']
			break
		case 'job.created':
			if (typeof details.enabled === 'boolean') {
				changes.enabled = { before: null, after: details.enabled }
			}
			break
		default:
			for (const field of ['visibility', 'enabled'] as const) {
				const value = details[field]
				if (isValueChange(value)) changes[field] = value
			}
	}
	const isGrant = grantActions.has(row.action)
	return {
		topic: target.topic,
		kind: target.kind,
		resourceId: row.resourceId,
		targetUserId: row.targetUserId,
		name: isGrant ? null : stringOrNull(details.name),
		credentialKind:
			target.kind === 'credential'
				? stringOrNull(details.credentialKind)
				: null,
		changedFields: [...new Set(changedFields)],
		changes,
	}
}

export type ResourceChangeEvent = {
	event: ResourceEventTopic
	event_id: string
	resource: {
		kind: ResourceEventKind
		name: string | null
		/** Credentials only: key, login, OAuth connection, MCP server, vault. */
		credential_kind?: string | null
	}
	org: { slug: string | null }
	changed_fields: Array<string>
	/** Before and after values, only for fixed-option fields. */
	changes: Partial<Record<ResourceEventValueField, ResourceEventValueChange>>
	/**
	 * Who made the change. Present only when the subscriber can read this
	 * org's audit log (`audit:read`), checked again at every delivery.
	 */
	actor?: { kind: 'person' | 'automation'; username: string | null }
	occurred_at: string
}

export function buildResourceChangeEvent(input: {
	projection: ResourceChangeProjection
	name: string | null
	orgSlug: string | null
	occurredAt: string
	eventId: string
	actor?: ResourceChangeEvent['actor'] | null
}): ResourceChangeEvent {
	const { projection } = input
	return {
		event: projection.topic,
		event_id: input.eventId,
		resource: {
			kind: projection.kind,
			name: input.name,
			...(projection.kind === 'credential'
				? { credential_kind: projection.credentialKind }
				: {}),
		},
		org: { slug: input.orgSlug },
		changed_fields: projection.changedFields,
		changes: projection.changes,
		...(input.actor ? { actor: input.actor } : {}),
		occurred_at: input.occurredAt,
	}
}
