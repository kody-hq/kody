import { expect, it, vi } from 'vitest'
import { defaultParseSearch } from '@tanstack/react-router'
import {
	MutationObserver,
	QueryClient,
	QueryObserver,
} from '@tanstack/react-query'
import {
	type AccountEmailLoaderData,
	type AccountEmailMessageDetail,
} from '#universal/loader-data.ts'
import {
	emailMutationOptions,
	optimisticEmail,
	publishEmailResponse,
	type EmailAction,
	type EmailMutationOutcome,
} from './account-email-query.ts'
import {
	emailKeys,
	emailSearch,
	emailResourceInput,
	type EmailListData,
} from './email-resources.ts'

const message: AccountEmailMessageDetail = {
	id: 'one',
	direction: 'inbound',
	inbox_id: null,
	thread_id: null,
	from_address: 'sender@example.com',
	envelope_from: null,
	to_addresses: [],
	subject: 'Hello',
	message_id_header: null,
	processing_status: 'stored',
	classification: 'quarantined',
	classification_reason: 'Original reason',
	sender_classification: null,
	sender_classification_reason: null,
	provider_message_id: null,
	delivery_status: null,
	delivery_status_at: null,
	error: null,
	received_at: null,
	sent_at: null,
	created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z',
	cc_addresses: [],
	bcc_addresses: [],
	reply_to_addresses: [],
	in_reply_to_header: null,
	references: [],
	headers: null,
	auth_results: null,
	text_body: 'Hello',
	html_body: null,
	raw_size: null,
	attachments: [],
	delivery_events: [],
	enable_sender: null,
}
const payload = (
	overrides: Partial<AccountEmailLoaderData> = {},
): AccountEmailLoaderData => ({
	ok: true,
	emailVerified: true,
	email: 'owner@example.com',
	username: 'owner',
	inboxAddress: null,
	verificationMessage: null,
	outboundDeliveryPausedAt: null,
	inboxes: [],
	messages: [message],
	selectedMessage: message,
	usage: null,
	page: 1,
	pageSize: 25,
	total: 1,
	query: '',
	classification: null,
	...overrides,
})
const action: EmailAction = {
	action: 'classify',
	orgSlug: null,
	messageId: 'one',
	classification: 'accepted',
}

function seed(client: QueryClient, href: string, actor = 'a') {
	const { list, messageId } = fixtureInput(href)
	const { selectedMessage, ...data } = payload({
		query: list.query,
		classification: list.classification,
		page: list.page,
		pageSize: list.pageSize,
	})
	client.setQueryData(emailKeys.list(actor, list), data)
	if (messageId)
		client.setQueryData(emailKeys.detail(actor, list.org, messageId), {
			...selectedMessage!,
			id: messageId,
		})
	return {
		listKey: emailKeys.list(actor, list),
		detailKey: emailKeys.detail(actor, list.org, messageId),
	}
}
it('selection reuses the list key, normalizes filters, and isolates actor and organization', () => {
	const a = fixtureInput(
		'/@acme/-/email/one?q=%20hello%20&page=01&pageSize=999',
	)
	const b = fixtureInput('/@acme/-/email/two?page=1&pageSize=100&q=hello')
	expect(emailKeys.list('a', a.list)).toEqual(emailKeys.list('a', b.list))
	expect(a.messageId).toBe('one')
	expect(b.messageId).toBe('two')
	expect(emailKeys.list('b', a.list)).not.toEqual(emailKeys.list('a', a.list))
	expect(emailKeys.list('a', { ...a.list, org: 'other' })).not.toEqual(
		emailKeys.list('a', a.list),
	)
	expect(emailKeys.destinations('a')).not.toEqual(emailKeys.destinations('b'))
})
it('optimism removes only known filtered rows without inventing page membership', () => {
	const result = optimisticEmail(
		payload({ classification: 'quarantined' }),
		action,
	)
	expect(result.messages).toEqual([])
	expect(result.total).toBe(0)
	expect(result.selectedMessage?.classification).toBe('accepted')
	expect(optimisticEmail(result, action).total).toBe(0)
	const unknown = payload({
		messages: [],
		selectedMessage: null,
		total: 30,
		page: 2,
	})
	expect(optimisticEmail(unknown, action)).toEqual(unknown)
})
it('publishes only the affected entity, preserving concurrent rows, other selections and scopes', async () => {
	const client = new QueryClient()
	const first = seed(client, '/@acme/-/email/one')
	const second = seed(client, '/@acme/-/email/two')
	const other = seed(client, '/@other/-/email/one')
	const actor = seed(client, '/@acme/-/email/one', 'b')
	const current = client.getQueryData<EmailListData>(first.listKey)!
	client.setQueryData(first.listKey, {
		...current,
		messages: [
			...current.messages,
			{ ...message, id: 'two', classification: 'accepted' },
		],
	})
	await publishEmailResponse(
		client,
		'a',
		{ ok: true, messageId: action.messageId },
		{
			...action,
			orgSlug: 'acme',
		},
	)
	const rows = client.getQueryData<EmailListData>(first.listKey)!.messages
	expect(rows.map((row) => row.classification)).toEqual([
		'accepted',
		'accepted',
	])
	expect(
		client.getQueryData<AccountEmailMessageDetail>(second.detailKey)?.id,
	).toBe('two')
	expect(
		client.getQueryData<AccountEmailMessageDetail>(other.detailKey)
			?.classification,
	).toBe('quarantined')
	expect(
		client.getQueryData<AccountEmailMessageDetail>(actor.detailKey)
			?.classification,
	).toBe('quarantined')
	client.clear()
})
it('keeps pending deletion visible, then removes confirmed rows and detail', async () => {
	const client = new QueryClient()
	const keys = seed(client, '/account/email/one')
	const deletion: EmailAction = {
		action: 'delete',
		orgSlug: null,
		messageId: 'one',
	}
	const before = payload()
	expect(optimisticEmail(before, deletion)).toBe(before)
	await publishEmailResponse(
		client,
		'a',
		{ ok: true, messageId: deletion.messageId },
		deletion,
	)
	expect(client.getQueryData(keys.detailKey)).toBeNull()
	expect(client.getQueryData<EmailListData>(keys.listKey)?.messages).toEqual([])
	expect(client.getQueryData<EmailListData>(keys.listKey)?.total).toBe(0)
	client.clear()
})
it.each(['accepted', 'lost-response'] as const)(
	'reconciles %s after unmount without blocking reads or rolling back another write',
	async (outcome) => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		})
		const keys = seed(client, '/account/email/one')
		let release!: (value: EmailMutationOutcome) => void
		let reject!: (error: Error) => void
		const send = vi.fn(
			() =>
				new Promise<EmailMutationOutcome>((resolve, fail) => {
					release = resolve
					reject = fail
				}),
		)
		const mutation = new MutationObserver(
			client,
			emailMutationOptions(client, 'a', send),
		)
		const unsubscribe = mutation.subscribe(() => {})
		const write = mutation.mutate(action).catch(() => undefined)
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
		unsubscribe()
		// A background read is allowed during a write. Applying pending intent to
		// its result preserves optimistic UI without altering authoritative data.
		const read = vi.fn(async () => payload())
		const fresh = await client.fetchQuery({
			queryKey: ['independent-read'],
			queryFn: read,
		})
		expect(read).toHaveBeenCalledOnce()
		expect(optimisticEmail(fresh, action).selectedMessage?.classification).toBe(
			'accepted',
		)
		expect(
			client.getQueryData<AccountEmailMessageDetail>(keys.detailKey)
				?.classification,
		).toBe('quarantined')
		const confirmed = { ...message, classification: 'accepted' as const }
		const confirmingRead = vi.fn(async () => confirmed)
		const observer = new QueryObserver(client, {
			queryKey: keys.detailKey,
			queryFn: confirmingRead,
			staleTime: Infinity,
		})
		const stop = observer.subscribe(() => {})
		if (outcome === 'accepted')
			release({ ok: true, messageId: action.messageId })
		else reject(new Error('Lost response after commit'))
		await write
		expect(confirmingRead).toHaveBeenCalledOnce()
		expect(
			client.getQueryData<AccountEmailMessageDetail>(keys.detailKey)
				?.classification,
		).toBe('accepted')
		expect(client.isMutating()).toBe(0)
		stop()
		client.clear()
	},
)

it('a failed concurrent classification never rolls back another accepted message', async () => {
	const client = new QueryClient()
	const keys = seed(client, '/account/email/one')
	const list = client.getQueryData<EmailListData>(keys.listKey)!
	client.setQueryData(keys.listKey, {
		...list,
		messages: [message, { ...message, id: 'two' }],
	})
	let failFirst!: (error: Error) => void
	let acceptSecond!: (data: EmailMutationOutcome) => void
	const first = new MutationObserver(
		client,
		emailMutationOptions(
			client,
			'a',
			() =>
				new Promise((_resolve, reject) => {
					failFirst = reject
				}),
		),
	)
	const second = new MutationObserver(
		client,
		emailMutationOptions(
			client,
			'a',
			() =>
				new Promise((resolve) => {
					acceptSecond = resolve
				}),
		),
	)
	const writeOne = first.mutate(action).catch(() => undefined)
	const actionTwo = {
		...action,
		orgSlug: null,
		messageId: 'two',
	}
	const writeTwo = second.mutate(actionTwo)
	await vi.waitFor(() => expect(client.isMutating()).toBe(2))
	acceptSecond({ ok: true, messageId: 'two', classification: 'accepted' })
	await writeTwo
	failFirst(new Error('First write rejected'))
	await writeOne
	expect(
		client
			.getQueryData<EmailListData>(keys.listKey)
			?.messages.map((row) => row.classification),
	).toEqual(['quarantined', 'accepted'])
	expect(client.getQueryState(keys.listKey)?.isInvalidated).toBe(true)
	client.clear()
})

it('keeps search editing whitespace in the URL while normalizing only resource identity', () => {
	const editing = emailSearch({ q: '  hello ' })
	expect(editing.q).toBe('  hello ')
	const raw = fixtureInput('/@acme/-/email?q=%20%20hello%20')
	const normalized = fixtureInput('/@acme/-/email?q=hello')
	expect(raw.list.query).toBe('hello')
	expect(emailKeys.list('actor', raw.list)).toEqual(
		emailKeys.list('actor', normalized.list),
	)
	expect(emailSearch({ q: ' ' }).q).toBe(' ')
	expect(fixtureInput('/@acme/-/email?q=%20').list.query).toBe('')
})

it.each(
	(['accepted', 'lost-response'] as const).flatMap((outcome) =>
		[true, false].flatMap((active) =>
			[true, false].map((readFinishesFirst) => ({
				outcome,
				active,
				readFinishesFirst,
			})),
		),
	),
)(
	'preserves uncached navigation and confirms after the older read for $outcome active=$active read-first=$readFinishesFirst',
	async ({ outcome, active, readFinishesFirst }) => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		})
		let finishRead!: (data: AccountEmailMessageDetail) => void
		let finishWrite!: () => void
		let failWrite!: (error: Error) => void
		const key = emailKeys.detail('a', null, 'one')
		const read = vi.fn<() => Promise<AccountEmailMessageDetail>>()
		read.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishRead = resolve
				}),
		)
		read.mockResolvedValue({ ...message, classification: 'accepted' })
		const mutation = new MutationObserver(
			client,
			emailMutationOptions(
				client,
				'a',
				() =>
					new Promise<EmailMutationOutcome>((resolve, reject) => {
						finishWrite = () =>
							resolve({
								ok: true,
								messageId: 'one',
								classification: 'accepted',
							})
						failWrite = reject
					}),
			),
		)
		const write = mutation.mutate(action).catch(() => undefined)
		await vi.waitFor(() => expect(finishWrite).toBeDefined())
		const options = { queryKey: key, queryFn: read, staleTime: Infinity }
		const navigation = client.ensureQueryData(options)
		const observer = new QueryObserver(client, options)
		const stop = active ? observer.subscribe(() => {}) : () => {}
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
		if (readFinishesFirst) {
			finishRead(message)
			await navigation
		}
		if (outcome === 'accepted') finishWrite()
		else failWrite(new Error('Lost response'))
		await Promise.resolve()
		if (!readFinishesFirst) finishRead(message)
		await expect(navigation).resolves.toEqual(message)
		await write
		expect(read).toHaveBeenCalledTimes(2)
		expect(
			client.getQueryData<AccountEmailMessageDetail>(key)?.classification,
		).toBe('accepted')
		expect(client.isMutating()).toBe(0)
		stop()
		client.clear()
	},
)

// Fixtures model Router's already decoded params and validated search input.
function fixtureInput(href: string) {
	const url = new URL(href, 'https://kody.test')
	const parts = url.pathname.split('/')
	const isOrg = parts[1]?.startsWith('@')
	return emailResourceInput(
		{
			orgSlug: isOrg ? decodeURIComponent(parts[1]!.slice(1)) : null,
			messageId: parts[isOrg ? 4 : 3]
				? decodeURIComponent(parts[isOrg ? 4 : 3]!)
				: undefined,
		},
		emailSearch(defaultParseSearch(url.search)),
	)
}

it('email inputs trust decoded Router params and use selected search only on the list route', () => {
	const search = emailSearch({ selected: ' fallback ', q: ' hello ' })
	expect(
		emailResourceInput({ orgSlug: 'team', messageId: 'literal%2Fpart' }, search)
			.messageId,
	).toBe('literal%2Fpart')
	expect(emailResourceInput({ orgSlug: 'team' }, search).messageId).toBe(
		'fallback',
	)
	expect(
		emailResourceInput({ orgSlug: 'team' }, emailSearch({})).messageId,
	).toBeNull()
})
