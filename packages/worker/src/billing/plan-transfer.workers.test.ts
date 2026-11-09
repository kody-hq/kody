import { env } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { ensureCreditWalletTestSchema } from './test-schema.ts'
import { ensurePlanTransferTestSchema } from './plan-transfer-test-schema.ts'
import {
	advancePlanTransfer,
	advancePlanTransferForCheckoutSession,
	cancelPlanTransfer,
	previewPlanTransfer,
	readPlanTransfer,
	resumeOpenPlanTransferForOrg,
	startPlanTransfer,
} from './plan-transfer.ts'

const day = 24 * 60 * 60
const now = new Date('2026-11-07T17:00:00.000Z')
const nowSeconds = Math.floor(now.valueOf() / 1000)

type FakeSubscription = {
	id: string
	customer: string
	status: string
	cancel_at: number | null
	current_period_end: number
	currency: string
	metadata?: Record<string, string>
	items: {
		data: Array<{
			id: string
			quantity: number
			price: { id: string }
			current_period_end: number
		}>
	}
}

type FakeInvoice = {
	id: string
	subscription: string
	amount_paid: number
	currency: string
	lines: {
		data: Array<{
			id: string
			amount: number
			period: { start: number; end: number }
		}>
	}
}

type FakeCreditNote = {
	id: string
	invoice: string
	total: number
	currency: string
	status: string
	metadata: Record<string, string>
	form: Record<string, string>
}

type FakeBalanceTransaction = {
	id: string
	customer: string
	amount: number
	currency: string
	metadata: Record<string, string>
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/**
 * In-memory Stripe for the endpoints a plan move touches. Writes honour
 * `Idempotency-Key` like Stripe does, so retries can be asserted.
 */
function createFakeStripe() {
	const subscriptions: Array<FakeSubscription> = []
	const invoices: Array<FakeInvoice> = []
	const creditNotes: Array<FakeCreditNote> = []
	const balanceTransactions: Array<FakeBalanceTransaction> = []
	const checkoutSessions: Array<{ id: string; form: Record<string, string> }> =
		[]
	const idempotent = new Map<string, unknown>()
	const failures = new Map<string, number>()
	let counter = 0
	const nextId = (prefix: string) => `${prefix}_${++counter}`

	function failNext(key: string, times = 1) {
		failures.set(key, times)
	}

	function shouldFail(key: string) {
		const remaining = failures.get(key) ?? 0
		if (remaining <= 0) return false
		failures.set(key, remaining - 1)
		return true
	}

	function readForm(init?: RequestInit) {
		return Object.fromEntries(
			new URLSearchParams(String(init?.body ?? '')).entries(),
		)
	}

	function metadataFrom(form: Record<string, string>) {
		const metadata: Record<string, string> = {}
		for (const [key, value] of Object.entries(form)) {
			const match = /^metadata\[(.+)\]$/.exec(key)
			if (match?.[1]) metadata[match[1]] = value
		}
		return metadata
	}

	function linesTotal(form: Record<string, string>) {
		let total = 0
		for (const [key, value] of Object.entries(form)) {
			if (/^lines\[\d+\]\[amount\]$/.test(key)) total += Number(value)
		}
		return total
	}

	function handle(url: URL, init?: RequestInit): Response {
		const method = init?.method ?? 'GET'
		const path = url.pathname
		const headers = new Headers(init?.headers)
		const idempotencyKey = headers.get('Idempotency-Key')
		if (idempotencyKey && idempotent.has(idempotencyKey)) {
			return jsonResponse(idempotent.get(idempotencyKey))
		}
		const remember = (body: unknown) => {
			if (idempotencyKey) idempotent.set(idempotencyKey, body)
			return jsonResponse(body)
		}

		if (path === '/v1/subscriptions' && method === 'GET') {
			const customer = url.searchParams.get('customer')
			return jsonResponse({
				data: subscriptions.filter((sub) => sub.customer === customer),
				has_more: false,
			})
		}
		const subscriptionMatch = /^\/v1\/subscriptions\/([^/]+)$/.exec(path)
		if (subscriptionMatch && method === 'DELETE') {
			if (shouldFail('cancel')) {
				return jsonResponse(
					{ error: { type: 'api_error', message: 'boom' } },
					500,
				)
			}
			const sub = subscriptions.find((s) => s.id === subscriptionMatch[1])
			if (!sub) {
				return jsonResponse(
					{
						error: { type: 'invalid_request_error', code: 'resource_missing' },
					},
					404,
				)
			}
			sub.status = 'canceled'
			return jsonResponse({ id: sub.id, status: 'canceled' })
		}
		if (path === '/v1/invoices' && method === 'GET') {
			const subscription = url.searchParams.get('subscription')
			return jsonResponse({
				data: invoices.filter((inv) => inv.subscription === subscription),
				has_more: false,
			})
		}
		if (path === '/v1/credit_notes/preview' && method === 'GET') {
			const form = Object.fromEntries(url.searchParams.entries())
			return jsonResponse({ total: linesTotal(form), currency: 'usd' })
		}
		if (path === '/v1/credit_notes' && method === 'GET') {
			const invoice = url.searchParams.get('invoice')
			return jsonResponse({
				data: creditNotes.filter((note) => note.invoice === invoice),
				has_more: false,
			})
		}
		if (path === '/v1/credit_notes' && method === 'POST') {
			const form = readForm(init)
			const invoice = invoices.find((inv) => inv.id === form.invoice)
			const note: FakeCreditNote = {
				id: nextId('cn'),
				invoice: form.invoice ?? '',
				total: linesTotal(form),
				currency: invoice?.currency ?? 'usd',
				status: 'issued',
				metadata: metadataFrom(form),
				form,
			}
			creditNotes.push(note)
			return remember(note)
		}
		const balanceMatch =
			/^\/v1\/customers\/([^/]+)\/balance_transactions$/.exec(path)
		if (balanceMatch && method === 'GET') {
			return jsonResponse({
				data: balanceTransactions.filter(
					(txn) => txn.customer === balanceMatch[1],
				),
				has_more: false,
			})
		}
		if (balanceMatch && method === 'POST') {
			if (shouldFail('balance')) {
				return jsonResponse(
					{ error: { type: 'api_error', message: 'boom' } },
					500,
				)
			}
			const form = readForm(init)
			const txn: FakeBalanceTransaction = {
				id: nextId('cbtxn'),
				customer: balanceMatch[1] ?? '',
				amount: Number(form.amount),
				currency: form.currency ?? 'usd',
				metadata: metadataFrom(form),
			}
			balanceTransactions.push(txn)
			return remember(txn)
		}
		if (path === '/v1/checkout/sessions' && method === 'POST') {
			const session = { id: nextId('cs_test'), form: readForm(init) }
			checkoutSessions.push(session)
			return remember({
				id: session.id,
				url: `https://checkout.stripe.mock/${session.id}`,
			})
		}
		return jsonResponse(
			{
				error: { type: 'invalid_request_error', message: `${method} ${path}` },
			},
			404,
		)
	}

	const fetchStub = vi.fn(
		async (request: RequestInfo | URL, init?: RequestInit) =>
			handle(new URL(String(request)), init),
	)
	vi.stubGlobal('fetch', fetchStub)

	function addProSubscription(input: {
		customer: string
		interval: 'month' | 'year'
		seats?: number
		priceId?: string
		currency?: string
		metadata?: Record<string, string>
		paidMinor?: number
		periodStart?: number
		periodEnd?: number
	}) {
		const periodStart =
			input.periodStart ??
			nowSeconds - (input.interval === 'month' ? 10 * day : 100 * day)
		const periodEnd =
			input.periodEnd ??
			periodStart + (input.interval === 'month' ? 30 * day : 365 * day)
		const seats = input.seats ?? 1
		const priceId =
			input.priceId ??
			(input.interval === 'month' ? 'price_pro' : 'price_pro_yearly')
		const subscription: FakeSubscription = {
			id: nextId('sub'),
			customer: input.customer,
			status: 'active',
			cancel_at: null,
			current_period_end: periodEnd,
			currency: input.currency ?? 'usd',
			metadata: input.metadata,
			items: {
				data: [
					{
						id: nextId('si'),
						quantity: seats,
						price: { id: priceId },
						current_period_end: periodEnd,
					},
				],
			},
		}
		subscriptions.push(subscription)
		const amount =
			input.paidMinor ?? (input.interval === 'month' ? 1_200 : 12_000) * seats
		invoices.push({
			id: nextId('in'),
			subscription: subscription.id,
			amount_paid: amount,
			currency: input.currency ?? 'usd',
			lines: {
				data: [
					{
						id: nextId('il'),
						amount,
						period: { start: periodStart, end: periodEnd },
					},
				],
			},
		})
		return subscription
	}

	function requests(method: string, pathPrefix: string) {
		return fetchStub.mock.calls.filter(([request, init]) => {
			const url = new URL(String(request))
			return (
				(init?.method ?? 'GET') === method &&
				url.pathname.startsWith(pathPrefix)
			)
		})
	}

	return {
		subscriptions,
		invoices,
		creditNotes,
		balanceTransactions,
		checkoutSessions,
		addProSubscription,
		failNext,
		requests,
		[Symbol.dispose]: () => vi.unstubAllGlobals(),
	}
}

function testEnv() {
	return {
		...env,
		STRIPE_SECRET_KEY: 'sk_test_plan_transfer',
		STRIPE_API_BASE_URL: 'https://stripe.mock',
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		COOKIE_SECRET: 'plan-transfer-test-cookie-secret',
	} as unknown as Env
}

async function ensureSchema() {
	await ensureCreditWalletTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await ensurePlanTransferTestSchema(env.APP_DB)
	await auditDb()
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_audit_events (
			id TEXT PRIMARY KEY NOT NULL,
			org_id TEXT NOT NULL,
			actor_user_id TEXT,
			actor_username TEXT,
			credential_kind TEXT,
			credential_id TEXT,
			action TEXT NOT NULL,
			resource_type TEXT,
			resource_id TEXT,
			target_user_id TEXT,
			result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'denied')),
			details_json TEXT,
			ip_hash TEXT,
			created_at TEXT NOT NULL
		)`,
		)
		.run()
}

function auditDb(): D1Database {
	return (env as { AUDIT_DB?: D1Database }).AUDIT_DB ?? env.APP_DB
}

function uniqueSuffix() {
	return crypto.randomUUID().slice(0, 8)
}

async function seedUser(label: string) {
	const userId = `user-${label}-${uniqueSuffix()}`
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES (?, ?, 'test-password-hash', ?)`,
	)
		.bind(userId, `${userId}@example.com`, userId)
		.run()
	return userId
}

async function seedOrg(input: {
	label: string
	plan?: string
	stripePlan?: string | null
	stripeCustomerId?: string | null
	members: Array<{
		userId: string
		role: 'owner' | 'admin' | 'member' | 'billing'
	}>
}) {
	const orgId = `org-${input.label}-${uniqueSuffix()}`
	const iso = now.toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
			id, slug, plan, stripe_plan, stripe_customer_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			orgId,
			orgId,
			input.plan ?? 'free',
			input.stripePlan ?? null,
			input.stripeCustomerId ?? null,
			iso,
			iso,
		)
		.run()
	for (const member of input.members) {
		await env.APP_DB.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
			.bind(orgId, member.userId, member.role, iso)
			.run()
	}
	return orgId
}

/** Owner with a Stripe-paid Pro source org and a Free target org. */
async function seedMove(input: {
	interval: 'month' | 'year'
	stripe: ReturnType<typeof createFakeStripe>
	targetCustomer?: boolean
	targetSubscription?: 'month' | 'year'
	targetMembers?: number
}) {
	await ensureSchema()
	const ownerId = await seedUser('owner')
	const sourceCustomer = `cus_source_${uniqueSuffix()}`
	const sourceOrgId = await seedOrg({
		label: 'source',
		stripePlan: 'pro',
		stripeCustomerId: sourceCustomer,
		members: [{ userId: ownerId, role: 'owner' }],
	})
	const targetCustomer =
		input.targetCustomer || input.targetSubscription
			? `cus_target_${uniqueSuffix()}`
			: null
	const extraMembers: Array<{ userId: string; role: 'member' }> = []
	for (let index = 0; index < (input.targetMembers ?? 0); index++) {
		extraMembers.push({ userId: await seedUser('member'), role: 'member' })
	}
	const targetOrgId = await seedOrg({
		label: 'target',
		stripePlan: input.targetSubscription ? 'pro' : null,
		stripeCustomerId: targetCustomer,
		members: [{ userId: ownerId, role: 'owner' }, ...extraMembers],
	})
	const sourceSubscription = input.stripe.addProSubscription({
		customer: sourceCustomer,
		interval: input.interval,
	})
	const targetSubscription =
		input.targetSubscription && targetCustomer
			? input.stripe.addProSubscription({
					customer: targetCustomer,
					interval: input.targetSubscription,
					seats: 1 + extraMembers.length,
				})
			: null
	return {
		ownerId,
		sourceOrgId,
		targetOrgId,
		sourceCustomer,
		targetCustomer,
		sourceSubscription,
		targetSubscription,
	}
}

/** What Stripe and the checkout webhook do once the target pays. */
async function completeTargetCheckout(input: {
	stripe: ReturnType<typeof createFakeStripe>
	targetOrgId: string
	interval: 'month' | 'year'
	seats?: number
}) {
	const customer = `cus_target_paid_${uniqueSuffix()}`
	await env.APP_DB.prepare(
		`UPDATE orgs SET stripe_customer_id = ?, stripe_plan = 'pro' WHERE id = ?`,
	)
		.bind(customer, input.targetOrgId)
		.run()
	input.stripe.addProSubscription({
		customer,
		interval: input.interval,
		seats: input.seats,
		periodStart: nowSeconds,
	})
	return customer
}

test('monthly Pro moves to a Free org through Checkout and credits unused time', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe, targetMembers: 1 })
	const preview = await previewPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		now,
	})
	expect(preview.ok).toBe(true)
	if (!preview.ok) return
	// 20 of 30 days left on a $12 month.
	expect(preview.preview.credit).toEqual({ amountMinor: 800, currency: 'usd' })
	expect(preview.preview.source.interval).toBe('month')
	expect(preview.preview.target).toMatchObject({
		mode: 'checkout',
		interval: 'month',
		seats: 2,
		pricePerSeatMinor: 1_200,
		dueTodayMinor: 2_400,
		recurringMinor: 2_400,
	})
	expect(preview.preview.freeOrgsAfter).toEqual({ owned: 1, max: 2 })
	expect(preview.preview.freeLimits.length).toBeGreaterThan(0)
	expect(stripe.requests('POST', '/v1/').length).toBe(0)
	expect(stripe.requests('DELETE', '/v1/').length).toBe(0)

	const transferId = crypto.randomUUID()
	const started = await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: 'owner@example.com',
		transferId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'month',
		origin: 'https://kody.test',
		now,
	})
	expect(started.ok).toBe(true)
	if (!started.ok) return
	expect(started.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.mock\//)
	expect(started.transfer.status).toBe('pending_checkout')
	const session = stripe.checkoutSessions[0]!
	expect(session.form).toMatchObject({
		'line_items[0][price]': 'price_pro',
		'line_items[0][quantity]': '2',
		'metadata[kody_plan_transfer_id]': transferId,
		'metadata[kody_org_id]': seeded.targetOrgId,
		expires_at: String(nowSeconds + 3600),
	})
	// Nothing on the source changes until the target has paid.
	expect(stripe.requests('DELETE', '/v1/subscriptions').length).toBe(0)
	expect(stripe.creditNotes.length).toBe(0)

	const targetCustomer = await completeTargetCheckout({
		stripe,
		targetOrgId: seeded.targetOrgId,
		interval: 'month',
		seats: 2,
	})
	const finished = await advancePlanTransferForCheckoutSession({
		env: testEnv(),
		sessionId: session.id,
		transferId,
		now,
	})
	expect(finished).toMatchObject({
		status: 'completed',
		credit_amount_minor: 800,
		currency: 'usd',
	})
	expect(seeded.sourceSubscription.status).toBe('canceled')
	expect(stripe.creditNotes).toHaveLength(1)
	expect(stripe.creditNotes[0]!.form).toMatchObject({
		out_of_band_amount: '800',
		'metadata[kody_plan_transfer_id]': transferId,
	})
	expect(stripe.creditNotes[0]!.form.refund_amount).toBeUndefined()
	const audits = await auditDb()
		.prepare(
			`SELECT org_id, action FROM org_audit_events WHERE resource_id = ? ORDER BY created_at, rowid`,
		)
		.bind(transferId)
		.all<{ org_id: string; action: string }>()
	expect(audits.results.map((row) => row.action)).toEqual([
		'billing_plan_transfer_started',
		'billing_plan_transfer_started',
		'billing_plan_transfer_completed',
		'billing_plan_transfer_completed',
	])
	expect(stripe.balanceTransactions).toEqual([
		expect.objectContaining({
			customer: targetCustomer,
			amount: -800,
			currency: 'usd',
			metadata: expect.objectContaining({
				kody_plan_transfer_id: transferId,
				kody_org_id: seeded.targetOrgId,
			}),
		}),
	])
})

test('annual Pro moves onto an existing annual Pro target immediately', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({
		interval: 'year',
		stripe,
		targetSubscription: 'year',
	})
	const preview = await previewPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		now,
	})
	expect(preview.ok).toBe(true)
	if (!preview.ok) return
	// 265 of 365 days left on $120.
	const expected = Math.floor((12_000 * 265) / 365)
	expect(preview.preview.credit.amountMinor).toBe(expected)
	expect(preview.preview.target).toMatchObject({
		mode: 'existing_subscription',
		interval: 'year',
		dueTodayMinor: 0,
		recurringMinor: 12_000,
	})

	const transferId = crypto.randomUUID()
	const started = await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: null,
		transferId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'month',
		origin: 'https://kody.test',
		now,
	})
	expect(started.ok).toBe(true)
	if (!started.ok) return
	expect(started.checkoutUrl).toBeUndefined()
	expect(started.transfer).toMatchObject({
		status: 'completed',
		target_interval: 'year',
		credit_amount_minor: expected,
	})
	expect(stripe.checkoutSessions).toHaveLength(0)
	expect(seeded.sourceSubscription.status).toBe('canceled')
	expect(seeded.targetSubscription?.status).toBe('active')
	expect(stripe.balanceTransactions).toEqual([
		expect.objectContaining({
			customer: seeded.targetCustomer,
			amount: -expected,
		}),
	])
})

test('both orgs must be owned by the actor; billing admins and members are refused', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe })
	const billingAdmin = await seedUser('billing')
	await env.APP_DB.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, 'billing', ?), (?, ?, 'owner', ?)`,
	)
		.bind(
			seeded.sourceOrgId,
			billingAdmin,
			now.toISOString(),
			seeded.targetOrgId,
			billingAdmin,
			now.toISOString(),
		)
		.run()
	const notSourceOwner = await previewPlanTransfer({
		env: testEnv(),
		actorUserId: billingAdmin,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		now,
	})
	expect(notSourceOwner).toMatchObject({
		ok: false,
		reason: 'not_owner_source',
	})

	const member = await seedUser('member')
	await env.APP_DB.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, 'owner', ?), (?, ?, 'member', ?)`,
	)
		.bind(
			seeded.sourceOrgId,
			member,
			now.toISOString(),
			seeded.targetOrgId,
			member,
			now.toISOString(),
		)
		.run()
	const notTargetOwner = await startPlanTransfer({
		env: testEnv(),
		actorUserId: member,
		actorEmail: null,
		transferId: crypto.randomUUID(),
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'month',
		origin: 'https://kody.test',
		now,
	})
	expect(notTargetOwner).toMatchObject({
		ok: false,
		reason: 'not_owner_target',
	})
	const sameOrg = await previewPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.sourceOrgId,
		now,
	})
	expect(sameOrg).toMatchObject({ ok: false, reason: 'same_org' })
	expect(stripe.requests('POST', '/v1/').length).toBe(0)
})

test('refuses a move that would leave an owner with a third Free org', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({
		interval: 'month',
		stripe,
		targetSubscription: 'month',
	})
	await seedOrg({
		label: 'free-a',
		members: [{ userId: seeded.ownerId, role: 'owner' }],
	})
	await seedOrg({
		label: 'free-b',
		members: [{ userId: seeded.ownerId, role: 'owner' }],
	})
	const result = await previewPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		now,
	})
	expect(result).toMatchObject({ ok: false, reason: 'free_org_limit' })
	expect(result.ok ? '' : result.message).not.toMatch(/\u2014/)
})

test('a co-owner of the source at the Free cap also blocks the move', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({
		interval: 'month',
		stripe,
		targetSubscription: 'month',
	})
	const coOwner = await seedUser('co-owner')
	await env.APP_DB.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, 'owner', ?)`,
	)
		.bind(seeded.sourceOrgId, coOwner, now.toISOString())
		.run()
	for (const label of ['co-free-a', 'co-free-b']) {
		await seedOrg({ label, members: [{ userId: coOwner, role: 'owner' }] })
	}
	const result = await previewPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		now,
	})
	expect(result).toMatchObject({ ok: false, reason: 'free_org_limit' })
})

test('the Free target the owner is upgrading does not count against the cap', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe })
	await seedOrg({
		label: 'free-other',
		members: [{ userId: seeded.ownerId, role: 'owner' }],
	})
	const result = await previewPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		now,
	})
	expect(result.ok).toBe(true)
	if (!result.ok) return
	expect(result.preview.freeOrgsAfter).toEqual({ owned: 2, max: 2 })
})

test('repeated confirmations are idempotent and a second move is refused', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe })
	const transferId = crypto.randomUUID()
	const start = (id: string) =>
		startPlanTransfer({
			env: testEnv(),
			actorUserId: seeded.ownerId,
			actorEmail: null,
			transferId: id,
			sourceOrgId: seeded.sourceOrgId,
			targetOrgId: seeded.targetOrgId,
			targetInterval: 'month',
			origin: 'https://kody.test',
			now,
		})
	const first = await start(transferId)
	const again = await start(transferId)
	expect(first.ok && again.ok).toBe(true)
	if (!first.ok || !again.ok) return
	expect(again.transfer.id).toBe(first.transfer.id)
	expect(stripe.checkoutSessions).toHaveLength(1)
	const other = await start(crypto.randomUUID())
	expect(other).toMatchObject({ ok: false, reason: 'transfer_in_progress' })
})

test('concurrent starts for the same source create only one transfer', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({
		interval: 'month',
		stripe,
		targetSubscription: 'month',
	})
	const results = await Promise.all(
		[crypto.randomUUID(), crypto.randomUUID()].map((transferId) =>
			startPlanTransfer({
				env: testEnv(),
				actorUserId: seeded.ownerId,
				actorEmail: null,
				transferId,
				sourceOrgId: seeded.sourceOrgId,
				targetOrgId: seeded.targetOrgId,
				targetInterval: 'month',
				origin: 'https://kody.test',
				now,
			}),
		),
	)
	expect(results.filter((result) => result.ok)).toHaveLength(1)
	expect(results.find((result) => !result.ok)).toMatchObject({
		reason: 'transfer_in_progress',
	})
	expect(stripe.creditNotes).toHaveLength(1)
	expect(stripe.balanceTransactions).toHaveLength(1)
})

test('concurrent webhook and success-page advances apply the credit once', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe })
	const transferId = crypto.randomUUID()
	await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: null,
		transferId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'month',
		origin: 'https://kody.test',
		now,
	})
	await completeTargetCheckout({
		stripe,
		targetOrgId: seeded.targetOrgId,
		interval: 'month',
	})
	const sessionId = stripe.checkoutSessions[0]!.id
	await Promise.all([
		advancePlanTransferForCheckoutSession({
			env: testEnv(),
			sessionId,
			transferId,
			now,
		}),
		advancePlanTransferForCheckoutSession({ env: testEnv(), sessionId, now }),
	])
	// A replayed webhook after completion is a no-op.
	await advancePlanTransferForCheckoutSession({
		env: testEnv(),
		sessionId,
		transferId,
		now,
	})
	expect(await readPlanTransfer(env.APP_DB, transferId)).toMatchObject({
		status: 'completed',
	})
	expect(stripe.creditNotes).toHaveLength(1)
	expect(stripe.balanceTransactions).toHaveLength(1)
	expect(stripe.requests('DELETE', '/v1/subscriptions')).toHaveLength(1)
})

test('a checkout session that is not the transfer’s is ignored', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe })
	const transferId = crypto.randomUUID()
	await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: null,
		transferId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'month',
		origin: 'https://kody.test',
		now,
	})
	const result = await advancePlanTransferForCheckoutSession({
		env: testEnv(),
		sessionId: 'cs_someone_else',
		transferId,
		now,
	})
	expect(result).toBeNull()
	expect(await readPlanTransfer(env.APP_DB, transferId)).toMatchObject({
		status: 'pending_checkout',
	})
})

test('a webhook before the target has paid leaves the transfer waiting', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe })
	const transferId = crypto.randomUUID()
	await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: null,
		transferId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'month',
		origin: 'https://kody.test',
		now,
	})
	const row = await advancePlanTransfer({ env: testEnv(), transferId, now })
	expect(row).toMatchObject({ status: 'pending_checkout' })
	expect(seeded.sourceSubscription.status).toBe('active')
	expect(stripe.creditNotes).toHaveLength(0)
})

test('an abandoned checkout expires and the source keeps Pro', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe })
	const transferId = crypto.randomUUID()
	await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: null,
		transferId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'year',
		origin: 'https://kody.test',
		now,
	})
	const later = new Date(now.valueOf() + 2 * 60 * 60 * 1000)
	const row = await resumeOpenPlanTransferForOrg({
		env: testEnv(),
		orgId: seeded.sourceOrgId,
		now: later,
	})
	expect(row).toMatchObject({
		status: 'canceled',
		last_error_code: 'checkout_expired',
	})
	expect(seeded.sourceSubscription.status).toBe('active')
	expect(stripe.creditNotes).toHaveLength(0)
})

test('a Stripe failure after the credit note resumes without a second note', async () => {
	using stripe = createFakeStripe()
	consoleError.mockImplementation(() => {})
	const seeded = await seedMove({
		interval: 'year',
		stripe,
		targetSubscription: 'year',
	})
	stripe.failNext('balance')
	const transferId = crypto.randomUUID()
	const started = await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: null,
		transferId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'year',
		origin: 'https://kody.test',
		now,
	})
	expect(started.ok).toBe(true)
	if (!started.ok) return
	expect(started.transfer).toMatchObject({ status: 'needs_retry' })
	expect(started.transfer.last_error_code).toMatch(/^stripe_500/)
	expect(started.transfer.source_credit_note_id).toBeTruthy()
	expect(started.transfer.source_canceled_at).toBeTruthy()
	expect(stripe.balanceTransactions).toHaveLength(0)

	// Past the point of no return: owners cannot cancel, only finish.
	const cancel = await cancelPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		transferId,
		now,
	})
	expect(cancel.ok).toBe(false)

	const resumed = await resumeOpenPlanTransferForOrg({
		env: testEnv(),
		orgId: seeded.targetOrgId,
		now,
	})
	expect(resumed).toMatchObject({ status: 'completed', last_error_code: null })
	expect(stripe.creditNotes).toHaveLength(1)
	expect(stripe.balanceTransactions).toHaveLength(1)
	expect(consoleError).toHaveBeenCalledWith(
		'billing_plan_transfer_step_failed',
		expect.objectContaining({ transferId }),
	)
	expect(stripe.balanceTransactions[0]!.amount).toBe(
		-(started.transfer.credit_amount_minor ?? 0),
	)
})

test('a failed source cancel is retried and does not reissue the credit note', async () => {
	using stripe = createFakeStripe()
	consoleError.mockImplementation(() => {})
	const seeded = await seedMove({
		interval: 'month',
		stripe,
		targetSubscription: 'month',
	})
	stripe.failNext('cancel')
	const transferId = crypto.randomUUID()
	const started = await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: null,
		transferId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'month',
		origin: 'https://kody.test',
		now,
	})
	expect(started.ok && started.transfer.status).toBe('needs_retry')
	expect(seeded.sourceSubscription.status).toBe('active')
	const retried = await advancePlanTransfer({
		env: testEnv(),
		transferId,
		now,
	})
	expect(retried).toMatchObject({ status: 'completed' })
	expect(seeded.sourceSubscription.status).toBe('canceled')
	expect(stripe.creditNotes).toHaveLength(1)
})

test('an owner can cancel before the point of no return', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe })
	const transferId = crypto.randomUUID()
	await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: null,
		transferId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'month',
		origin: 'https://kody.test',
		now,
	})
	const outsider = await seedUser('outsider')
	expect(
		await cancelPlanTransfer({
			env: testEnv(),
			actorUserId: outsider,
			transferId,
			now,
		}),
	).toMatchObject({ ok: false })
	const canceled = await cancelPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		transferId,
		now,
	})
	expect(canceled).toMatchObject({
		ok: true,
		transfer: { status: 'canceled' },
	})
	// A late checkout webhook for a canceled transfer changes nothing.
	await completeTargetCheckout({
		stripe,
		targetOrgId: seeded.targetOrgId,
		interval: 'month',
	})
	await advancePlanTransferForCheckoutSession({
		env: testEnv(),
		sessionId: stripe.checkoutSessions[0]!.id,
		transferId,
		now,
	})
	expect(seeded.sourceSubscription.status).toBe('active')
	expect(stripe.creditNotes).toHaveLength(0)
})

test('targets whose Stripe customer has non-Kody subscriptions are refused', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({
		interval: 'month',
		stripe,
		targetCustomer: true,
	})
	stripe.addProSubscription({
		customer: seeded.targetCustomer ?? '',
		interval: 'month',
		priceId: 'price_someone_elses_product',
	})
	const result = await previewPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		now,
	})
	expect(result).toMatchObject({ ok: false, reason: 'target_customer_shared' })
})

test('a currency mismatch with the target subscription is refused', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({ interval: 'month', stripe })
	const targetCustomer = `cus_eur_${uniqueSuffix()}`
	await env.APP_DB.prepare(
		`UPDATE orgs SET stripe_customer_id = ?, stripe_plan = 'pro' WHERE id = ?`,
	)
		.bind(targetCustomer, seeded.targetOrgId)
		.run()
	stripe.addProSubscription({
		customer: targetCustomer,
		interval: 'month',
		currency: 'eur',
	})
	const result = await previewPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		now,
	})
	expect(result).toMatchObject({ ok: false, reason: 'currency_mismatch' })
})

test('retired-price, canceling and manual plans are not movable', async () => {
	using stripe = createFakeStripe()
	await ensureSchema()
	const ownerId = await seedUser('owner')
	const target = await seedOrg({
		label: 'target',
		members: [{ userId: ownerId, role: 'owner' }],
	})
	const preview = (sourceOrgId: string) =>
		previewPlanTransfer({
			env: testEnv(),
			actorUserId: ownerId,
			sourceOrgId,
			targetOrgId: target,
			now,
		})

	const retiredCustomer = `cus_retired_${uniqueSuffix()}`
	const retired = await seedOrg({
		label: 'retired',
		stripePlan: 'pro',
		stripeCustomerId: retiredCustomer,
		members: [{ userId: ownerId, role: 'owner' }],
	})
	stripe.addProSubscription({
		customer: retiredCustomer,
		interval: 'month',
		priceId: 'price_pro_legacy',
		metadata: { kody_plan: 'pro' },
	})
	expect(await preview(retired)).toMatchObject({
		ok: false,
		reason: 'source_not_stripe_pro',
	})

	const cancelingCustomer = `cus_canceling_${uniqueSuffix()}`
	const canceling = await seedOrg({
		label: 'canceling',
		stripePlan: 'pro',
		stripeCustomerId: cancelingCustomer,
		members: [{ userId: ownerId, role: 'owner' }],
	})
	stripe.addProSubscription({
		customer: cancelingCustomer,
		interval: 'year',
	}).cancel_at = nowSeconds + day
	expect(await preview(canceling)).toMatchObject({
		ok: false,
		reason: 'source_canceling',
	})

	const manual = await seedOrg({
		label: 'manual',
		plan: 'pro',
		members: [{ userId: ownerId, role: 'owner' }],
	})
	expect(await preview(manual)).toMatchObject({
		ok: false,
		reason: 'source_manual_plan',
	})
	expect(stripe.requests('POST', '/v1/').length).toBe(0)
})

test('moving a plan leaves source data and credentials in place', async () => {
	using stripe = createFakeStripe()
	const seeded = await seedMove({
		interval: 'month',
		stripe,
		targetSubscription: 'month',
	})
	const iso = now.toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO credential_mappings (
			id, org_id, package_id, need_key, target, credential_ids_json, created_at, updated_at
		) VALUES (?, ?, 'pkg-1', 'github', 'org', '["cred-1"]', ?, ?)`,
	)
		.bind(`map-${uniqueSuffix()}`, seeded.sourceOrgId, iso, iso)
		.run()
	const before = await env.APP_DB.prepare(
		`SELECT org_id, credential_ids_json FROM credential_mappings WHERE org_id IN (?, ?)`,
	)
		.bind(seeded.sourceOrgId, seeded.targetOrgId)
		.all()
	const started = await startPlanTransfer({
		env: testEnv(),
		actorUserId: seeded.ownerId,
		actorEmail: null,
		transferId: crypto.randomUUID(),
		sourceOrgId: seeded.sourceOrgId,
		targetOrgId: seeded.targetOrgId,
		targetInterval: 'month',
		origin: 'https://kody.test',
		now,
	})
	expect(started.ok && started.transfer.status).toBe('completed')
	const after = await env.APP_DB.prepare(
		`SELECT org_id, credential_ids_json FROM credential_mappings WHERE org_id IN (?, ?)`,
	)
		.bind(seeded.sourceOrgId, seeded.targetOrgId)
		.all()
	expect(after.results).toEqual(before.results)
	const memberships = await env.APP_DB.prepare(
		`SELECT org_id, role FROM org_memberships WHERE org_id = ? AND deleted_at IS NULL`,
	)
		.bind(seeded.sourceOrgId)
		.all()
	expect(memberships.results).toEqual([
		{ org_id: seeded.sourceOrgId, role: 'owner' },
	])
	const source = await env.APP_DB.prepare(
		`SELECT deleted_at, deleting_at FROM orgs WHERE id = ?`,
	)
		.bind(seeded.sourceOrgId)
		.first()
	expect(source).toEqual({ deleted_at: null, deleting_at: null })
})
