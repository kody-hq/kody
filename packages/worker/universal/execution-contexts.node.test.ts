import { expect, test } from 'vitest'
import {
	type ExecutionChainEntry,
	type ExecutionContextListItem,
	chainIsFull,
	chainPosition,
	chainWarning,
	contextAccessCell,
	contextDisplayStatus,
	grantSummaryCell,
	insertBeforeCloud,
	moveChainContext,
	normalizeChain,
	ordinal,
	removeChainContext,
	reorderChainContexts,
	runFallbackLabel,
	sharingSummary,
	unutilizedNote,
	visibleContexts,
	withCloud,
	withoutCloud,
} from './execution-contexts.ts'

function context(
	overrides: Partial<ExecutionContextListItem> = {},
): ExecutionContextListItem {
	return {
		id: 'ec_a',
		name: 'alpha',
		ownerOrg: { id: 'org_1', slug: 'acme' },
		operator: { handle: 'sam' },
		isOperator: false,
		myPermissions: ['read', 'execute'],
		status: 'online',
		acceptingRuns: true,
		lastSeenAt: '2026-01-01T00:00:00.000Z',
		revokedAt: null,
		client: { name: '@kodycodes/cli', version: '1.0.0' },
		capabilities: { os: 'linux', maxConcurrent: 2, features: [] },
		grantSummary: {
			fs: 0,
			egress: { mode: 'public' },
			credentials: 'none',
			runtime: 'all',
			timeoutMs: 90_000,
		},
		optedIn: true,
		usable: true,
		chainUsage: { inMyChain: false, chainCount: 0 },
		...overrides,
	}
}

const a = { kind: 'context', id: 'ec_a', usable: true } as const
const b = { kind: 'context', id: 'ec_b', usable: true } as const
const c = { kind: 'context', id: 'ec_c', usable: false } as const
const cloud = { kind: 'cloud' } as const

test('cloud is always normalized to the end', () => {
	expect(normalizeChain<ExecutionChainEntry>([cloud, a, b])).toEqual([
		a,
		b,
		cloud,
	])
	expect(normalizeChain<ExecutionChainEntry>([a, b])).toEqual([a, b])
})

test('moving a context keeps cloud last and clamps at the ends', () => {
	expect(
		moveChainContext<ExecutionChainEntry>([a, b, cloud], 'ec_b', -1),
	).toEqual([b, a, cloud])
	expect(
		moveChainContext<ExecutionChainEntry>([a, b, cloud], 'ec_b', 1),
	).toEqual([a, b, cloud])
	expect(
		reorderChainContexts<ExecutionChainEntry>(
			[a, b, c, cloud],
			['ec_c', 'ec_a'],
		),
	).toEqual([c, a, b, cloud])
})

test('unusable stored entries count toward the three-context cap', () => {
	expect(chainIsFull([a, b, cloud])).toBe(false)
	expect(chainIsFull([a, b, c, cloud])).toBe(true)
})

test('insertBeforeCloud appends after the last context and never duplicates', () => {
	expect(
		insertBeforeCloud([{ kind: 'context', id: 'ec_a' }, cloud], 'ec_b'),
	).toEqual([
		{ kind: 'context', id: 'ec_a' },
		{ kind: 'context', id: 'ec_b' },
		cloud,
	])
	expect(insertBeforeCloud([{ kind: 'context', id: 'ec_a' }], 'ec_a')).toEqual([
		{ kind: 'context', id: 'ec_a' },
	])
})

test('cloud removal and re-adding', () => {
	expect(withoutCloud([a, cloud])).toEqual([a])
	expect(withCloud([cloud, { kind: 'context', id: 'ec_a' }])).toEqual([
		{ kind: 'context', id: 'ec_a' },
		cloud,
	])
	expect(
		removeChainContext<ExecutionChainEntry>([a, b, cloud], 'ec_a'),
	).toEqual([b, cloud])
	expect(chainPosition([a, b, cloud], 'ec_b')).toBe(2)
	expect(chainPosition([a, cloud], 'ec_x')).toBeNull()
})

test('chain warnings', () => {
	const offline = context({ id: 'ec_b', status: 'offline' })
	const busy = context({ id: 'ec_a', acceptingRuns: false })
	const byId = new Map([
		['ec_a', busy],
		['ec_b', offline],
	])
	expect(
		chainWarning({ chain: { entries: [cloud] }, contextsById: byId }),
	).toBe('cloud-only')
	expect(
		chainWarning({ chain: { entries: [a, cloud] }, contextsById: byId }),
	).toBe('none')
	expect(chainWarning({ chain: { entries: [c] }, contextsById: byId })).toBe(
		'strict-no-usable',
	)
	expect(chainWarning({ chain: { entries: [a, b] }, contextsById: byId })).toBe(
		'strict-none-accepting',
	)
	expect(
		chainWarning({
			chain: { entries: [a] },
			contextsById: new Map([['ec_a', context()]]),
		}),
	).toBe('none')
})

test('display status separates busy from online', () => {
	expect(contextDisplayStatus(context())).toBe('online')
	expect(contextDisplayStatus(context({ acceptingRuns: false }))).toBe('busy')
	expect(contextDisplayStatus(context({ status: 'offline' }))).toBe('offline')
	expect(contextDisplayStatus(context({ status: 'revoked' }))).toBe('revoked')
})

test('access cell', () => {
	expect(contextAccessCell(context(), { entries: [a, cloud] })).toEqual({
		kind: 'in-chain',
		position: 1,
	})
	expect(
		contextAccessCell(context({ isOperator: true }), { entries: [cloud] }),
	).toEqual({
		kind: 'yours',
	})
	expect(
		contextAccessCell(
			context({
				optedIn: false,
				canOptIn: true,
				usable: false,
				unusableReason: 'not_opted_in',
			}),
			{
				entries: [cloud],
			},
		),
	).toEqual({ kind: 'opt-in' })
	expect(
		contextAccessCell(
			context({ usable: false, unusableReason: 'not_attached' }),
			{
				entries: [cloud],
			},
		),
	).toEqual({ kind: 'not-usable' })
	expect(
		contextAccessCell(context({ optedIn: false, canOptIn: false }), {
			entries: [cloud],
		}),
	).toEqual({ kind: 'unavailable' })
})

test('labels', () => {
	expect(ordinal(1)).toBe('1st')
	expect(ordinal(2)).toBe('2nd')
	expect(ordinal(3)).toBe('3rd')
	expect(ordinal(11)).toBe('11th')
	expect(
		grantSummaryCell({
			fs: 2,
			egress: { mode: 'public-and-lan' },
			credentials: { count: 1 },
			runtime: { mode: 'allowlist', count: 3 },
			timeoutMs: 120_000,
		}),
	).toBe(
		'2 paths · public and LAN egress · 1 credential · Kody APIs: 3 allowed · 120 s',
	)
	expect(
		sharingSummary(
			{
				level: 'team',
				grants: [
					{
						grantId: 'g1',
						subject: { kind: 'user', handle: 'x' },
						preset: 'use',
					},
					{
						grantId: 'g2',
						subject: { kind: 'team', slug: 'build' },
						preset: 'use',
					},
				],
				attachedOrgs: [{ slug: 'other', allMembers: true }],
				allMembers: true,
			},
			'acme',
		),
	).toBe('1 person + Team build + Everyone in @acme + Everyone in @other')
	expect(
		sharingSummary(
			{ level: 'only_me', grants: [], attachedOrgs: [], allMembers: false },
			'acme',
		),
	).toBe('Only me')
	expect(sharingSummary(undefined, 'acme')).toBeNull()
})

test('unutilized note names up to three, then counts', () => {
	expect(unutilizedNote(null)).toBeNull()
	expect(unutilizedNote({ count: 0, note: '' })).toBeNull()
	expect(
		unutilizedNote({
			count: 2,
			contexts: [
				{ id: 'ec_1', name: 'alpha', needsOptIn: false },
				{ id: 'ec_2', name: 'beta', needsOptIn: true },
			],
			note: '',
		}),
	).toBe('Not in your chain yet: alpha, beta (needs opt-in).')
	expect(unutilizedNote({ count: 5, note: '' })).toBe(
		'There are 5 unutilized execution context registrations.',
	)
})

test('revoked rows stay visible for 30 days', () => {
	const now = Date.parse('2026-02-01T00:00:00.000Z')
	const recent = context({ id: 'r', revokedAt: '2026-01-20T00:00:00.000Z' })
	const old = context({ id: 'o', revokedAt: '2025-12-01T00:00:00.000Z' })
	expect(
		visibleContexts([recent, old, context()], now).map((x) => x.id),
	).toEqual(['r', 'ec_a'])
})

test('run fallback label', () => {
	const nameForId = (id: string) => (id === 'ec_b' ? 'buildbox' : undefined)
	const base = {
		runId: 'run_1',
		requester: { handle: 'sam' },
		dispatchedAt: '2026-01-01T00:00:00.000Z',
	}
	expect(
		runFallbackLabel({
			run: {
				...base,
				outcome: 'succeeded',
				fallback: { position: 1, ranOn: 'ec_a' },
			},
			contextId: 'ec_a',
			nameForId,
		}),
	).toBe('Ran here')
	expect(
		runFallbackLabel({
			run: {
				...base,
				outcome: 'busy',
				fallback: { position: 1, ranOn: 'cloud' },
			},
			contextId: 'ec_a',
			nameForId,
		}),
	).toBe('Skipped (busy), ran on Kody cloud')
	expect(
		runFallbackLabel({
			run: {
				...base,
				outcome: 'offline',
				fallback: { position: 1, ranOn: 'ec_b' },
			},
			contextId: 'ec_a',
			nameForId,
		}),
	).toBe('Skipped (offline), ran on buildbox')
})
