import { expect, test, vi } from 'vitest'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

const spanCalls = vi.hoisted(() => ({
	spans: [] as Array<{
		name: string
		attributes: Record<string, boolean | number | string | undefined>
	}>,
}))

vi.mock('cloudflare:workers', () => ({
	tracing: {
		enterSpan(
			name: string,
			callback: (span: {
				isTraced: boolean
				setAttribute(key: string, value?: boolean | number | string): void
				end(): void
			}) => unknown,
		) {
			const attributes: Record<string, boolean | number | string | undefined> =
				{}
			spanCalls.spans.push({ name, attributes })
			return callback({
				isTraced: true,
				setAttribute(key, value) {
					attributes[key] = value
				},
				end() {},
			})
		},
	},
}))

const {
	automationSourceForAnalytics,
	recordUsage,
	usageAttributionFieldsFromRequest,
	usageConnectionFieldsFromRequest,
	usageConnectionKey,
	usageEventBlobIndexes,
	usageEventBlobs,
} = await import('./record-usage.ts')

test('recordUsage emits kody.usage spans with attributes and skips empty userId', async () => {
	spanCalls.spans.length = 0

	await recordUsage(
		{},
		{
			userId: ownerIdFromStored('user-1'),
			eventType: 'execute',
			entityId: 'pkg-1',
			durationMs: 120,
			bytes: 512,
			outcome: 'error',
		},
	)
	expect(spanCalls.spans).toEqual([
		{
			name: 'kody.usage.execute',
			attributes: {
				'kody.user_id': 'user-1',
				'kody.event_type': 'execute',
				'kody.outcome': 'error',
				'kody.entity_id': 'pkg-1',
				'kody.duration_ms': 120,
				'kody.bytes': 512,
				'kody.actor_user_id': 'user-1',
			},
		},
	])

	spanCalls.spans.length = 0
	await recordUsage(
		{},
		{
			userId: ownerIdFromStored('user-2'),
			eventType: 'job_run',
			outcome: 'success',
		},
	)
	expect(spanCalls.spans).toEqual([
		{
			name: 'kody.usage.job_run',
			attributes: {
				'kody.user_id': 'user-2',
				'kody.event_type': 'job_run',
				'kody.outcome': 'success',
				'kody.actor_user_id': 'user-2',
			},
		},
	])

	spanCalls.spans.length = 0
	await recordUsage(
		{},
		{ userId: '' as OwnerId, eventType: 'execute', outcome: 'success' },
	)
	expect(spanCalls.spans).toEqual([])
})

test('usageEventBlobs default actor to org billing id and map automation sources', () => {
	const ts = '2026-09-01T00:00:00.000Z'
	expect(
		usageEventBlobs(
			{
				userId: ownerIdFromStored('org-1'),
				eventType: 'execute',
				outcome: 'success',
			},
			ts,
		)[usageEventBlobIndexes.actorUserId],
	).toBe('org-1')
	expect(
		usageEventBlobs(
			{
				userId: ownerIdFromStored('org-1'),
				eventType: 'job_run',
				outcome: 'success',
				actorUserId: '',
				automationSource: 'schedule',
			},
			ts,
		),
	).toEqual([
		'org-1',
		'job_run',
		'',
		'success',
		ts,
		'',
		'',
		'',
		'',
		'',
		'schedule',
		'',
		'',
	])
	expect(
		usageEventBlobs(
			{
				userId: ownerIdFromStored('org-1'),
				eventType: 'package_static_call',
				outcome: 'error',
				errorName: 'credential_need_undeclared',
			},
			ts,
		)[usageEventBlobIndexes.errorName],
	).toBe('credential_need_undeclared')
})

test('usageAttributionFieldsFromRequest maps user and automation runs', () => {
	const personId = personIdFromStored('a'.repeat(64))
	const user = {
		userId: personId,
		username: 'ada',
		email: 'ada@example.com',
		displayName: 'Ada',
	}
	expect(
		usageAttributionFieldsFromRequest(
			deriveRequestContext({ user, source: { kind: 'session' } }),
		),
	).toEqual({
		actorUserId: personId,
		automationSource: '',
		connectionKey: `session:${personId}:`,
	})
	expect(
		usageAttributionFieldsFromRequest(
			deriveRequestContext({
				user,
				source: { kind: 'schedule', jobId: 'job-1' },
			}),
		),
	).toEqual({
		actorUserId: '',
		automationSource: 'schedule',
		connectionKey: 'schedule::job-1',
	})
	expect(automationSourceForAnalytics('event')).toBe('')
})

test('usageConnectionKey names the credential and its holder', () => {
	const personId = personIdFromStored('b'.repeat(64))
	const user = { userId: personId, username: 'brad' }
	const cliClientId = 'https://kody.example/oauth/cli-client-metadata.json'
	expect(
		usageConnectionKey(
			deriveRequestContext({
				user,
				source: { kind: 'mcp-oauth' },
				oauthClientId: 'slack-bot-client',
			}),
		),
	).toBe(`mcp-oauth:${personId}:slack-bot-client`)
	expect(
		usageConnectionKey(
			deriveRequestContext({
				user,
				source: { kind: 'cli' },
				oauthClientId: cliClientId,
			}),
		),
	).toBe(`cli:${personId}:${cliClientId}`)
	expect(
		usageConnectionKey(
			deriveRequestContext({
				user,
				source: { kind: 'api-token', tokenId: 'tok-1' },
				oauthClientId: 'ignored',
			}),
		),
	).toBe(`api-token:${personId}:tok-1`)
	expect(usageConnectionKey(null)).toBe('')
	expect(usageConnectionFieldsFromRequest(null)).toEqual({})
	expect(
		usageEventBlobs(
			{
				userId: ownerIdFromStored('org-1'),
				eventType: 'execute',
				outcome: 'success',
				connectionKey: `mcp-oauth:${personId}:slack-bot-client`,
			},
			'2026-10-10T00:00:00.000Z',
		)[usageEventBlobIndexes.connectionKey],
	).toBe(`mcp-oauth:${personId}:slack-bot-client`)
})
