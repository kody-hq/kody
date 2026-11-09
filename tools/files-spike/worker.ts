import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import {
	clientMessageSchema,
	documentLimits,
	fromBase64,
	patchSchema,
	type Principal,
} from './contracts.ts'
import { DocumentFailure } from './document.ts'
import { localPrincipal, spikePeople } from './identity.ts'
import { DocumentSession } from './session.ts'
import {
	boundObjectStore,
	s3ObjectStore,
	type ExternalStorage,
} from './storage.ts'

type SpikeEnv = {
	DOCUMENTS: DurableObjectNamespace<SpikeDocument>
	DIRECTORY: DurableObjectNamespace<SpikeDirectory>
	INCLUDED_FILES: R2Bucket
	EXTERNAL_FILES: R2Bucket
	S3_CONFIGURATION?: string
	ASSETS: Fetcher
}
const fileId = z.string().uuid()
const createSchema = z.object({ name: z.string().trim().min(1).max(100) })
const principalSchema = z.object({
	orgId: z.string(),
	personId: z.string(),
	name: z.string(),
	kind: z.enum(['person', 'agent']),
})
const grantSchema = z.object({
	personId: z.string(),
	role: z.enum(['view', 'edit']).nullable(),
})
const moveSchema = z.object({ target: z.enum(['included', 'external']) })
const externalSchema = z.object({
	endpoint: z.string().url(),
	bucket: z.string().min(1),
	accessKeyId: z.string().min(1),
	secretAccessKey: z.string().min(1),
	region: z.string().min(1),
})

function failure(error: unknown) {
	if (error instanceof DocumentFailure)
		return Response.json(
			{ code: error.code, message: error.message },
			{ status: error.status },
		)
	if (error instanceof z.ZodError)
		return Response.json(
			{ code: 'invalid_input', message: 'Check the request fields.' },
			{ status: 400 },
		)
	console.error(
		'Files spike request failed',
		error instanceof Error ? error.name : 'Unknown error',
	)
	return Response.json(
		{
			code: 'request_failed',
			message: 'The operation failed. Your acknowledged edits are still saved.',
		},
		{ status: 500 },
	)
}

export class SpikeDocument extends DurableObject<SpikeEnv> {
	private session: DocumentSession
	private rates = new Map<string, { start: number; count: number }>()
	constructor(ctx: DurableObjectState, env: SpikeEnv) {
		super(ctx, env)
		this.session = new DocumentSession(
			ctx.storage,
			(location) => {
				if (location === 'included') return boundObjectStore(env.INCLUDED_FILES)
				if (env.S3_CONFIGURATION)
					return s3ObjectStore(
						externalSchema.parse(
							JSON.parse(env.S3_CONFIGURATION),
						) satisfies ExternalStorage,
					)
				return boundObjectStore(env.EXTERNAL_FILES)
			},
			(event) => {
				for (const socket of this.ctx.getWebSockets()) {
					try {
						socket.send(JSON.stringify(event))
					} catch {
						socket.close(1011, 'Reconnect to sync saved changes.')
					}
				}
			},
		)
	}

	async fetch(request: Request) {
		return this.ctx.blockConcurrencyWhile(async () => {
			try {
				const principal = principalSchema.parse(
					JSON.parse(request.headers.get('x-spike-principal') ?? 'null'),
				)
				const url = new URL(request.url)
				const action = url.pathname.split('/')[3] ?? ''
				if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket')
					return await this.connectDocument(
						principal,
						request.headers
							.get('Sec-WebSocket-Protocol')
							?.split(',')
							.map((value) => value.trim())
							.includes('files-spike') ?? false,
					)
				if (request.method === 'GET') {
					if (action === 'storage')
						return Response.json(await this.session.inspect(principal))
					if (action === 'export')
						return Response.json(await this.session.export(principal), {
							headers: {
								'Content-Disposition':
									'attachment; filename="file-export.json"',
							},
						})
					if (action === 'revisions')
						return Response.json(
							await this.session.revision(
								principal,
								fileId.parse(url.pathname.split('/')[4]),
							),
						)
					if (action)
						throw new DocumentFailure('not_found', 'Route not found.', 404)
					return Response.json(await this.session.view(principal))
				}
				this.rateLimit(principal)
				if (request.method === 'DELETE' && !action) {
					const result = await this.session.purge(principal)
					for (const socket of this.ctx.getWebSockets())
						socket.close(1008, 'File deleted.')
					return Response.json(result)
				}
				if (request.method !== 'POST')
					throw new DocumentFailure('method', 'Method not allowed.', 405)
				if (action === 'initialize') {
					const { name } = createSchema.parse(await request.json())
					return Response.json(
						await this.session.initialize(
							principal,
							fileId.parse(url.pathname.split('/')[2]),
							name,
							{ bob: 'edit', agent: 'edit', viewer: 'view' },
							principal.orgId === 'local-team' ? 'alice' : principal.personId,
						),
					)
				}
				if (action === 'patch') {
					const result = await this.session.patch(
						principal,
						patchSchema.parse(await request.json()),
					)
					return Response.json(result, { status: result.ok ? 200 : 409 })
				}
				if (action === 'checkpoint')
					return Response.json(await this.session.checkpoint(principal))
				if (action === 'move')
					return Response.json(
						await this.session.migrate(
							principal,
							moveSchema.parse(await request.json()).target,
						),
					)
				if (action === 'finish-move')
					return Response.json(await this.session.finishMove(principal))
				if (action === 'grant') {
					const input = grantSchema.parse(await request.json())
					if (
						!Object.values(spikePeople).some(
							(person) =>
								person.orgId === principal.orgId &&
								person.personId === input.personId,
						)
					)
						throw new DocumentFailure(
							'person',
							'Choose someone in this test workspace.',
						)
					const result = await this.session.grant(
						principal,
						input.personId,
						input.role,
					)
					for (const socket of this.ctx.getWebSockets())
						if (
							(socket.deserializeAttachment() as Principal).personId ===
							input.personId
						)
							socket.close(
								1008,
								'Access changed. Reconnect to check permissions.',
							)
					this.broadcastPresence()
					return Response.json(result)
				}
				throw new DocumentFailure('not_found', 'Route not found.', 404)
			} catch (error) {
				return failure(error)
			}
		})
	}

	private rateLimit(principal: Principal) {
		const now = Date.now()
		let rate = this.rates.get(principal.personId)
		if (!rate || now - rate.start >= 1_000) {
			rate = { start: now, count: 0 }
			this.rates.set(principal.personId, rate)
		}
		if (++rate.count > (principal.kind === 'agent' ? 4 : 40))
			throw new DocumentFailure(
				'rate_limit',
				'Too many edits. Wait a moment and retry.',
				429,
			)
	}

	private broadcastPresence() {
		const sockets = this.ctx
			.getWebSockets()
			.filter((socket) => socket.readyState === WebSocket.OPEN)
		const people = Array.from(
			new Set(
				sockets.map(
					(socket) => (socket.deserializeAttachment() as Principal).name,
				),
			),
		).sort()
		for (const socket of sockets)
			socket.send(JSON.stringify({ type: 'people', people }))
	}

	private async connectDocument(principal: Principal, protocol: boolean) {
		const view = await this.session.view(principal)
		if (this.ctx.getWebSockets().length >= documentLimits.participants)
			throw new DocumentFailure(
				'session_limit',
				'This document has reached its connection limit.',
				429,
			)
		const pair = new WebSocketPair()
		this.ctx.acceptWebSocket(pair[1])
		pair[1].serializeAttachment(principal)
		pair[1].send(
			JSON.stringify({
				type: 'ready',
				...view,
				people: this.ctx
					.getWebSockets()
					.map((socket) => (socket.deserializeAttachment() as Principal).name),
			}),
		)
		this.broadcastPresence()
		return new Response(null, {
			status: 101,
			webSocket: pair[0],
			headers: protocol ? { 'Sec-WebSocket-Protocol': 'files-spike' } : {},
		})
	}

	webSocketClose(socket: WebSocket) {
		socket.close(1000, 'Disconnected.')
		this.broadcastPresence()
	}
	webSocketError(socket: WebSocket) {
		socket.close(1011, 'Reconnect to recover saved edits.')
		this.broadcastPresence()
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
		await this.ctx.blockConcurrencyWhile(async () => {
			try {
				const principal = principalSchema.parse(socket.deserializeAttachment())
				this.rateLimit(principal)
				if (typeof message !== 'string' || message.length > 420_000)
					throw new DocumentFailure(
						'message_limit',
						'The edit is too large.',
						413,
					)
				const input = clientMessageSchema.parse(JSON.parse(message))
				if (input.type === 'sync') {
					// A read-only peer may request state, but cannot submit its own state.
					const view = await this.session.view(principal)
					socket.send(JSON.stringify({ type: 'ready', ...view }))
					return
				}
				const result = await this.session.update(
					principal,
					fromBase64(input.update),
				)
				socket.send(
					JSON.stringify({
						type: 'ack',
						id: input.id,
						version: result.version,
					}),
				)
			} catch (error) {
				const response = failure(error)
				socket.send(
					JSON.stringify({
						type: 'error',
						...((await response.json()) as Record<string, unknown>),
					}),
				)
				if (response.status === 403 || response.status === 404)
					socket.close(1008, 'Access revoked.')
			}
		})
	}
}

export class SpikeDirectory extends DurableObject<SpikeEnv> {
	async fetch(request: Request) {
		return this.ctx.blockConcurrencyWhile(async () => {
			try {
				const principal = principalSchema.parse(
					JSON.parse(request.headers.get('x-spike-principal') ?? 'null'),
				)
				const entries =
					(await this.ctx.storage.get<Array<{ id: string; name: string }>>(
						'files',
					)) ?? []
				if (request.method === 'GET') {
					const visible = []
					for (const file of entries) {
						const headers = new Headers(request.headers)
						const response = await this.env.DOCUMENTS.getByName(
							`${principal.orgId}:file:${file.id}`,
						).fetch(
							new Request(`http://localhost/files/${file.id}`, { headers }),
						)
						if (response.ok) visible.push(file)
					}
					return Response.json(visible)
				}
				if (request.method === 'DELETE') {
					const { id } = z.object({ id: fileId }).parse(await request.json())
					await this.ctx.storage.put(
						'files',
						entries.filter((entry) => entry.id !== id),
					)
					return Response.json({ ok: true })
				}
				if (entries.length >= documentLimits.files)
					throw new DocumentFailure(
						'file_limit',
						'This workspace has reached the spike file allowance.',
						413,
					)
				const { name } = createSchema.parse(await request.json())
				const id = crypto.randomUUID()
				const response = await this.env.DOCUMENTS.getByName(
					`${principal.orgId}:file:${id}`,
				).fetch(
					new Request(`http://localhost/files/${id}/initialize`, {
						method: 'POST',
						headers: request.headers,
						body: JSON.stringify({ name }),
					}),
				)
				if (!response.ok) return response
				await this.ctx.storage.put('files', [...entries, { id, name }])
				return response
			} catch (error) {
				return failure(error)
			}
		})
	}
}

export default {
	async fetch(request: Request, env: SpikeEnv) {
		try {
			const url = new URL(request.url)
			// Fixture authentication is deliberately unreachable from a deployed hostname.
			if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
				return new Response('Local spike only.', { status: 403 })
			const origin = request.headers.get('Origin')
			if (origin && origin !== url.origin)
				return new Response('Origin denied.', { status: 403 })
			if (Number(request.headers.get('Content-Length') ?? 0) > 420_000)
				return new Response('Request too large.', { status: 413 })
			if (url.pathname === '/files' || url.pathname.startsWith('/files/')) {
				const principal = localPrincipal(request)
				if (!principal)
					return Response.json(
						{ message: 'Choose a local participant first.' },
						{ status: 401 },
					)
				const headers = new Headers(request.headers)
				headers.set('x-spike-principal', JSON.stringify(principal))
				headers.delete('Authorization')
				headers.delete('Cookie')
				const parts = url.pathname.split('/')
				let response: Response
				if (parts.length === 2) {
					if (!['GET', 'POST'].includes(request.method))
						return new Response('Method not allowed.', { status: 405 })
					response = await env.DIRECTORY.getByName(
						`${principal.orgId}:directory`,
					).fetch(new Request(request, { headers }))
				} else {
					const id = fileId.parse(parts[2])
					if (parts[3] === 'initialize')
						return new Response('Route not found.', { status: 404 })
					response = await env.DOCUMENTS.getByName(
						`${principal.orgId}:file:${id}`,
					).fetch(new Request(request, { headers }))
				}
				if (request.method === 'DELETE' && response.ok) {
					await env.DIRECTORY.getByName(`${principal.orgId}:directory`).fetch(
						new Request('http://localhost/files', {
							method: 'DELETE',
							headers,
							body: JSON.stringify({ id: parts[2] }),
						}),
					)
				}
				if (response.status === 101) return response
				const output = new Response(response.body, response)
				output.headers.set('Cache-Control', 'private, no-store')
				output.headers.set('X-Content-Type-Options', 'nosniff')
				return output
			}
			return env.ASSETS.fetch(request)
		} catch (error) {
			return failure(error)
		}
	},
} satisfies ExportedHandler<SpikeEnv>
