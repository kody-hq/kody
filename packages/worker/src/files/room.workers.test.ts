import {
	env,
	applyD1Migrations,
	runInDurableObject,
	type D1Migration,
} from 'cloudflare:test'
import { beforeAll, expect, test, vi } from 'vitest'
import {
	encryptSecretValue,
	sealFileShareValue,
	userSecretContext,
} from '#mcp/secrets/crypto.ts'
import type { FileStore } from './store.ts'
import { fileStoreName, fileStoreRpc } from './client.ts'
import { fileObjectReader, storageEndpoint } from './object-storage.ts'
import { fileBlobKey } from './object-keys.ts'
import * as Y from 'yjs'
import { fileRoomRpc, type FileRoom } from './room.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import type { AppEnv } from '#worker/env-schema.ts'
import {
	collaborationLimits,
	decodeCollaborationBytes,
	encodeCollaborationBytes,
} from '#universal/file-collaboration.ts'
beforeAll(async () => {
	await applyD1Migrations(
		env.APP_DB,
		(env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
	)
})
async function fixture() {
	const personId = personIdFromStored(`user_${crypto.randomUUID()}`),
		ownerId = ownerIdFromStored(String(personId)),
		name = `collab-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		"INSERT INTO users (stable_user_id,username,email,password_hash,email_verified_at) VALUES (?,?,?,'test',CURRENT_TIMESTAMP)",
	)
		.bind(personId, name, `${name}@example.com`)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: personId,
		username: name,
	})
	const request = deriveRequestContext({
		user: { userId: personId, username: name, personalOrgId: ownerId },
		source: { kind: 'session' },
		orgBinding: { org: { id: ownerId, slug: name }, role: 'owner' },
	})
	const fileId = crypto.randomUUID(),
		revisionId = crypto.randomUUID(),
		store = fileStoreRpc(env, ownerId)
	await store.write({
		ownerId,
		fileId,
		writeId: revisionId,
		baseRevisionId: null,
		content: 'Hello team',
		actorId: personId,
		profileId: null,
		author: name,
		maxBytes: 1_000_000,
		create: { name: 'Notes.md', mediaType: 'text/markdown' },
	})
	const stub = env.FILE_ROOM.get(
		env.FILE_ROOM.idFromName(`${ownerId}:file:${fileId}:v1`),
	)
	await runInDurableObject(stub, async (instance: FileRoom) => {
		const bindings = (instance as unknown as { env: AppEnv }).env
		bindings.FILES_INCLUDED_BYTES = '1000000'
		bindings.WRANGLER_IS_LOCAL_DEV = 'true'
		bindings.FILES_COLLABORATION_ENABLED = 'true'
	})
	return {
		personId,
		ownerId,
		request,
		fileId,
		revisionId,
		room: fileRoomRpc(env, ownerId, fileId),
		stub,
		store,
	}
}
test('an open human session stays present without heartbeat messages', async () => {
	const f = await fixture()
	const sessionId = crypto.randomUUID()
	const response = await f.room.openSession(f.request, f.fileId, sessionId)
	const socket = response.webSocket!
	socket.accept()
	try {
		await runInDurableObject(f.stub, async (instance: FileRoom, ctx) => {
			const [server] = ctx.getWebSockets()
			if (!server) throw new Error('Expected an open file room socket.')
			const attachment = server.deserializeAttachment()
			attachment.presence.state = 'idle'
			attachment.presence.lastSeen =
				Date.now() - collaborationLimits.agentPresenceMs - 1
			server.serializeAttachment(attachment)
			await instance.alarm()
		})
		expect(
			(await f.room.snapshot(f.request, f.fileId)).presence,
		).toContainEqual(expect.objectContaining({ sessionId, state: 'idle' }))
	} finally {
		socket.close()
	}
})

test('two clients merge updates, retry safely, and checkpoint acknowledged content into immutable storage', async () => {
	const f = await fixture(),
		initial = await f.room.snapshot(f.request, f.fileId)
	const human = new Y.Doc(),
		agent = new Y.Doc()
	Y.applyUpdate(human, decodeCollaborationBytes(initial.state))
	Y.applyUpdate(agent, decodeCollaborationBytes(initial.state))
	human.getText('content').insert(6, 'great ')
	agent.getText('content').insert(10, '!')
	const operationId = crypto.randomUUID(),
		update = encodeCollaborationBytes(Y.encodeStateAsUpdate(human))
	const receipt = await f.room.update(f.request, f.fileId, operationId, update)
	expect(await f.room.update(f.request, f.fileId, operationId, update)).toEqual(
		receipt,
	)
	await f.room.update(
		f.request,
		f.fileId,
		crypto.randomUUID(),
		encodeCollaborationBytes(Y.encodeStateAsUpdate(agent)),
	)
	expect((await f.room.read(f.request, f.fileId)).content).toBe(
		'Hello great team!',
	)
	await runInDurableObject(f.stub, async (instance: FileRoom) => {
		await instance.checkpoint()
	})
	expect((await f.store.read(f.ownerId, f.fileId)).content).toBe(
		'Hello great team!',
	)
	expect((await f.store.metadata(f.ownerId, f.fileId))?.revisions).toHaveLength(
		2,
	)
	human.destroy()
	agent.destroy()
})
test('comment commands persist independently from content revisions and an invalid command does not reset the room', async () => {
	const f = await fixture()
	await f.room.snapshot(f.request, f.fileId)
	const threadId = crypto.randomUUID(),
		command = {
			kind: 'create' as const,
			operationId: crypto.randomUUID(),
			threadId,
			commentId: crypto.randomUUID(),
			anchor: { kind: 'file' as const },
			body: 'Please review',
		}
	await f.room.comment(f.request, f.fileId, command)
	expect((await f.room.snapshot(f.request, f.fileId)).comments[0]?.body).toBe(
		'Please review',
	)
	expect((await f.store.metadata(f.ownerId, f.fileId))?.revisions).toHaveLength(
		1,
	)
	await runInDurableObject(f.stub, async (instance: FileRoom) => {
		await expect(
			instance.comment(f.request, f.fileId, {
				kind: 'resolve',
				operationId: crypto.randomUUID(),
				threadId,
				expectedVersion: 99,
				resolved: true,
			}),
		).rejects.toThrow('changed')
	})
	expect((await f.room.read(f.request, f.fileId)).content).toBe('Hello team')
})
test('room bindings cannot be reused for another file or org', async () => {
	const f = await fixture()
	await f.room.snapshot(f.request, f.fileId)
	await runInDurableObject(f.stub, async (instance: FileRoom) => {
		await expect(
			instance.read(f.request, crypto.randomUUID()),
		).rejects.toThrow()
	})
	expect((await f.room.read(f.request, f.fileId)).content).toBe('Hello team')
})

test('checkpoint recovery preserves relative positions and mixed commands advance one sequence', async () => {
	const f = await fixture()
	const initial = await f.room.snapshot(f.request, f.fileId)
	const doc = new Y.Doc()
	Y.applyUpdate(doc, decodeCollaborationBytes(initial.state))
	const text = doc.getText('content')
	const anchor = Y.createRelativePositionFromTypeIndex(text, 6)
	text.insert(0, 'Welcome! ')
	const id = crypto.randomUUID()
	const receipt = await f.room.update(
		f.request,
		f.fileId,
		id,
		encodeCollaborationBytes(Y.encodeStateAsUpdate(doc)),
	)
	await f.room.comment(f.request, f.fileId, {
		kind: 'create',
		operationId: crypto.randomUUID(),
		threadId: crypto.randomUUID(),
		commentId: crypto.randomUUID(),
		anchor: { kind: 'file' },
		body: 'Reviewed',
	})
	await runInDurableObject(f.stub, async (instance: FileRoom, state) => {
		await instance.checkpoint()
		// Simulate restoring a lost live head from the immutable shared checkpoint.
		await state.storage.delete('room')
	})
	const recovered = await f.room.snapshot(f.request, f.fileId)
	const restored = new Y.Doc()
	Y.applyUpdate(restored, decodeCollaborationBytes(recovered.state))
	expect(
		Y.createAbsolutePositionFromRelativePosition(anchor, restored)?.index,
	).toBe(15)
	expect(recovered.sequence).toBeGreaterThan(receipt.sequence)
	expect(recovered.comments[0]?.body).toBe('Reviewed')
	const revision = (await f.store.metadata(f.ownerId, f.fileId))!.revisions.at(
		-1,
	)!
	expect(revision.collaborationBytes).toBeGreaterThan(0)
	expect(await f.store.inventory(f.ownerId)).toContain(
		`files:v1/${f.ownerId}/${f.fileId}/${revision.id}/yjs`,
	)
	doc.destroy()
	restored.destroy()
})

test('reused operation IDs reject different updates without losing accepted content', async () => {
	const f = await fixture()
	const initial = await f.room.snapshot(f.request, f.fileId)
	const doc = new Y.Doc()
	Y.applyUpdate(doc, decodeCollaborationBytes(initial.state))
	doc.getText('content').insert(0, 'One ')
	const id = crypto.randomUUID()
	await f.room.update(
		f.request,
		f.fileId,
		id,
		encodeCollaborationBytes(Y.encodeStateAsUpdate(doc)),
	)
	doc.getText('content').insert(0, 'Two ')
	const changed = encodeCollaborationBytes(Y.encodeStateAsUpdate(doc))
	await runInDurableObject(f.stub, async (instance: FileRoom) => {
		await expect(
			instance.update(f.request, f.fileId, id, changed),
		).rejects.toThrow('already used')
	})
	expect((await f.room.read(f.request, f.fileId)).content).toBe(
		'One Hello team',
	)
	doc.destroy()
})

test('a second identity can comment without editing and a revoked grant closes its live connection', async () => {
	const f = await fixture()
	const reader = personIdFromStored(`user_${crypto.randomUUID()}`)
	const username = `reader-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		"INSERT INTO users (stable_user_id,username,email,password_hash,email_verified_at) VALUES (?,?,?,'test',CURRENT_TIMESTAMP)",
	)
		.bind(reader, username, `${username}@example.com`)
		.run()
	await provisionPersonalOrg(env.APP_DB, { stableUserId: reader, username })
	const grantId = crypto.randomUUID()
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			"INSERT INTO grants (id,org_id,resource_type,resource_id,subject_type,subject_id,created_by_user_id,created_at,updated_at) VALUES (?,?,'file',?,'user',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
		).bind(grantId, f.ownerId, f.fileId, reader, f.personId),
		env.APP_DB.prepare(
			"INSERT INTO grant_permissions (grant_id,permission) VALUES (?,'file:read'),(?,'file:comment')",
		).bind(grantId, grantId),
		env.APP_DB.prepare(
			'UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?',
		).bind(f.ownerId),
	])
	const request = deriveRequestContext({
		user: {
			userId: reader,
			username,
			personalOrgId: ownerIdFromStored(String(reader)),
		},
		source: { kind: 'session' },
		orgBinding: { org: f.request.org, role: null },
	})
	const snapshot = await f.room.snapshot(request, f.fileId)
	expect(snapshot.access).toMatchObject({
		read: true,
		comment: true,
		write: false,
	})
	await f.room.comment(request, f.fileId, {
		kind: 'create',
		operationId: crypto.randomUUID(),
		threadId: crypto.randomUUID(),
		commentId: crypto.randomUUID(),
		anchor: { kind: 'file' },
		body: 'Reader feedback',
	})
	expect(
		(await f.room.snapshot(f.request, f.fileId)).comments[0]?.author.personId,
	).toBe(reader)
	const response = await f.room.openSession(
		request,
		f.fileId,
		crypto.randomUUID(),
	)
	const socket = response.webSocket!
	socket.accept()
	const closed = new Promise<number>((resolve) =>
		socket.addEventListener('close', (event) => resolve(event.code), {
			once: true,
		}),
	)
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			'UPDATE grants SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?',
		).bind(grantId),
		env.APP_DB.prepare(
			'UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?',
		).bind(f.ownerId),
	])
	await runInDurableObject(f.stub, async (instance: FileRoom) => {
		await instance.alarm()
	})
	expect(await closed).toBe(4003)
	expect((await f.room.read(f.request, f.fileId)).content).toBe('Hello team')
})

test('public directory tokens exclude restricted subtrees and revocation invalidates reads', async () => {
	const f = await fixture()
	const { publicFileScope } = await import('./public-links.ts')
	const { sha256Hex } = await import('@kody-internal/shared/sha256.ts')
	const root = crypto.randomUUID(),
		restricted = crypto.randomUUID(),
		visible = crypto.randomUUID(),
		hidden = crypto.randomUUID()
	for (const item of [
		{
			id: root,
			name: 'Shared',
			mediaType: 'application/vnd.kody.directory',
			content: '',
		},
		{
			id: restricted,
			name: 'Private',
			parentId: root,
			mediaType: 'application/vnd.kody.directory',
			content: '',
		},
		{
			id: visible,
			name: 'Visible.txt',
			parentId: root,
			mediaType: 'text/plain',
			content: 'Visible body',
		},
		{
			id: hidden,
			name: 'Hidden.txt',
			parentId: restricted,
			mediaType: 'text/plain',
			content: 'Private body',
		},
	]) {
		await f.store.write({
			ownerId: f.ownerId,
			fileId: item.id,
			writeId: crypto.randomUUID(),
			baseRevisionId: null,
			content: item.content,
			actorId: f.personId,
			profileId: null,
			author: 'Owner',
			maxBytes: 1_000_000,
			create: {
				name: item.name,
				mediaType: item.mediaType,
				parentId: item.parentId,
			},
		})
	}
	const childToken = 'b'.repeat(64)
	await f.store.setPublicLink(
		f.ownerId,
		hidden,
		await sha256Hex(new TextEncoder().encode(childToken)),
	)
	expect(
		(await publicFileScope(env, f.request.org.slug!, hidden, childToken)).file
			.content,
	).toBe('Private body')
	await f.store.manage({
		ownerId: f.ownerId,
		fileId: restricted,
		operationId: crypto.randomUUID(),
		expectedVersion: 0,
		action: 'access',
		accessMode: 'restricted',
		allowedIds: [restricted],
		writableParents: [root],
		canCreate: true,
	})
	await expect(
		publicFileScope(env, f.request.org.slug!, hidden, childToken),
	).rejects.toThrow('unavailable')
	const token = 'a'.repeat(64)
	const sealed = await sealFileShareValue(
		env,
		'public-link',
		`${f.ownerId}:${root}`,
		token,
	)
	await f.store.setPublicLink(
		f.ownerId,
		root,
		await sha256Hex(new TextEncoder().encode(token)),
		sealed,
	)
	expect(await f.store.publicLinkSecret(f.ownerId, root)).toBe(sealed)
	const { readManagedPublicLink } = await import('./public-links.ts')
	expect(
		await readManagedPublicLink(env, f.ownerId, f.request.org.slug!, root),
	).toContain(token)
	const result = await publicFileScope(
		env,
		f.request.org.slug!,
		root,
		token,
		visible,
	)
	expect(result.file.content).toBe('Visible body')
	expect(result.files.map((file) => file.id).sort()).toEqual(
		[root, visible].sort(),
	)
	await expect(
		publicFileScope(env, f.request.org.slug!, root, token, hidden),
	).rejects.toThrow('unavailable')
	await expect(
		publicFileScope(env, f.request.org.slug!, root, token, f.fileId),
	).rejects.toThrow('unavailable')
	await f.store.setPublicLink(f.ownerId, root, null)
	expect(await f.store.publicLinkSecret(f.ownerId, root)).toBeNull()
	await expect(
		publicFileScope(env, f.request.org.slug!, root, token, visible),
	).rejects.toThrow('unavailable')
})

test('external revisions retain their provider through default changes, range reads, export, and deletion', async () => {
	const f = await fixture()
	const endpoint = 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com'
	const keySecret = 'local-storage-fixture-key-only'
	const bucketId = crypto.randomUUID(),
		credentialId = crypto.randomUUID()
	const encrypted = await encryptSecretValue(
		{ SECRET_STORE_KEY: keySecret },
		JSON.stringify({
			accessKeyId: 'fixture-access',
			secretAccessKey: 'fixture-secret',
		}),
		userSecretContext(f.ownerId),
	)
	await env.APP_DB.prepare(
		"INSERT INTO secret_buckets(id,user_id,scope,binding_key) VALUES(?,?,'user','')",
	)
		.bind(bucketId, f.ownerId)
		.run()
	await env.APP_DB.prepare(
		"INSERT INTO secret_entries(id,bucket_id,name,encrypted_value,allowed_hosts) VALUES(?,?,'file-storage',?,?)",
	)
		.bind(
			credentialId,
			bucketId,
			encrypted,
			JSON.stringify([new URL(endpoint).host]),
		)
		.run()
	const storeStub = env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(f.ownerId)),
	)
	await runInDurableObject(storeStub, async (instance: FileStore) => {
		;(instance as unknown as { env: AppEnv }).env.SECRET_STORE_KEY = keySecret
	})
	const objects = new Map<string, Uint8Array>()
	const original = globalThis.fetch
	let signed = 0
	let corruptProbe = false
	vi.stubGlobal(
		'fetch',
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(input, init)
			if (!request.url.startsWith(endpoint)) return original(input, init)
			expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256')
			signed++
			const key = new URL(request.url).pathname
			if (request.method === 'PUT') {
				objects.set(key, new Uint8Array(await request.arrayBuffer()))
				return new Response(null, { status: 200 })
			}
			if (request.method === 'DELETE') {
				objects.delete(key)
				return new Response(null, { status: 204 })
			}
			const bytes =
				corruptProbe && key.includes('/connection-check/')
					? new TextEncoder().encode('wrong probe')
					: objects.get(key)
			if (!bytes) return new Response(null, { status: 404 })
			const headers = new Headers({
				'content-length': String(bytes.byteLength),
				etag: '"fixture-etag"',
				'content-type': 'text/plain',
			})
			if (request.method === 'HEAD') return new Response(null, { headers })
			const range = request.headers.get('range')?.match(/bytes=(\d+)-(\d+)/)
			if (range) {
				const start = Number(range[1]),
					end = Math.min(Number(range[2]), bytes.length - 1)
				headers.set('content-range', `bytes ${start}-${end}/${bytes.length}`)
				headers.set('content-length', String(end - start + 1))
				return new Response(bytes.slice(start, end + 1), {
					status: 206,
					headers,
				})
			}
			return new Response(new Uint8Array(bytes).buffer, { headers })
		},
	)
	try {
		const config = {
			id: crypto.randomUUID(),
			endpoint,
			bucket: 'fixture-files',
			region: 'auto',
			credentialName: 'file-storage',
			authorizedBy: f.personId,
			credentialId,
		}
		await f.store.configureStorage(f.ownerId, config)
		await env.APP_DB.prepare(
			"UPDATE secret_entries SET name='renamed-storage' WHERE id=?",
		)
			.bind(credentialId)
			.run()
		await f.store.reserveCollaboration({
			ownerId: f.ownerId,
			fileId: f.fileId,
			bytes: 100,
			maxBytes: 1,
		})
		await f.store.configureStorage(f.ownerId, null)
		const checkpoint = new Y.Doc()
		checkpoint.getText('content').insert(0, 'External bytes')
		const revisionId = crypto.randomUUID()
		const saved = await f.store.write({
			ownerId: f.ownerId,
			fileId: f.fileId,
			writeId: revisionId,
			baseRevisionId: f.revisionId,
			content: 'External bytes',
			collaborationState: Y.encodeStateAsUpdate(checkpoint),
			actorId: f.personId,
			profileId: null,
			author: 'Fixture',
			maxBytes: 1,
		})
		expect(saved.ok).toBe(true)
		expect(
			(await f.store.metadata(f.ownerId, f.fileId))?.revisions.at(-1)
				?.storageId,
		).toBe(config.id)
		await f.store.configureStorage(f.ownerId, null)
		expect((await f.store.read(f.ownerId, f.fileId)).content).toBe(
			'External bytes',
		)
		expect(
			(await f.store.read(f.ownerId, f.fileId, f.revisionId)).content,
		).toBe('Hello team')
		const blobKey = fileBlobKey(f.ownerId, f.fileId, revisionId)
		const provider = await f.store.objectProvider(f.ownerId, blobKey)
		expect(provider?.id).toBe(config.id)
		// The reader outside the DO uses the same owning credential and locator.
		const fixtureEnv = { ...env, SECRET_STORE_KEY: keySecret } as Env
		const chunk = await fileObjectReader(fixtureEnv, f.ownerId).get(blobKey, {
			range: { offset: 1, length: 4 },
		})
		expect(new TextDecoder().decode(await chunk!.arrayBuffer())).toBe('xter')
		expect(chunk?.size).toBe(14)
		corruptProbe = true
		const invalid = await runInDurableObject(
			storeStub,
			async (instance: FileStore) => {
				try {
					await instance.configureStorage(f.ownerId, {
						...config,
						credentialName: 'renamed-storage',
					})
					return null
				} catch (error) {
					return error instanceof Error ? error.message : String(error)
				}
			},
		)
		expect(invalid).toContain('verification')
		expect((await f.store.storageStatus(f.ownerId)).active).toBeNull()
		expect(
			(await f.store.storageStatus(f.ownerId)).providers[0]?.credentialName,
		).toBe('file-storage')
		corruptProbe = false
		await f.store.configureStorage(f.ownerId, {
			...config,
			credentialName: 'renamed-storage',
		})
		expect((await f.store.read(f.ownerId, f.fileId)).content).toBe(
			'External bytes',
		)

		await env.APP_DB.prepare(
			'UPDATE secret_entries SET expires_at=? WHERE id=?',
		)
			.bind('2000-01-01T00:00:00.000Z', credentialId)
			.run()
		const revoked = await runInDurableObject(
			storeStub,
			async (instance: FileStore) => {
				try {
					await instance.read(f.ownerId, f.fileId)
					return null
				} catch (error) {
					return error instanceof Error ? error.message : String(error)
				}
			},
		)
		expect(revoked).toBeTruthy()

		await env.APP_DB.prepare(
			'UPDATE secret_entries SET expires_at=NULL WHERE id=?',
		)
			.bind(credentialId)
			.run()
		expect(
			(await f.store.exportMetadata(f.ownerId)).storage?.providers[0]?.id,
		).toBe(config.id)
		expect(await f.store.inventory(f.ownerId)).toContain(blobKey)
		await f.store.remove(f.ownerId, f.fileId)
		expect(objects.size).toBe(0)
		expect(signed).toBeGreaterThan(5)
	} finally {
		vi.unstubAllGlobals()
	}
	expect(() => storageEndpoint('https://example.com')).toThrow(
		'R2 or Amazon S3',
	)
	expect(() =>
		storageEndpoint('https://' + new URL(endpoint).host + '/other'),
	).toThrow()
})

test('binary replacements advance discussion revisions and reject CRDT byte replacement', async () => {
	const f = await fixture()
	const imageId = crypto.randomUUID(),
		firstId = crypto.randomUUID(),
		secondId = crypto.randomUUID()
	await f.store.write({
		ownerId: f.ownerId,
		fileId: imageId,
		writeId: firstId,
		baseRevisionId: null,
		content: 'AQID',
		actorId: f.personId,
		profileId: null,
		author: 'Fixture',
		maxBytes: 1_000_000,
		create: { name: 'image.png', mediaType: 'image/png', encoding: 'base64' },
	})
	const room = fileRoomRpc(env, f.ownerId, imageId)
	// The room fixture's environment opt-in applies per instance.
	const stub = env.FILE_ROOM.get(
		env.FILE_ROOM.idFromName(`${f.ownerId}:file:${imageId}:v1`),
	)
	await runInDurableObject(stub, async (instance: FileRoom) => {
		Object.assign((instance as unknown as { env: AppEnv }).env, {
			WRANGLER_IS_LOCAL_DEV: 'true',
			FILES_COLLABORATION_ENABLED: 'true',
			FILES_INCLUDED_BYTES: '1000000',
		})
	})
	await room.snapshot(f.request, imageId)
	await f.store.write({
		ownerId: f.ownerId,
		fileId: imageId,
		writeId: secondId,
		baseRevisionId: firstId,
		content: 'BAUG',
		actorId: f.personId,
		profileId: null,
		author: 'Fixture',
		maxBytes: 1_000_000,
	})
	await room.noteActivity(f.request, imageId, 'edited')
	const command = {
		kind: 'create' as const,
		operationId: crypto.randomUUID(),
		threadId: crypto.randomUUID(),
		commentId: crypto.randomUUID(),
		anchor: { kind: 'file' as const },
		body: 'On the replacement',
	}
	expect(
		(await room.comment(f.request, imageId, command)).threads[0]?.revisionId,
	).toBe(secondId)
	const doc = new Y.Doc()
	doc.getText('content').insert(0, 'AAAA')
	const rejected = await runInDurableObject(
		stub,
		async (instance: FileRoom) => {
			try {
				await instance.update(
					f.request,
					imageId,
					crypto.randomUUID(),
					encodeCollaborationBytes(Y.encodeStateAsUpdate(doc)),
				)
				return null
			} catch (error) {
				return error instanceof Error ? error.message : String(error)
			}
		},
	)
	expect(rejected).toContain('revision-safe replacement')

	expect((await f.store.read(f.ownerId, imageId)).content).toBe('BAUG')
	doc.destroy()
})

test('agent presence appears in the live room and clears on request', async () => {
	const f = await fixture()
	const agent = deriveRequestContext({
		user: {
			userId: f.personId,
			username: f.request.org.slug!,
			personalOrgId: f.ownerId,
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: { org: f.request.org, role: 'owner' },
	})
	await f.room.setAgentPresence(agent, f.fileId, { state: 'working' })
	const snapshot = await f.room.snapshot(f.request, f.fileId)
	expect(snapshot.presence).toMatchObject([
		{ actor: { kind: 'agent' }, state: 'working' },
	])
	await f.room.setAgentPresence(agent, f.fileId, null)
	expect((await f.room.snapshot(f.request, f.fileId)).presence).toEqual([])
})

type RoomInternals = {
	resolveAccess: (...args: unknown[]) => Promise<unknown>
	broadcastPresence: () => Promise<void>
}
async function openSockets(
	f: Awaited<ReturnType<typeof fixture>>,
	count: number,
	session = { issuedAt: Date.now(), expiresAt: Date.now() + 10 * 60_000 },
) {
	return Promise.all(
		Array.from({ length: count }, async () => {
			const sessionId = crypto.randomUUID()
			const socket = (
				await f.room.openSession(f.request, f.fileId, sessionId, session)
			).webSocket!
			socket.accept()
			const closed = new Promise<number>((resolve) =>
				socket.addEventListener('close', (event) => resolve(event.code), {
					once: true,
				}),
			)
			return { sessionId, socket, closed }
		}),
	)
}

test('a broadcast resolves access once per session and still closes revoked sockets', async () => {
	const f = await fixture()
	const sockets = await openSockets(f, 3)
	try {
		await runInDurableObject(f.stub, async (instance: FileRoom) => {
			const room = instance as unknown as RoomInternals
			const resolveAccess = vi.spyOn(room, 'resolveAccess')
			try {
				await room.broadcastPresence()
				expect(resolveAccess).toHaveBeenCalledTimes(1)
				await room.broadcastPresence()
				expect(resolveAccess).toHaveBeenCalledTimes(2)
			} finally {
				resolveAccess.mockRestore()
			}
		})
		await env.APP_DB.prepare(
			'UPDATE users SET suspended_at = CURRENT_TIMESTAMP WHERE stable_user_id = ?',
		)
			.bind(f.personId)
			.run()
		await runInDurableObject(f.stub, async (instance: FileRoom) => {
			await (instance as unknown as RoomInternals).broadcastPresence()
		})
		expect(await Promise.all(sockets.map((s) => s.closed))).toEqual([
			4003, 4003, 4003,
		])
	} finally {
		for (const { socket } of sockets) socket.close()
	}
})

test('a broadcast looks up each person once instead of once per session', async () => {
	const f = await fixture()
	// Distinct issuedAt values give each socket its own session key, so the
	// per-session cache alone cannot dedupe them.
	const sockets = (
		await Promise.all(
			[0, 1, 2].map((offset) =>
				openSockets(f, 1, {
					issuedAt: Date.now() - offset * 1000,
					expiresAt: Date.now() + 10 * 60_000,
				}),
			),
		)
	).flat()
	try {
		await runInDurableObject(f.stub, async (instance: FileRoom) => {
			const room = instance as unknown as RoomInternals & { env: Env }
			const prepare = vi.spyOn(room.env.APP_DB, 'prepare')
			try {
				await room.broadcastPresence()
				const sql = prepare.mock.calls.map(([query]) => String(query))
				const userLookups = sql.filter((query) =>
					/FROM users WHERE stable_user_id (=|IN)/.test(query),
				)
				// One batched liveness query plus at most one collaboration-flag
				// user lookup, regardless of how many sessions are connected.
				expect(userLookups.length).toBeLessThanOrEqual(2)
			} finally {
				prepare.mockRestore()
			}
		})
	} finally {
		for (const { socket } of sockets) socket.close()
	}
})

test('a shared session lookup still closes an expired socket with 4000', async () => {
	const f = await fixture()
	const [expired, live] = await openSockets(f, 2)
	let liveClosed: number | null = null
	void live!.closed.then((code) => (liveClosed = code))
	const presence = new Promise<void>((resolve) =>
		live!.socket.addEventListener('message', (event) => {
			if (
				(JSON.parse(String(event.data)) as { type: string }).type === 'presence'
			)
				resolve()
		}),
	)
	try {
		await runInDurableObject(f.stub, async (instance: FileRoom, ctx) => {
			const target = ctx
				.getWebSockets()
				.find(
					(ws) =>
						ws.deserializeAttachment().presence.sessionId ===
						expired!.sessionId,
				)!
			const attachment = target.deserializeAttachment()
			attachment.session.expiresAt = Date.now() - 1
			target.serializeAttachment(attachment)
			await (instance as unknown as RoomInternals).broadcastPresence()
		})
		expect(await expired!.closed).toBe(4000)
		await presence
		expect(liveClosed).toBeNull()
	} finally {
		expired!.socket.close()
		live!.socket.close()
	}
})
