import { test } from 'vitest'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { DocumentSession, type SessionEvent } from './session.ts'
import { DocumentFailure } from './document.ts'
import {
	documentLimits,
	fromBase64,
	type DurableDocument,
} from './contracts.ts'
import { spikePeople } from './identity.ts'
import { revisionKey, type ObjectStore } from './storage.ts'

function harness() {
	const persisted = new Map<string, unknown>()
	const blobs = {
		included: new Map<string, string>(),
		external: new Map<string, string>(),
	}
	let externalAvailable = true
	let failWrite = false
	const events: Array<SessionEvent> = []
	const persistence = {
		async get<T>(key: string) {
			return structuredClone(persisted.get(key)) as T | undefined
		},
		async put<T>(key: string, value: T) {
			if (failWrite && key === 'document') throw new Error('Disk failure')
			persisted.set(key, structuredClone(value))
		},
		async delete(key: string) {
			return persisted.delete(key)
		},
	}
	function store(location: 'included' | 'external'): ObjectStore {
		function check() {
			if (location === 'external' && !externalAvailable)
				throw new DocumentFailure('storage_unavailable', 'Access revoked.', 503)
		}
		return {
			async get(key) {
				check()
				return blobs[location].get(key) ?? null
			},
			async put(key, value) {
				check()
				blobs[location].set(key, value)
			},
			async delete(key) {
				check()
				blobs[location].delete(key)
			},
		}
	}
	return {
		create: () =>
			new DocumentSession(persistence, store, (event) => events.push(event)),
		persisted,
		blobs,
		events,
		revokeStorage: () => {
			externalAvailable = false
		},
		restoreStorage: () => {
			externalAvailable = true
		},
		failWrite: (value: boolean) => {
			failWrite = value
		},
	}
}
const alice = spikePeople.alice!
const bob = spikePeople.bob!
const agent = spikePeople.agent!
const outsider = spikePeople.outsider!
const viewer = spikePeople.viewer!
const id = '0d477131-29ca-4ca5-9d61-9119e18a607a'
async function initialized() {
	const h = harness()
	const session = h.create()
	await session.initialize(alice, id, 'Notes', {
		bob: 'edit',
		agent: 'edit',
		viewer: 'view',
	})
	return { h, session }
}

test('two offline humans and an anchored agent patch merge, then survive a fresh session instance', async () => {
	const { h, session } = await initialized()
	const initial = await session.view(alice)
	const first = new Y.Doc(),
		second = new Y.Doc()
	Y.applyUpdate(first, fromBase64(initial.state))
	Y.applyUpdate(second, fromBase64(initial.state))
	first.getText('content').insert(first.getText('content').length, 'Alice\n')
	second.getText('content').insert(second.getText('content').length, 'Bob\n')
	await session.update(alice, Y.encodeStateAsUpdate(first))
	await session.patch(agent, {
		kind: 'anchor',
		quote: '# Notes',
		replacement: '# Team notes',
	})
	await session.update(bob, Y.encodeStateAsUpdate(second))
	const recovered = await h.create().view(alice)
	assert.match(recovered.content, /# Team notes/)
	assert.match(recovered.content, /Alice/)
	assert.match(recovered.content, /Bob/)
	assert.equal(recovered.version, 3)
	assert.equal(h.events.length, 3)
	first.destroy()
	second.destroy()
})

test('stale full replacements return all three versions and ambiguous anchors do not write', async () => {
	const { session } = await initialized()
	const base = await session.view(agent)
	await session.patch(alice, {
		kind: 'anchor',
		quote: '# Notes',
		replacement: '# Changed\nrepeat repeat',
	})
	const result = await session.patch(agent, {
		kind: 'replace',
		baseVersion: base.version,
		base: base.content,
		content: '# Proposed',
	})
	assert.equal(result.ok, false)
	if (!result.ok && result.code === 'stale_replace' && 'base' in result) {
		assert.equal(result.base, base.content)
		assert.match(result.current, /Changed/)
		assert.equal(result.proposed, '# Proposed')
	}
	const ambiguous = await session.patch(agent, {
		kind: 'anchor',
		quote: 'repeat',
		replacement: 'new',
	})
	assert.equal(ambiguous.ok, false)
	assert.equal((await session.view(alice)).version, 1)
})

test('cross-org reads, viewer edits, and revoked grants fail closed', async () => {
	const { session } = await initialized()
	await assert.rejects(session.view(outsider), { code: 'not_found' })
	await assert.rejects(
		session.patch(viewer, {
			kind: 'anchor',
			quote: '# Notes',
			replacement: '# No',
		}),
		{ code: 'forbidden' },
	)
	await session.grant(alice, bob.personId, null)
	await assert.rejects(session.view(bob), { code: 'not_found' })
	await assert.rejects(session.update(bob, new Uint8Array()), {
		code: 'not_found',
	})
	await assert.rejects(session.grant(agent, bob.personId, 'edit'), {
		code: 'forbidden',
	})
})

test('oversized and malformed updates cannot mutate acknowledged content', async () => {
	const { session } = await initialized()
	await assert.rejects(session.update(alice, Uint8Array.of(255)), {
		code: 'invalid_update',
	})
	await assert.rejects(
		session.patch(agent, {
			kind: 'replace',
			baseVersion: 0,
			base: '# Notes\n\n',
			content: 'x'.repeat(documentLimits.contentBytes + 1),
		}),
		{ code: 'content_limit' },
	)
	assert.equal((await session.view(alice)).content, '# Notes\n\n')
})

test('a failed durable write neither acknowledges nor broadcasts edits', async () => {
	const { h, session } = await initialized()
	h.failWrite(true)
	await assert.rejects(
		session.patch(agent, {
			kind: 'anchor',
			quote: '# Notes',
			replacement: '# Lost',
		}),
	)
	h.failWrite(false)
	assert.equal((await h.create().view(alice)).content, '# Notes\n\n')
	assert.equal(h.events.length, 0)
})

test('storage moves preserve identity, grants, and history, revocation preserves readable live state', async () => {
	const { h, session } = await initialized()
	await session.patch(agent, {
		kind: 'anchor',
		quote: '# Notes',
		replacement: '# Team',
	})
	await session.checkpoint(alice)
	const before = await session.export(bob)
	await session.migrate(alice, 'external')
	assert.deepEqual(await session.export(bob), before)
	assert.equal((await session.inspect(alice)).recoveryCopy, 'included')
	h.revokeStorage()
	const degraded = await h.create().view(alice)
	assert.equal(degraded.content, '# Team\n\n')
	assert.equal(degraded.storageAvailable, false)
	assert.equal(degraded.canEdit, false)
	await assert.rejects(
		session.patch(agent, {
			kind: 'anchor',
			quote: '# Team',
			replacement: '# No',
		}),
		{ code: 'storage_unavailable' },
	)
	h.restoreStorage()
	await session.finishMove(alice)
	assert.equal(h.blobs.included.size, 0)
	assert.deepEqual(await session.export(bob), before)
	await session.purge(alice)
	assert.equal(h.blobs.external.size, 0)
	await assert.rejects(session.view(alice), { code: 'not_found' })
})

test('failed migration leaves source authoritative, retries and purge clean interrupted copies', async () => {
	const { h, session } = await initialized()
	h.revokeStorage()
	await assert.rejects(session.migrate(alice, 'external'))
	assert.equal((await session.inspect(alice)).location, 'included')
	assert.equal((await session.view(alice)).canEdit, true)
	h.restoreStorage()
	await session.migrate(alice, 'external')
	await session.purge(alice)
	assert.equal(h.blobs.included.size + h.blobs.external.size, 0)
})

test('history is bounded and a leftover checkpoint intent cannot delete a committed revision', async () => {
	const { h, session } = await initialized()
	const state = h.persisted.get('document') as DurableDocument
	h.persisted.set('pending-revision', {
		location: 'included',
		key: revisionKey(state.file, state.file.revisions[0]!.id),
	})
	for (let index = 1; index < documentLimits.revisions; index++) {
		const current = await session.view(alice)
		await session.patch(agent, {
			kind: 'replace',
			baseVersion: current.version,
			base: current.content,
			content: `# Version ${index}`,
		})
		await session.checkpoint(alice)
	}
	assert.equal(
		(await session.export(alice)).history.length,
		documentLimits.revisions,
	)
	const current = await session.view(alice)
	await session.patch(agent, {
		kind: 'replace',
		baseVersion: current.version,
		base: current.content,
		content: '# Next',
	})
	await assert.rejects(session.checkpoint(alice), { code: 'history_limit' })
	assert.equal((await session.view(alice)).content, '# Next')
})
