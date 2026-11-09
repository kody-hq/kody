import { expect, test } from 'vitest'
import { CommentLedger } from './comment-ledger.ts'
import {
	type CollaborationActor,
	type CommentCommand,
} from '#universal/file-collaboration.ts'
function fixture() {
	let data = new Map<string, unknown>()
	const storage = {
		async delete(key: string) {
			return data.delete(key)
		},
		async get(key: string) {
			return structuredClone(data.get(key))
		},
		async put(key: string | Record<string, unknown>, value?: unknown) {
			if (typeof key === 'string') data.set(key, structuredClone(value))
			else
				for (const [k, v] of Object.entries(key))
					data.set(k, structuredClone(v))
		},
		async list(options: {
			prefix: string
			limit?: number
			startAfter?: string
		}) {
			return new Map(
				[...data]
					.filter(
						([key]) =>
							key.startsWith(options.prefix) &&
							(!options.startAfter || key > options.startAfter),
					)
					.sort(([a], [b]) => a.localeCompare(b))
					.slice(0, options.limit),
			)
		},
		async transaction<T>(
			run: (tx: ConstructorParameters<typeof CommentLedger>[0]) => Promise<T>,
		) {
			const before = structuredClone(data)
			try {
				return await run(
					storage as unknown as ConstructorParameters<typeof CommentLedger>[0],
				)
			} catch (e) {
				data = before
				throw e
			}
		},
	}
	const ledger = new CommentLedger(
		storage as unknown as ConstructorParameters<typeof CommentLedger>[0],
	)
	const actor: CollaborationActor = {
		id: 'alice',
		personId: 'alice',
		name: 'Alice',
		kind: 'person',
		profileId: null,
		runId: null,
	}
	const fileId = crypto.randomUUID(),
		revisionId = crypto.randomUUID(),
		threadId = crypto.randomUUID(),
		commentId = crypto.randomUUID()
	const access = { read: true, write: false, comment: true, manage: false }
	const run = (command: CommentCommand, who = actor, permissions = access) =>
		ledger.command({
			command,
			actor: who,
			access: permissions,
			fileId,
			revisionId,
			sequence: 0,
		})
	const create: CommentCommand = {
		kind: 'create',
		operationId: crypto.randomUUID(),
		threadId,
		commentId,
		anchor: { kind: 'file' },
		body: 'Please review',
	}
	return { ledger, storage, actor, run, create, threadId, commentId, access }
}
test('comment retries are idempotent and cannot reuse an operation id with another body', async () => {
	const f = fixture()
	await f.run(f.create)
	expect(await f.run(f.create)).toMatchObject({ replayed: true })
	expect((await f.ledger.list()).comments).toHaveLength(1)
	await expect(f.run({ ...f.create, body: 'Different' })).rejects.toThrow(
		'already used',
	)
})
test('comment-only access supports replies and resolution, while read-only access cannot mutate', async () => {
	const f = fixture()
	await f.run(f.create)
	await f.run({
		kind: 'reply',
		operationId: crypto.randomUUID(),
		threadId: f.threadId,
		commentId: crypto.randomUUID(),
		body: 'Reviewed',
	})
	await f.run({
		kind: 'resolve',
		operationId: crypto.randomUUID(),
		threadId: f.threadId,
		expectedVersion: 0,
		resolved: true,
	})
	expect((await f.ledger.list()).threads[0]?.resolvedBy?.id).toBe('alice')
	await expect(
		f.run({ ...f.create, operationId: crypto.randomUUID() }, f.actor, {
			...f.access,
			comment: false,
		}),
	).rejects.toThrow('access')
})
test('agent identity is distinct from its operator and stale moderation cannot overwrite a newer change', async () => {
	const f = fixture()
	await f.run(f.create)
	const agent = { ...f.actor, id: 'agent', kind: 'agent' as const }
	await expect(
		f.run(
			{
				kind: 'edit',
				operationId: crypto.randomUUID(),
				commentId: f.commentId,
				expectedVersion: 0,
				body: 'Changed',
			},
			agent,
		),
	).rejects.toThrow('author')
	await f.run({
		kind: 'edit',
		operationId: crypto.randomUUID(),
		commentId: f.commentId,
		expectedVersion: 0,
		body: 'Changed',
	})
	await expect(
		f.run({
			kind: 'remove',
			operationId: crypto.randomUUID(),
			commentId: f.commentId,
			expectedVersion: 0,
		}),
	).rejects.toThrow('changed')
	expect((await f.ledger.list()).comments[0]?.body).toBe('Changed')
})

test('mention notifications are durable and read receipts do not enqueue notifications', async () => {
	const f = fixture()
	await f.run({ ...f.create, kind: 'create', body: '@bob please review' })
	await f.ledger.deliverNotifications(async (name) =>
		name === 'bob' ? 'bob' : null,
	)
	expect(await f.ledger.notifications('alice')).toEqual([])
	const notifications = await f.ledger.notifications('bob')
	expect(notifications).toHaveLength(1)
	expect(notifications[0]?.read).toBe(false)
	await f.run(
		{
			kind: 'read',
			operationId: crypto.randomUUID(),
			threadId: f.threadId,
			sequence: 1,
		},
		{ ...f.actor, id: 'bob', personId: 'bob' },
	)
	expect((await f.ledger.notifications('bob'))[0]?.read).toBe(true)
	await f.ledger.deliverNotifications(async () => 'bob')
	expect(await f.ledger.notifications('bob')).toHaveLength(1)
})

test('deep discussions page every reply and send exact edits outside the first page', async () => {
	const f = fixture()
	await f.run(f.create)
	for (let i = 0; i < 105; i++)
		await f.run({
			kind: 'reply',
			operationId: crypto.randomUUID(),
			threadId: f.threadId,
			commentId: crypto.randomUUID(),
			body: `Reply ${i}`,
		})
	const initial = await f.ledger.list()
	expect(initial.comments).toHaveLength(50)
	let cursor = initial.commentCursors[f.threadId]
	const comments = [...initial.comments]
	while (cursor) {
		const page = await f.ledger.listComments(f.threadId, cursor)
		comments.push(...page.comments)
		cursor = page.nextCursor
	}
	expect(comments).toHaveLength(106)
	expect(new Set(comments.map((c) => c.id)).size).toBe(106)
	const last = comments.at(-1)!
	const command: CommentCommand = {
		kind: 'edit',
		operationId: crypto.randomUUID(),
		commentId: last.id,
		expectedVersion: 0,
		body: 'Revised deep reply',
	}
	expect((await f.run(command)).comment?.body).toBe('Revised deep reply')
	expect((await f.run(command)).comment?.body).toBe('Revised deep reply')
	await expect(
		f.ledger.listComments(f.threadId, 'comment-order:another-thread:'),
	).rejects.toThrow('cursor')
})

test('legacy discussions rebuild the chronological index across storage pages', async () => {
	const f = fixture()
	await f.run(f.create)
	await f.storage.delete('comment-index-version')
	for (const key of (await f.storage.list({ prefix: 'comment-order:' })).keys())
		await f.storage.delete(key)
	const reopened = new CommentLedger(
		f.storage as unknown as ConstructorParameters<typeof CommentLedger>[0],
	)
	expect((await reopened.listComments(f.threadId)).comments[0]?.id).toBe(
		f.commentId,
	)
})
