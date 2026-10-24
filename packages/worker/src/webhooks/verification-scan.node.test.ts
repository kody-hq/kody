import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { type RunRecord } from '#worker/run-records/types.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { scanWebhookVerification } from './verification-scan.ts'

const mocks = vi.hoisted(() => ({
	listRunRecords: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: mocks.listRunRecords,
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

function manifest(webhooks: Array<Record<string, unknown>>) {
	return { manifest: { name: '@x/pkg', kody: { webhooks } } }
}

function delivery(input: {
	endpointId: string
	startedAt: string
	status: 'success' | 'error'
}): RunRecord {
	return {
		id: crypto.randomUUID(),
		surface: 'webhook',
		status: input.status,
		name: null,
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: input.startedAt,
		finishedAt: null,
		durationMs: null,
		errorName: null,
		errorMessage: null,
		errorTriage: null,
		triageNote: null,
		triagedAt: null,
		triagedBy: null,
		startedBy: null,
		metadata: { endpointId: input.endpointId, httpStatus: 202 },
		logCount: 0,
	}
}

test('the scan lists live webhooks that rely on the URL secret alone, with their recent deliveries', async () => {
	const endpointRows = [
		{
			id: 'ep-relay',
			enabled: 1,
			user_id: 'org-kent',
			package_id: 'pkg-desk',
			webhook_name: 'relay',
			owner_slug: 'kentcdodds',
			kody_id: 'pr-desk',
			source_id: 'src-desk',
		},
		{
			id: 'ep-stripe',
			enabled: 1,
			user_id: 'org-kent',
			package_id: 'pkg-stripe',
			webhook_name: 'stripe',
			owner_slug: 'kentcdodds',
			kody_id: 'stripe-alerts',
			source_id: 'src-stripe',
		},
		{
			id: 'ep-github',
			enabled: 1,
			user_id: 'org-kent',
			package_id: 'pkg-desk',
			webhook_name: 'github-pr',
			owner_slug: 'kentcdodds',
			kody_id: 'pr-desk',
			source_id: 'src-desk',
		},
		{
			id: 'ep-gone',
			enabled: 1,
			user_id: 'org-kent',
			package_id: 'pkg-desk',
			webhook_name: 'removed',
			owner_slug: 'kentcdodds',
			kody_id: 'pr-desk',
			source_id: 'src-desk',
		},
		{
			id: 'ep-upload',
			enabled: 0,
			user_id: 'org-ada',
			package_id: 'pkg-planner',
			webhook_name: 'upload',
			owner_slug: 'ada',
			kody_id: 'feature-planner',
			source_id: 'src-planner',
		},
		{
			id: 'ep-broken',
			enabled: 1,
			user_id: 'org-ada',
			package_id: 'pkg-broken',
			webhook_name: 'hook',
			owner_slug: 'ada',
			kody_id: 'broken',
			source_id: 'src-broken',
		},
	]
	const prepared: Array<string> = []
	const env = {
		APP_DB: {
			prepare(sql: string) {
				prepared.push(sql)
				const statement = {
					bind() {
						return statement
					},
					async all() {
						return { results: endpointRows }
					},
				}
				return statement
			},
		},
	} as unknown as Env
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			switch (input.sourceId) {
				case 'src-stripe':
					return manifest([{ name: 'stripe', export: './stripe' }])
				case 'src-desk':
					return manifest([
						{
							name: 'github-pr',
							export: './github',
							verification: {
								type: 'hmac-sha256',
								header: 'x-hub-signature-256',
								encoding: 'hex',
								prefix: 'sha256=',
							},
						},
						{
							name: 'relay',
							export: './relay',
							verification: { type: 'url-secret' },
						},
					])
				case 'src-planner':
					return manifest([{ name: 'upload', export: './upload' }])
				default:
					throw new Error('manifest unavailable')
			}
		},
	)
	const runsByOwner: Record<string, Array<RunRecord>> = {
		'org-kent': [
			delivery({
				endpointId: 'ep-stripe',
				startedAt: '2026-10-12T05:10:30.000Z',
				status: 'success',
			}),
			delivery({
				endpointId: 'ep-stripe',
				startedAt: '2026-10-12T04:00:00.000Z',
				status: 'success',
			}),
			delivery({
				endpointId: 'ep-stripe',
				startedAt: '2026-10-12T03:14:00.000Z',
				status: 'error',
			}),
			delivery({
				endpointId: 'ep-github',
				startedAt: '2026-10-12T05:00:00.000Z',
				status: 'success',
			}),
		],
		'org-ada': [],
	}
	mocks.listRunRecords.mockImplementation(
		async (input: { userId: string }) => ({
			runs: runsByOwner[input.userId] ?? [],
			nextCursor: null,
		}),
	)
	consoleWarn.mockImplementation(() => {})

	const scan = await scanWebhookVerification({
		env,
		since: '2026-10-11T00:00:00-06:00',
		includeSignature: false,
	})

	expect(prepared[0]).toContain("state <> 'off'")
	expect(prepared[0]).toContain('AS enabled')
	expect(prepared[0]).toContain('e.deleted_at IS NULL')
	expect(consoleWarn).toHaveBeenCalledWith(
		'webhook-verification-scan-manifest-failed',
		expect.objectContaining({ sourceId: 'src-broken' }),
	)
	expect(scan).toMatchObject({
		since: '2026-10-11T06:00:00.000Z',
		endpointsScanned: 6,
		ownersFailed: [],
		truncated: false,
		totals: {
			implicit_url_secret: 2,
			url_secret: 1,
			signature: 1,
			undeclared: 1,
			manifest_unavailable: 1,
			implicitUrlSecretOwners: 2,
			implicitUrlSecretDelivered: 2,
		},
	})
	expect(
		scan.endpoints.map((row) => [
			row.ownerSlug,
			row.packageKodyId,
			row.webhookName,
			row.status,
			row.delivered,
		]),
	).toEqual([
		['ada', 'broken', 'hook', 'manifest_unavailable', 0],
		['ada', 'feature-planner', 'upload', 'implicit_url_secret', 0],
		['kentcdodds', 'pr-desk', 'relay', 'url_secret', 0],
		['kentcdodds', 'pr-desk', 'removed', 'undeclared', 0],
		['kentcdodds', 'stripe-alerts', 'stripe', 'implicit_url_secret', 2],
	])
	expect(
		scan.endpoints.find((row) => row.endpointId === 'ep-stripe'),
	).toMatchObject({
		verification: null,
		lastDeliveredAt: '2026-10-12T05:10:30.000Z',
	})
	expect(
		scan.endpoints.find((row) => row.endpointId === 'ep-relay')?.verification,
	).toEqual({ type: 'url-secret', header: null, secretName: null })

	expect(
		scan.endpoints.find((row) => row.endpointId === 'ep-upload')?.enabled,
	).toBe(false)

	const withSignature = await scanWebhookVerification({
		env,
		since: '2026-10-11T06:00:00.000Z',
		includeSignature: true,
		includeDisabled: true,
	})
	expect(prepared.at(-1)).toContain("AND state <> 'off'")
	expect(prepared.at(-1)).toContain('AS enabled')
	expect(prepared.at(-1)).toContain('e.deleted_at IS NULL')
	expect(
		withSignature.endpoints.find((row) => row.endpointId === 'ep-github'),
	).toMatchObject({
		status: 'signature',
		enabled: true,
		verification: {
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			secretName: null,
		},
		delivered: 1,
	})
})
