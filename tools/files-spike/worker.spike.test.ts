import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Miniflare } from 'miniflare'
import * as Y from 'yjs'
import { spikeRuntimeOptions } from './test-runtime.ts'
import { fromBase64, toBase64 } from './contracts.ts'

test('real Worker sessions acknowledge after persistence, survive restart, and revoke open sockets', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'kody-files-worker-'))
	const options = await spikeRuntimeOptions(directory)
	let runtime = new Miniflare(options)
	async function request(
		path: string,
		person = 'alice',
		body?: unknown,
		method = body === undefined ? 'GET' : 'POST',
	) {
		return runtime.dispatchFetch(`http://localhost${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${person}`,
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	}
	try {
		assert.equal(
			(await runtime.dispatchFetch('http://example.com/files')).status,
			403,
		)
		assert.equal(
			(await runtime.dispatchFetch('http://localhost/files')).status,
			401,
		)
		assert.equal(
			(
				await runtime.dispatchFetch('http://localhost/files', {
					method: 'POST',
					headers: {
						Origin: 'http://evil.example',
						Authorization: 'Bearer alice',
					},
				})
			).status,
			403,
		)
		const created = await request('/files', 'alice', { name: 'Worker proof' })
		assert.equal(created.status, 200)
		const initial = (await created.json()) as {
			id: string
			state: string
			content: string
		}
		const path = `/files/${initial.id}`
		assert.equal((await request(path, 'outsider')).status, 404)
		const aliceResponse = await runtime.dispatchFetch(
			`http://localhost${path}/socket`,
			{ headers: { Upgrade: 'websocket', Authorization: 'Bearer alice' } },
		)
		const aliceSocket = aliceResponse.webSocket!
		aliceSocket.accept()
		const participantUpdates: Array<Array<string>> = []
		let resolveJoin: () => void = () => {}
		let resolveLeave: () => void = () => {}
		const joined = new Promise<void>((done) => {
			resolveJoin = done
		})
		const left = new Promise<void>((done) => {
			resolveLeave = done
		})
		aliceSocket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data))
			if (message.type !== 'people') return
			participantUpdates.push(message.people)
			if (message.people.includes('Bob')) resolveJoin()
			else if (participantUpdates.some((people) => people.includes('Bob')))
				resolveLeave()
		})
		const bobResponse = await runtime.dispatchFetch(
			`http://localhost${path}/socket`,
			{
				headers: {
					Upgrade: 'websocket',
					'Sec-WebSocket-Protocol': 'files-spike, participant.bob',
				},
			},
		)
		assert.equal(
			bobResponse.headers.get('Sec-WebSocket-Protocol'),
			'files-spike',
		)
		const bob = bobResponse.webSocket!
		bob.accept()
		const messages: Array<Record<string, unknown>> = []
		bob.addEventListener('message', (event) =>
			messages.push(JSON.parse(String(event.data))),
		)
		const closed = new Promise<number>((resolveClosed) =>
			bob.addEventListener('close', (event) => resolveClosed(event.code)),
		)
		await joined
		const doc = new Y.Doc()
		Y.applyUpdate(doc, fromBase64(initial.state))
		doc
			.getText('content')
			.insert(doc.getText('content').length, 'Bob was here.\n')
		const updateId = crypto.randomUUID()
		const ack = new Promise<void>((resolveAck) =>
			bob.addEventListener('message', (event) => {
				const message = JSON.parse(String(event.data))
				if (message.type === 'ack' && message.id === updateId) resolveAck()
			}),
		)
		bob.send(
			JSON.stringify({
				type: 'update',
				id: updateId,
				update: toBase64(Y.encodeStateAsUpdate(doc)),
			}),
		)
		await ack
		assert.match(
			((await (await request(path)).json()) as { content: string }).content,
			/Bob was here/,
		)
		const patch = await request(`${path}/patch`, 'agent', {
			kind: 'anchor',
			quote: '# Worker proof',
			replacement: '# Agent and humans',
		})
		assert.equal(patch.status, 200)
		assert.ok(messages.some((message) => message.type === 'update'))
		assert.equal(
			(await request(`${path}/grant`, 'alice', { personId: 'bob', role: null }))
				.status,
			200,
		)
		assert.equal(await closed, 1008)
		await left
		assert.deepEqual(participantUpdates.at(-1), ['Alice'])
		aliceSocket.close(1000)
		assert.equal((await request(path, 'bob')).status, 404)
		doc.destroy()
		await runtime.dispose()
		runtime = new Miniflare(options)
		const recovered = (await (await request(path)).json()) as {
			content: string
			version: number
		}
		assert.match(recovered.content, /# Agent and humans/)
		assert.match(recovered.content, /Bob was here/)
		assert.equal(recovered.version, 2)
		assert.equal((await request('/files')).status, 200)
		assert.equal(
			(await request(`${path}/move`, 'alice', { target: 'external' })).status,
			200,
		)
		const exported = (await (await request(`${path}/export`)).json()) as {
			id: string
			history: Array<unknown>
		}
		assert.equal(exported.id, initial.id)
		assert.equal(exported.history.length, 2)
		assert.equal(
			(await request(`${path}/finish-move`, 'alice', {})).status,
			200,
		)
		assert.equal(
			(await request(path, 'alice', undefined, 'DELETE')).status,
			200,
		)
		assert.equal((await request(path)).status, 404)
	} finally {
		await runtime.dispose()
		await rm(directory, { recursive: true, force: true })
	}
})

test('S3 adapter signs requests, verifies copied revisions, and handles revoked credentials', async () => {
	const objects = new Map<string, string>()
	let revoked = false
	let signedRequests = 0
	const server = createServer(async (request, response) => {
		if (
			revoked ||
			!request.headers.authorization?.includes('Credential=local-key/')
		) {
			response.writeHead(403)
			response.end()
			return
		}
		signedRequests++
		const key = request.url!
		if (request.method === 'PUT') {
			let body = ''
			for await (const chunk of request) body += chunk
			objects.set(key, body)
			response.end()
		} else if (request.method === 'DELETE') {
			objects.delete(key)
			response.end()
		} else if (objects.has(key)) response.end(objects.get(key))
		else {
			response.writeHead(404)
			response.end()
		}
	})
	await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
	const address = server.address()
	assert.ok(address && typeof address !== 'string')
	const runtime = new Miniflare(
		await spikeRuntimeOptions(
			undefined,
			JSON.stringify({
				endpoint: `http://127.0.0.1:${address.port}`,
				bucket: 'local-bucket',
				accessKeyId: 'local-key',
				secretAccessKey: 'local-secret',
				region: 'auto',
			}),
		),
	)
	async function request(path: string, body?: unknown) {
		return runtime.dispatchFetch(`http://localhost${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				Authorization: 'Bearer alice',
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	}
	try {
		const file = (await (
			await request('/files', { name: 'S3 proof' })
		).json()) as { id: string }
		const path = `/files/${file.id}`
		assert.equal(
			(await request(`${path}/move`, { target: 'external' })).status,
			200,
		)
		assert.ok(signedRequests >= 2)
		assert.equal(objects.size, 1)
		revoked = true
		const degraded = (await (await request(path)).json()) as {
			storageAvailable: boolean
			canEdit: boolean
			content: string
		}
		assert.equal(degraded.storageAvailable, false)
		assert.equal(degraded.canEdit, false)
		assert.match(degraded.content, /S3 proof/)
		assert.equal(
			(
				await request(`${path}/patch`, {
					kind: 'anchor',
					quote: '# S3 proof',
					replacement: '# No',
				})
			).status,
			503,
		)
		revoked = false
		assert.equal((await request(`${path}/finish-move`, {})).status, 200)
		assert.equal((await request(`${path}/export`)).status, 200)
	} finally {
		await runtime.dispose()
		await new Promise<void>((done, reject) =>
			server.close((error) => (error ? reject(error) : done())),
		)
	}
})
