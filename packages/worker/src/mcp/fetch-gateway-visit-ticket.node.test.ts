import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import * as usageModule from '#worker/usage/record-usage.ts'
import {
	mintPackageAppVisitTicket,
	resetPackageAppVisitNoncesForTests,
} from '#worker/package-runtime/package-app-visit-ticket.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

const userMeter = createInMemoryUserMeterEnv()
const env = {
	APP_DB: {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							return null
						},
						async all() {
							return { results: [], meta: { changes: 0 } }
						},
						async run() {
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database,
	...userMeter.env,
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	SENTRY_ENVIRONMENT: 'test',
} as unknown as Env

test('executeGatewayFetch verifies a visit ticket and refuses a forged one', async () => {
	resetPackageAppVisitNoncesForTests()
	const audience = {
		host: 'https://apps.example',
		packageId: 'pkg-1',
		kodyId: 'demo',
		sourceId: 'src-1',
		publishedCommit: 'commit-1',
	}
	const minted = await mintPackageAppVisitTicket({
		env,
		visitor: {
			userId: personIdFromStored('person-a'),
			username: 'alpha',
			role: 'member',
		},
		owner: {
			userId: ownerIdFromStored('org-1'),
			orgSlug: 'acme',
			email: 'owner@example.com',
			displayName: 'Acme',
		},
		audience,
		credentialClientBinding: 'run:visit-a',
	})
	const seen: Array<Request> = []
	const globalFetch = vi.fn(async (input: Request) => {
		seen.push(input)
		return new Response('ok')
	})
	const visitProps = {
		baseUrl: 'https://kody.example',
		userId: ownerIdFromStored('org-1'),
		email: null,
		request: null,
		storageContext: {
			sessionId: null,
			appId: 'pkg-1',
			packageId: 'pkg-1',
			storageId: null,
		},
		visitAudience: audience,
		credentialClientBinding: 'run:stale',
	}
	const ok = await executeGatewayFetch({
		env,
		props: visitProps,
		request: new Request('https://example.com', {
			headers: { 'X-Kody-Visit-Ticket': minted.ticket },
		}),
		globalFetch: globalFetch as unknown as typeof fetch,
	})
	expect(ok.status).toBe(200)
	expect(seen[0]?.headers.has('X-Kody-Visit-Ticket')).toBe(false)
	await expect(
		executeGatewayFetch({
			env,
			props: visitProps,
			request: new Request('https://example.com', {
				headers: { 'X-Kody-Visit-Ticket': minted.ticket.slice(0, -2) + 'xx' },
			}),
			globalFetch: globalFetch as unknown as typeof fetch,
		}),
	).rejects.toThrow('Package app visit ticket is not valid.')
})

test('a ticketless gateway fetch does not inherit a warm isolate first visitor', async () => {
	resetPackageAppVisitNoncesForTests()
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const waitUntilTasks: Array<Promise<unknown>> = []
	const response = await executeGatewayFetch({
		env,
		props: {
			baseUrl: 'https://kody.example',
			userId: ownerIdFromStored('org-1'),
			email: null,
			request: {
				org: { id: ownerIdFromStored('org-1'), slug: 'acme' },
				actor: {
					userId: personIdFromStored('person-stale'),
					username: 'stale',
				},
				attribution: {
					kind: 'user',
					userId: personIdFromStored('person-stale'),
				},
				credential: {
					kind: 'package-app',
					id: null,
					orgId: ownerIdFromStored('org-1'),
					scopes: null,
				},
				membership: { role: 'owner' },
			},
			storageContext: {
				sessionId: null,
				appId: 'pkg-1',
				packageId: 'pkg-1',
				storageId: null,
			},
			visitAudience: {
				host: 'https://apps.example',
				packageId: 'pkg-1',
				kodyId: 'demo',
				sourceId: 'src-1',
				publishedCommit: 'commit-1',
			},
			credentialClientBinding: 'run:first-visitor',
		},
		request: new Request('https://example.com/anon'),
		globalFetch: vi.fn(
			async () => new Response('anon'),
		) as unknown as typeof fetch,
		waitUntil: (promise) => {
			waitUntilTasks.push(promise)
		},
	})
	await response.arrayBuffer()
	await Promise.all(waitUntilTasks)
	expect(recordUsageSpy).toHaveBeenCalled()
	const usage = recordUsageSpy.mock.calls[0]?.[1] as {
		actorUserId?: string
	}
	expect(usage.actorUserId).toBeUndefined()
	recordUsageSpy.mockRestore()
})
