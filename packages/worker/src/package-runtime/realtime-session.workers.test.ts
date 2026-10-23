import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	packageRealtimeSessionRpc,
	type PackageRealtimeSession,
	resolvePackageAppWorkerBuildInput,
} from './realtime-session.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
function createBinding(
	overrides?: Partial<{
		userId: string
		packageId: string
		kodyId: string
		sourceId: string
		baseUrl: string
	}>,
) {
	return {
		env,
		userId: ownerIdFromStored(overrides?.userId ?? 'user-1'),
		packageId: overrides?.packageId ?? 'package-1',
		kodyId: overrides?.kodyId ?? 'example',
		sourceId: overrides?.sourceId ?? 'source-1',
		baseUrl: overrides?.baseUrl ?? 'https://example.com',
	}
}

function bindingState({
	env: _env,
	...state
}: ReturnType<typeof createBinding>) {
	return state
}

function postSession(
	instance: { fetch: (request: Request) => Promise<Response> },
	path: string,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
) {
	return instance.fetch(
		new Request(`https://package-realtime.invalid/session/${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
		}),
	)
}

function getStub(binding: ReturnType<typeof createBinding>) {
	const namespace =
		env.PACKAGE_REALTIME_SESSION as DurableObjectNamespace<PackageRealtimeSession>
	return namespace.get(
		namespace.idFromName(JSON.stringify([binding.userId, binding.packageId])),
	)
}

test('package realtime connect upgrades through the real durable object stub and hands the request to the connect hook', async () => {
	const binding = createBinding({
		packageId: `package-${crypto.randomUUID()}`,
	})
	const hookPayloads: Array<{
		event: string
		facet: string
		request?: { url: string; method: string; headers: Record<string, string> }
	}> = []

	await runInDurableObject(
		getStub(binding),
		async (instance: PackageRealtimeSession) => {
			const anyInstance = instance as unknown as {
				resolveRealtimeHookResult: (input: {
					payload: (typeof hookPayloads)[number]
				}) => Promise<Array<unknown>>
			}
			anyInstance.resolveRealtimeHookResult = async ({ payload }) => {
				hookPayloads.push(payload)
				return []
			}
		},
	)

	// A cross-isolate stub.fetch with `Upgrade: websocket` is sent as a
	// WebSocket handshake with no body, so this must go through the real stub
	// rather than calling the instance's fetch in-process.
	const response = await packageRealtimeSessionRpc(binding).connect(
		new Request('https://kentcdodds.kody.run/packages/pr-desk/ws/chat', {
			headers: {
				Upgrade: 'websocket',
				'Sec-WebSocket-Protocol': 'kody',
				'User-Agent': 'Mozilla/5.0 test',
			},
		}),
		'chat',
	)

	expect(response.status).toBe(101)
	expect(response.webSocket).toBeTruthy()
	response.webSocket?.accept()
	expect(hookPayloads).toHaveLength(1)
	expect(hookPayloads[0]).toMatchObject({
		event: 'connect',
		facet: 'chat',
		request: {
			url: 'https://kentcdodds.kody.run/packages/pr-desk/ws/chat',
			method: 'GET',
			headers: {
				upgrade: 'websocket',
				'sec-websocket-protocol': 'kody',
				'user-agent': 'Mozilla/5.0 test',
			},
		},
	})
	await expect(
		packageRealtimeSessionRpc(binding).listSessions(),
	).resolves.toMatchObject({ sessions: [{ facet: 'chat' }] })
	response.webSocket?.close(1000, 'test-done')
})

test('package realtime session broadcast and disconnect paths tolerate partial delivery and socket close errors', async () => {
	const binding = createBinding()
	const stub = getStub(binding)

	await runInDurableObject(stub, async (instance: PackageRealtimeSession) => {
		const anyInstance = instance as unknown as {
			listSessions: (input?: {
				facet?: string | null
				topic?: string | null
			}) => Array<{ session_id: string }>
			emitToSession: (
				sessionId: string,
				data: unknown,
			) => Promise<{ delivered: boolean }>
			getSocketBySessionId: (sessionId: string) => {
				send: (data: string) => void
				close: () => void
			}
			stateSnapshot: {
				sessions: Record<string, { id: string; topics?: Array<string> }>
			}
			persistState: () => Promise<void>
			broadcast: (input: {
				facet?: string | null
				topic?: string | null
				data: unknown
			}) => Promise<{ deliveredCount: number; sessionIds: Array<string> }>
			applyHookActions: (
				sessionId: string,
				actions: Array<{ type: 'close'; code?: number; reason?: string }>,
			) => Promise<void>
			initializeBinding: (bindingState: unknown) => Promise<void>
			fetch: (request: Request) => Promise<Response>
		}

		const expectPartialBroadcast = () =>
			expect(
				anyInstance.broadcast({ data: { type: 'broadcast' } }),
			).resolves.toEqual({ deliveredCount: 1, sessionIds: ['session-1'] })
		anyInstance.listSessions = () => [
			{ session_id: 'session-1' },
			{ session_id: 'session-2' },
		]
		anyInstance.emitToSession = async (sessionId) => ({
			delivered: sessionId === 'session-1',
		})

		await expectPartialBroadcast()

		anyInstance.stateSnapshot = {
			sessions: {
				'session-1': { id: 'session-1' },
				'session-2': { id: 'session-2' },
			},
		}
		anyInstance.persistState = async () => undefined
		anyInstance.getSocketBySessionId = (sessionId) => ({
			send: () => {
				if (sessionId === 'session-2') {
					throw new Error('socket closing')
				}
			},
			close: () => {
				throw new Error('socket already closing')
			},
		})

		await expectPartialBroadcast()

		anyInstance.stateSnapshot = {
			sessions: {
				'session-1': { id: 'session-1', topics: [] },
			},
		}

		await expect(
			anyInstance.applyHookActions('session-1', [{ type: 'close' }]),
		).resolves.toBeUndefined()

		anyInstance.initializeBinding = async () => undefined

		const response = await postSession(anyInstance, 'disconnect', {
			binding: bindingState(binding),
			sessionId: 'session-1',
		})

		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ ok: true })
	})
})

test('package realtime session closes open sockets without running hooks once the owner is suspended', async () => {
	await ensureUsersTestSchema({
		db: env.APP_DB,
		columns: ['email_verified_at'],
	})
	const email = `realtime-suspended-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `rtsusp-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId: userId,
	})
	await env.APP_DB.prepare(
		`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()
	const binding = createBinding({ userId })
	let hookWorkerRequested = false
	const closes: Array<[number, string]> = []
	type SuspendedInstance = {
		stateSnapshot: {
			binding: unknown
			sessions: Record<string, unknown>
		}
		persistState: () => Promise<void>
		loadSessionId: (ws: WebSocket) => string | null
		getPackageAppWorker: () => Promise<never>
		closeAllSockets: (code: number, reason: string) => void
		handleWebSocketMessage: (ws: WebSocket, message: string) => Promise<void>
		fetch: (request: Request) => Promise<Response>
	}

	await runInDurableObject(
		getStub(binding),
		async (instance: PackageRealtimeSession) => {
			const anyInstance = instance as unknown as SuspendedInstance
			anyInstance.stateSnapshot = {
				binding: bindingState(binding),
				sessions: {
					'session-1': {
						id: 'session-1',
						facet: 'main',
						connectedAt: '2026-09-23T00:00:00.000Z',
						lastSeenAt: '2026-09-23T00:00:00.000Z',
						topics: [],
					},
				},
			}
			anyInstance.persistState = async () => undefined
			anyInstance.loadSessionId = () => 'session-1'
			anyInstance.getPackageAppWorker = async () => {
				hookWorkerRequested = true
				throw new Error('Suspended accounts must not reach package hooks.')
			}
			anyInstance.closeAllSockets = (code, reason) => {
				closes.push([code, reason])
			}

			await expect(
				anyInstance.handleWebSocketMessage({} as WebSocket, 'hello'),
			).resolves.toBeUndefined()
			expect(hookWorkerRequested).toBe(false)
			expect(closes).toEqual([[1008, 'account-suspended']])

			const post = (path: string, body: Record<string, unknown>) =>
				postSession(anyInstance, path, {
					binding: anyInstance.stateSnapshot.binding,
					...body,
				})
			const emitted = await post('emit', {
				sessionId: 'session-1',
				data: { type: 'hello' },
			})
			await expect(emitted.json()).resolves.toEqual({
				delivered: false,
				reason: 'account_suspended',
			})
			const broadcast = await post('broadcast', { data: { type: 'hello' } })
			await expect(broadcast.json()).resolves.toEqual({
				deliveredCount: 0,
				sessionIds: [],
			})
		},
	)

	const connect = await packageRealtimeSessionRpc(binding).connect(
		new Request('https://example.com/packages/example/ws', {
			headers: { Upgrade: 'websocket' },
		}),
		'main',
	)
	expect(connect.status).toBe(403)
	await expect(connect.json()).resolves.toMatchObject({
		ok: false,
		error: { code: 'account_suspended' },
	})
	expect(hookWorkerRequested).toBe(false)

	await runInDurableObject(
		getStub(binding),
		async (instance: PackageRealtimeSession) => {
			const anyInstance = instance as unknown as SuspendedInstance
			expect(Object.keys(anyInstance.stateSnapshot.sessions)).toEqual([
				'session-1',
			])
		},
	)
	expect(closes).toEqual(
		Array.from({ length: 4 }, () => [1008, 'account-suspended']),
	)
})

test('package realtime builds only for a personal org, never as a team org', async () => {
	await ensureUsersTestSchema({
		db: env.APP_DB,
		columns: ['email_verified_at'],
	})
	const email = `realtime-team-${crypto.randomUUID()}@example.com`
	const personId = testStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `rtteam-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId: personId,
	})
	const teamOrgId = `org-${crypto.randomUUID()}`
	const now = new Date().toISOString()
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		).bind(teamOrgId, `team-${crypto.randomUUID().slice(0, 8)}`, now, now),
		env.APP_DB.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
		).bind(teamOrgId, personId, now),
	])
	const bindingFor = (userId: string) => {
		const { env: _env, ...binding } = createBinding({ userId })
		return binding
	}

	await expect(
		resolvePackageAppWorkerBuildInput({ env, binding: bindingFor(teamOrgId) }),
	).rejects.toThrow(
		"Package realtime serves only a person's own personal-org apps.",
	)
	const personal = await resolvePackageAppWorkerBuildInput({
		env,
		binding: bindingFor(personId),
	}).catch((error: unknown) => error)
	expect(String(personal)).not.toContain('personal-org apps')
})
