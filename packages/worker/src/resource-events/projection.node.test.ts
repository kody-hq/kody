import { expect, test } from 'vitest'
import {
	buildResourceChangeEvent,
	isResourceChangeAuditAction,
	projectResourceChange,
	type ResourceChangeAuditRow,
} from './projection.ts'

function row(
	action: string,
	details: Record<string, unknown> | null = null,
	extra: Partial<ResourceChangeAuditRow> = {},
): ResourceChangeAuditRow {
	return {
		action,
		resourceType: null,
		resourceId: 'resource-1',
		targetUserId: null,
		detailsJson: details ? JSON.stringify(details) : null,
		...extra,
	}
}

test('only resource change actions emit', () => {
	expect(isResourceChangeAuditAction('credential.created')).toBe(true)
	expect(isResourceChangeAuditAction('credential.renamed')).toBe(true)
	expect(isResourceChangeAuditAction('package.published')).toBe(true)
	expect(isResourceChangeAuditAction('grant.revoked')).toBe(true)
	expect(isResourceChangeAuditAction('member.role_changed')).toBe(true)
	expect(isResourceChangeAuditAction('credential.used')).toBe(false)
	expect(isResourceChangeAuditAction('org.renamed')).toBe(false)
	expect(projectResourceChange(row('credential.used'))).toBeNull()
})

test('credential value replacement is a rotation with no values', () => {
	const projection = projectResourceChange(
		row('credential.value_replaced', {
			name: 'Deploy key',
			credentialKind: 'key',
			secretValue: 'never sent',
		}),
	)
	expect(projection).toMatchObject({
		topic: 'credential.rotated',
		kind: 'credential',
		name: 'Deploy key',
		credentialKind: 'key',
		changedFields: ['value'],
		changes: {},
	})
	expect(JSON.stringify(projection)).not.toContain('never sent')
})

test('credential updates send field names, never free-form values', () => {
	const projection = projectResourceChange(
		row('credential.renamed', {
			previousName: 'old name',
			fields: ['name'],
		}),
	)
	expect(projection).toMatchObject({
		topic: 'credential.updated',
		changedFields: ['name'],
		changes: {},
	})
	expect(
		projectResourceChange(
			row('credential.hosts_updated', {
				hosts: { before: ['a.example'], after: ['b.example'] },
			}),
		),
	).toMatchObject({ changedFields: ['hosts'], changes: {} })
	expect(
		projectResourceChange(row('credential.personal_org_granted')),
	).toMatchObject({ changedFields: ['shared_with_orgs'] })
})

test('fixed-option fields carry before and after values', () => {
	expect(
		projectResourceChange(
			row('package.updated', {
				visibility: { before: 'private', after: 'org' },
				internetVisible: { before: false, after: true },
			}),
		),
	).toMatchObject({
		topic: 'package.updated',
		changedFields: ['visibility', 'internet_visible'],
		changes: { visibility: { before: 'private', after: 'org' } },
	})
	expect(
		projectResourceChange(
			row('credential.enabled_changed', {
				enabled: { before: true, after: false },
			}),
		),
	).toMatchObject({
		changedFields: ['enabled'],
		changes: { enabled: { before: true, after: false } },
	})
})

test('first publish creates a package, later publishes publish it', () => {
	expect(
		projectResourceChange(row('package.published', { firstPublish: true })),
	).toMatchObject({ topic: 'package.created' })
	expect(projectResourceChange(row('package.published', {}))).toMatchObject({
		topic: 'package.published',
	})
})

test('job toggles carry enabled and the disabled reason', () => {
	expect(
		projectResourceChange(
			row('job.toggled', {
				from: 'on',
				to: 'off',
				disabledReason: { before: null, after: 'credential_missing' },
			}),
		),
	).toMatchObject({
		topic: 'job.updated',
		changedFields: ['enabled', 'disabled_reason'],
		changes: {
			enabled: { before: true, after: false },
			disabled_reason: { before: null, after: 'credential_missing' },
		},
	})
	expect(
		projectResourceChange(row('enablement.toggled', { from: 'off', to: 'on' })),
	).toMatchObject({
		topic: 'trigger.updated',
		changedFields: ['enabled'],
		changes: { enabled: { before: false, after: true } },
	})
})

test('membership events carry the role', () => {
	expect(
		projectResourceChange(
			row(
				'member.role_changed',
				{ previousRole: 'member', role: 'admin' },
				{ targetUserId: 'user-2' },
			),
		),
	).toMatchObject({
		topic: 'membership.updated',
		targetUserId: 'user-2',
		changedFields: ['role'],
		changes: { role: { before: 'member', after: 'admin' } },
	})
	expect(projectResourceChange(row('member.removed'))).toMatchObject({
		topic: 'membership.deleted',
		changedFields: [],
	})
})

test('grants update the granted resource kind only', () => {
	expect(
		projectResourceChange(
			row('grant.created', { name: 'someone' }, { resourceType: 'job' }),
		),
	).toMatchObject({
		topic: 'job.updated',
		changedFields: ['access'],
		name: null,
	})
	expect(
		projectResourceChange(row('grant.created', {}, { resourceType: 'org' })),
	).toBeNull()
})

test('the envelope hides the actor unless one is passed', () => {
	const projection = projectResourceChange(
		row('credential.created', { name: 'Mail', credentialKind: 'connection' }),
	)!
	const event = buildResourceChangeEvent({
		projection,
		name: 'Mail',
		orgSlug: 'acme',
		occurredAt: '2026-01-01T00:00:00.000Z',
		eventId: 'event-1',
	})
	expect(event).toEqual({
		event: 'credential.created',
		event_id: 'event-1',
		resource: {
			kind: 'credential',
			name: 'Mail',
			credential_kind: 'connection',
		},
		org: { slug: 'acme' },
		changed_fields: [],
		changes: {},
		occurred_at: '2026-01-01T00:00:00.000Z',
	})
	expect(JSON.stringify(event)).not.toContain('resource-1')
	expect(
		buildResourceChangeEvent({
			projection,
			name: 'Mail',
			orgSlug: 'acme',
			occurredAt: '2026-01-01T00:00:00.000Z',
			eventId: 'event-1',
			actor: { kind: 'person', username: 'pat' },
		}).actor,
	).toEqual({ kind: 'person', username: 'pat' })
})
