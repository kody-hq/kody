import { jsx } from 'react/jsx-runtime'
import {
	QueryClient,
	QueryObserver,
	MutationObserver,
} from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { renderPackageWebhookCard as PackageWebhookCard } from './pages/package-webhook-card.tsx'
import { PackageWebhookSettings } from './pages/package-webhook-settings.tsx'
import { createPageQuery, ensurePageQuery } from './page-query.ts'
import { packageWebhooksQuery } from './package-webhooks-query.ts'
import { packageWebhookMutationOptions } from './package-webhook-mutation.ts'
import {
	type PackageWebhookListItem,
	type PackageWebhooksLoaderData,
} from '#universal/loader-data.ts'
const native = vi.hoisted(() => ({
	revealPackageWebhook: vi.fn(),
	rotatePackageWebhook: vi.fn(),
}))
vi.mock('#start/server/package-webhooks', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	revealPackageWebhook: native.revealPackageWebhook,
	rotatePackageWebhook: native.rotatePackageWebhook,
}))
const listCommands: PackageWebhookListItem = {
	id: 'raycast/list-commands',
	packageId: 'pkg-2',
	packageKodyId: 'raycast',
	packageName: '@jane/raycast',
	name: 'list-commands',
	endpointId: null,
	instanceLabel: null,
	exportName: './list-commands',
	description: 'Raycast asks for the command list',
	responseMode: 'sync',
	inputMode: 'params',
	rateLimitPerMinute: 600,
	verification: null,
	replay: null,
	challenge: null,
	minted: false,
	handle: null,
	urlHost: null,
	enabled: null,
	urlRecoverable: false,
	createdAt: null,
	rotatedAt: null,
	previousUrlActiveUntil: null,
	approved: true,
	approvalUrl: null,
}

const run: PackageWebhookListItem = {
	...listCommands,
	id: 'raycast/run',
	name: 'run',
	exportName: './run',
	description: null,
	replay: { deliveryIdHeader: 'X-Delivery-Id' },
	minted: true,
	handle: 'whh_11111111-1111-1111-1111-111111111111',
	urlHost: 'kody.example',
	enabled: true,
	urlRecoverable: true,
	createdAt: '2026-09-01T10:00:00.000Z',
	rotatedAt: '2026-09-05T10:00:00.000Z',
}

const secretUrl =
	'https://kody.example/@jane/webhooks/raycast/list-commands/s3cr3t-url-secret'
function listPayload(
	webhooks: Array<PackageWebhookListItem>,
): PackageWebhooksLoaderData {
	return { ok: true, username: 'jane', kodyId: 'raycast', webhooks }
}

const renderCard = (
	webhook: PackageWebhookListItem,
	revealedUrl: string | null = null,
) =>
	renderStartPage(
		jsx(PackageWebhookCard, {
			webhook,
			revealedUrl,
			isMutating: false,
			rotateCheck: { armed: false, onClick() {}, onBlur() {} },
			disableCheck: { armed: false, onClick() {}, onBlur() {} },
			onIntent() {},
			onHideUrl() {},
			deliveriesHref: '/@ada/-/activity?view=recent&status=all&surface=webhook',
		}),
	)
test('a webhook card points legacy mints at Rotate instead of Reveal and offers Enable when disabled', async () => {
	const html = await renderCard({
		...run,
		urlRecoverable: false,
		enabled: false,
	})
	expect(html).not.toContain('data-testid="package-webhook-reveal"')
	expect(html).toContain('aria-label="Enable raycast/run"')
	expect(html).toContain('>Disabled<')
	expect(html).toContain('600 / min')
	expect(html).toContain('delivery id X-Delivery-Id')
	expect(html).toContain('surface=webhook')
})

test('a webhook card shows previous URL overlap until the grace timestamp', async () => {
	const until = '2026-09-13T15:04:05.000Z'
	const overlapping = { ...run, previousUrlActiveUntil: until }
	const html = await renderCard(overlapping)
	expect(html).toContain('Previous URL')
	expect(html).toContain('active until')
	expect(html).toMatch(new RegExp(`dateTime="${until}"`, 'i'))
	expect(html).toContain('2026-09-13 15:04:05 UTC')

	const disabledHtml = await renderCard({ ...overlapping, enabled: false })
	expect(disabledHtml).not.toContain('Previous URL')
	expect(disabledHtml).toContain('>Disabled<')
})

test('revealed credential is rendered only while supplied to the local card', async () => {
	expect(await renderCard(run)).not.toContain(secretUrl)
	expect(await renderCard(run, secretUrl)).toContain(secretUrl)
	expect(await renderCard(run)).not.toContain(secretUrl)
})

test('accepted webhook outcome stays out of Query and resets transient mutation state', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const key = [
		'page',
		'actor',
		'loadPackageWebhooks',
		{ username: 'jane', kodyId: 'raycast' },
	] as const
	const other = [
		'page',
		'actor',
		'loadPackageWebhooks',
		{ username: 'jane', kodyId: 'other' },
	] as const
	client.setQueryData(key, listPayload([listCommands]))
	client.setQueryData(other, { marker: 'other' })
	native.revealPackageWebhook.mockResolvedValueOnce({
		ok: true,
		revealed: { id: run.id, url: secretUrl },
	})
	const observer = new MutationObserver(
		client,
		packageWebhookMutationOptions(client),
	)
	const unsubscribe = observer.subscribe(() => {})
	try {
		const invalidate = vi.fn(async () => {})
		const accepted = await observer.mutate({
			username: 'jane',
			kodyId: 'raycast',
			webhookName: run.name,
			endpointId: 'endpoint-staging',
			webhookId: run.id,
			intent: 'reveal',
			queryKey: key,
			invalidate,
		})
		expect(accepted.revealed?.url).toBe(secretUrl)
		expect(native.revealPackageWebhook).toHaveBeenLastCalledWith({
			data: {
				username: 'jane',
				kodyId: 'raycast',
				webhookName: run.name,
				endpointId: 'endpoint-staging',
				createInstance: undefined,
				instanceLabel: undefined,
			},
		})
		expect(client.getQueryData(key)).toEqual(listPayload([listCommands]))
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
		expect(
			JSON.stringify(
				client
					.getQueryCache()
					.getAll()
					.map((q) => q.state.data),
			),
		).not.toContain(secretUrl)
		expect(client.getQueryData(other)).toEqual({ marker: 'other' })
		expect(invalidate).toHaveBeenCalledOnce()
		observer.reset()
		await vi.waitFor(() =>
			expect(client.getMutationCache().getAll()).toHaveLength(0),
		)
	} finally {
		unsubscribe()
		client.clear()
		vi.unstubAllGlobals()
	}
})

test('failed webhook write retains rows and invalidates only its submitted package', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const key = [
		'page',
		'actor',
		'loadPackageWebhooks',
		{ username: 'jane', kodyId: 'raycast' },
	] as const
	const other = [
		'page',
		'actor',
		'loadPackageWebhooks',
		{ username: 'jane', kodyId: 'other' },
	] as const
	const payload = listPayload([run])
	client.setQueryData(key, payload)
	client.setQueryData(other, { marker: 'other' })
	native.rotatePackageWebhook.mockResolvedValueOnce({
		ok: false,
		error: 'Unable to rotate',
	})
	try {
		const mutation = client
			.getMutationCache()
			.build(client, packageWebhookMutationOptions(client))
		await expect(
			mutation.execute({
				username: 'jane',
				kodyId: 'raycast',
				webhookName: run.name,
				webhookId: run.id,
				intent: 'rotate',
				queryKey: key,
				invalidate: async () => {},
			}),
		).rejects.toThrow('Unable to rotate')
		expect(client.getQueryData(key)).toEqual(payload)
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
		expect(client.getQueryState(other)?.isInvalidated).toBe(false)
	} finally {
		client.clear()
		vi.unstubAllGlobals()
	}
})

test.each([{ webhooks: [] }, { webhooks: [run] }])(
	'native settings render cached webhook rows without a loading flash',
	async ({ webhooks }) => {
		const html = await renderStartPage(
			jsx(PackageWebhookSettings, { username: 'jane', kodyId: 'raycast' }),
			'/@jane/raycast/settings',
			null,
			(client) => {
				client.setQueryData(
					packageWebhooksQuery(null, { username: 'jane', kodyId: 'raycast' })
						.queryKey,
					listPayload(webhooks),
				)
			},
		)
		expect(html).not.toContain('Loading webhooks')
		expect(html).not.toContain(secretUrl)
		if (webhooks.length) expect(html).toContain('package-webhook-card')
		else {
			expect(html).toContain('package-webhook-settings-empty')
			expect(html).toContain('declares no webhooks yet')
		}
	},
)

test('webhook settlement keeps an uncached navigation alive', async () => {
	const client = new QueryClient()
	const payload = listPayload([run])
	let finish!: (value: typeof payload) => void
	native.revealPackageWebhook.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const query = createPageQuery(
		'loadPackageWebhooks',
		async (_input: {
			data: { username: string; kodyId: string }
			signal: AbortSignal
		}) => payload,
	)('actor', { username: 'jane', kodyId: 'raycast' })
	const mutation = client.getMutationCache().build(client, {
		...packageWebhookMutationOptions(client),
		mutationKey: ['packageWebhooks', 'actor', 'jane', 'raycast'],
	})
	const pending = mutation.execute({
		username: 'jane',
		kodyId: 'raycast',
		webhookName: run.name,
		webhookId: run.id,
		intent: 'reveal',
		queryKey: query.queryKey,
		invalidate: async () => {},
	})
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
	const navigation = ensurePageQuery(client, query, false)
	finish(payload)
	await pending
	await expect(navigation).resolves.toEqual(payload)
	client.clear()
})

test('webhook mutation waits for authoritative scoped read without caching its outcome', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const before = listPayload([run])
	const after = listPayload([{ ...run, enabled: false }])
	let finish!: (data: typeof after) => void
	const query = createPageQuery(
		'loadPackageWebhooks',
		async (_input: {
			data: { username: string; kodyId: string }
			signal: AbortSignal
		}) =>
			new Promise<typeof after>((resolve) => {
				finish = resolve
			}),
	)('actor', { username: 'jane', kodyId: 'raycast' })
	client.setQueryData(query.queryKey, before)
	const observer = new QueryObserver(client, { ...query, staleTime: Infinity })
	const unsubscribe = observer.subscribe(() => {})
	native.rotatePackageWebhook.mockResolvedValueOnce({ ok: true })
	const mutation = client.getMutationCache().build(client, {
		...packageWebhookMutationOptions(client),
		mutationKey: ['packageWebhooks', 'actor', 'jane', 'raycast'],
	})
	const pending = mutation.execute({
		username: 'jane',
		kodyId: 'raycast',
		webhookName: run.name,
		webhookId: run.id,
		intent: 'rotate',
		queryKey: query.queryKey,
		invalidate: async () => {},
	})
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
	expect(mutation.state.status).toBe('pending')
	expect(client.getQueryData(query.queryKey)).toEqual(before)
	finish(after)
	await pending
	expect(mutation.state.status).toBe('success')
	expect(client.getQueryData(query.queryKey)).toEqual(after)
	unsubscribe()
	client.clear()
})

test.each(
	(['success', 'lost response'] as const).flatMap((outcome) =>
		[true, false].flatMap((active) =>
			[true, false].map((readFinishesFirst) => ({
				outcome,
				active,
				readFinishesFirst,
			})),
		),
	),
)(
	'uncached webhook navigation confirms after its older read: $outcome active=$active read-first=$readFinishesFirst',
	async ({ outcome, active, readFinishesFirst }) => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		})
		const before = listPayload([run])
		const after = listPayload([{ ...run, enabled: false }])
		let finishRead!: (data: typeof before) => void
		let finishWrite!: () => void
		let failWrite!: (error: Error) => void
		native.rotatePackageWebhook.mockImplementationOnce(
			() =>
				new Promise((resolve, reject) => {
					finishWrite = () => resolve({ ok: true })
					failWrite = reject
				}),
		)
		const read = vi.fn<() => Promise<typeof before>>()
		read.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishRead = resolve
				}),
		)
		read.mockResolvedValue(after)
		const query = createPageQuery(
			'loadPackageWebhooks',
			async (_input: {
				data: { username: string; kodyId: string }
				signal: AbortSignal
			}) => read(),
		)('actor', { username: 'jane', kodyId: 'raycast' })
		const mutation = client.getMutationCache().build(client, {
			...packageWebhookMutationOptions(client),
			mutationKey: ['packageWebhooks', 'actor', 'jane', 'raycast'],
		})
		const navigation = ensurePageQuery(client, query, false)
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
		const write = mutation
			.execute({
				username: 'jane',
				kodyId: 'raycast',
				webhookName: run.name,
				webhookId: run.id,
				intent: 'rotate',
				queryKey: query.queryKey,
				invalidate: async () => {},
			})
			.catch(() => undefined)
		await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'))
		const observer = new QueryObserver(client, query)
		const stop = active ? observer.subscribe(() => {}) : () => {}
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
		if (readFinishesFirst) {
			finishRead(before)
			await navigation
		}
		if (outcome === 'success') finishWrite()
		else failWrite(new Error('Lost response'))
		await Promise.resolve()
		if (!readFinishesFirst) finishRead(before)
		await expect(navigation).resolves.toEqual(before)
		await write
		expect(read).toHaveBeenCalledTimes(2)
		expect(client.getQueryData(query.queryKey)).toEqual(after)
		expect(client.isMutating()).toBe(0)
		stop()
		client.clear()
	},
)

test('labeled webhook cards use endpoint anchors and offer an additional URL without revealing cached secrets', async () => {
	const html = await renderStartPage(
		jsx(PackageWebhookCard, {
			webhook: {
				...run,
				endpointId: 'endpoint-staging',
				instanceLabel: 'staging',
			},
			revealedUrl: null,
			isMutating: false,
			rotateCheck: { armed: false, onClick() {}, onBlur() {} },
			disableCheck: { armed: false, onClick() {}, onBlur() {} },
			onIntent() {},
			onHideUrl() {},
			deliveriesHref: '/@jane/-/activity',
			showMintAnother: true,
		}),
	)
	expect(html).toContain('id="webhook-run-endpoint-staging"')
	expect(html).toContain('run · staging')
	expect(html).toContain('name="instanceLabel"')
	expect(html).toContain('maxLength="64"')
	expect(html).toContain('data-testid="package-webhook-mint-another-submit"')
	expect(html).not.toContain(secretUrl)
})
