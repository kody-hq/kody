import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	redirect,
} from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { QueryClient, MutationObserver } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ open: vi.fn(), checkout: vi.fn() }))
vi.mock('#start/server/billing-mutations', () => ({
	openBillingPortal: mocks.open,
	startCheckout: mocks.checkout,
}))
import {
	billingPortalMutationOptions,
	billingCheckoutMutationOptions,
} from './billing-checkout.ts'

test('portal mutation finishes after navigation without redirecting the retained page', async () => {
	const client = new QueryClient()
	let finish!: (value: { ok: true; url: string }) => void
	mocks.open.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const mutation = new MutationObserver(client, billingPortalMutationOptions)
	const unsubscribe = mutation.subscribe(() => {})
	let current = true
	const navigate = vi.fn()
	const pending = mutation.mutate('original-team', {
		onSuccess: (result) => {
			if (current) navigate(result.url)
		},
	})
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
	expect(mutation.getCurrentResult().isPending).toBe(true)
	current = false
	finish({ ok: true, url: 'https://billing.stripe.com/old-team' })
	await pending
	expect(mutation.getCurrentResult().isPending).toBe(false)
	expect(navigate).not.toHaveBeenCalled()
	expect(mocks.open).toHaveBeenCalledWith({
		data: { orgSlug: 'original-team' },
	})
	unsubscribe()
	client.clear()
})

test('checkout pending clears after navigation and retains submitted plan variables', async () => {
	const client = new QueryClient()
	let finish!: (value: { url: string }) => void
	mocks.checkout.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const mutation = new MutationObserver(client, billingCheckoutMutationOptions)
	const unsubscribe = mutation.subscribe(() => {})
	let current = true
	const navigate = vi.fn()
	const pending = mutation.mutate(
		{ orgSlug: 'original-team', plan: 'pro', interval: 'year', promoCode: '' },
		{
			onSuccess: (result) => {
				if (current && result.ok) navigate(result.url)
			},
		},
	)
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
	expect(mutation.getCurrentResult()).toMatchObject({
		isPending: true,
		variables: { orgSlug: 'original-team', plan: 'pro', interval: 'year' },
	})
	current = false
	finish({ url: 'https://checkout.stripe.com/old-team' })
	await pending
	expect(mutation.getCurrentResult().isPending).toBe(false)
	expect(navigate).not.toHaveBeenCalled()
	unsubscribe()
	client.clear()
})

for (const reloadDocument of [false, true]) {
	test(`checkout auth redirects reach native Query integration, document=${reloadDocument}`, async () => {
		const queryClient = new QueryClient()
		const root = createRootRoute()
		const router = createRouter({
			origin: 'https://kody.test',
			isServer: false,
			history: createMemoryHistory({ initialEntries: ['/'] }),
			routeTree: root.addChildren(
				['/', '/login'].map((path) =>
					createRoute({ getParentRoute: () => root, path }),
				),
			),
		})
		setupRouterSsrQueryIntegration({ router, queryClient })
		await router.load()
		const navigate = reloadDocument
			? vi.spyOn(router, 'navigate').mockResolvedValue(undefined)
			: null
		const failure = redirect({ href: '/login', reloadDocument, replace: true })
		mocks.checkout.mockRejectedValueOnce(failure)
		const onSuccess = vi.fn()
		const mutation = queryClient
			.getMutationCache()
			.build(queryClient, { ...billingCheckoutMutationOptions, onSuccess })
		try {
			await expect(
				mutation.execute({
					orgSlug: 'team',
					plan: 'pro',
					interval: 'month',
					promoCode: '',
				}),
			).rejects.toBe(failure)
			expect(mutation.state.status).toBe('error')
			expect(onSuccess).not.toHaveBeenCalled()
			if (navigate)
				expect(navigate).toHaveBeenCalledWith(
					expect.objectContaining({
						href: '/login',
						reloadDocument: true,
						replace: true,
					}),
				)
			else expect(router.state.location.pathname).toBe('/login')
		} finally {
			navigate?.mockRestore()
			queryClient.clear()
		}
	})
}

test('checkout ordinary failures retain the plan-card error result', async () => {
	const client = new QueryClient()
	mocks.checkout.mockRejectedValueOnce(new Error('Billing is unavailable.'))
	const mutation = client
		.getMutationCache()
		.build(client, billingCheckoutMutationOptions)
	try {
		await expect(
			mutation.execute({
				orgSlug: 'team',
				plan: 'pro',
				interval: 'month',
				promoCode: '',
			}),
		).resolves.toEqual({ ok: false, error: 'Billing is unavailable.' })
	} finally {
		client.clear()
	}
})
