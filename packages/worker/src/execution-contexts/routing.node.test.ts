import { expect, test } from 'vitest'
import { ecpDefaultGrant } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { runChainShapeError } from './chain-rules.ts'
import { codeNeedsCredentials } from './run-credential-use.ts'
import {
	credentialRefusal,
	describeCloudFallback,
	describeRanOn,
	historyRanOn,
	ranOnFromMetadata,
	grantRefusal,
	markQueuedAttemptExpired,
	markQueuedAttemptRan,
	planTargets,
	withRunTiming,
} from './routing.ts'
import { type ExecutionContextRow } from './store.ts'

const a = { kind: 'context', id: 'ec_a' } as const
const b = { kind: 'context', id: 'ec_b' } as const
const cloud = { kind: 'cloud' } as const
const named = { id: 'ec_b', name: 'build-box' } as ExecutionContextRow

test('an unnamed run walks the chain in order and ends on cloud', () => {
	expect(
		planTargets({
			named: null,
			fallback: undefined,
			chain: [a, b, cloud],
			strict: false,
			requires: [],
		}),
	).toEqual([a, b, cloud])
})

test('a strict chain never falls back to cloud', () => {
	expect(
		planTargets({
			named: null,
			fallback: undefined,
			chain: [a],
			strict: true,
			requires: [],
		}),
	).toEqual([a])
})

test('requires removes cloud', () => {
	expect(
		planTargets({
			named: null,
			fallback: undefined,
			chain: [a, cloud],
			strict: false,
			requires: ['fs'],
		}),
	).toEqual([a])
	expect(
		planTargets({
			named: 'cloud',
			fallback: undefined,
			chain: [],
			strict: false,
			requires: ['lan'],
		}),
	).toEqual([])
})

test('a named context never falls back unless fallback is chain', () => {
	expect(
		planTargets({
			named,
			fallback: undefined,
			chain: [a, cloud],
			strict: false,
			requires: [],
		}),
	).toEqual([b])
	expect(
		planTargets({
			named,
			fallback: 'chain',
			chain: [a, b, cloud],
			strict: false,
			requires: [],
		}),
	).toEqual([b, a, cloud])
})

test('context: cloud runs on cloud only', () => {
	expect(
		planTargets({
			named: 'cloud',
			fallback: undefined,
			chain: [a, cloud],
			strict: false,
			requires: [],
		}),
	).toEqual([cloud])
})

const none = { kind: 'none' } as const
const unknown = { kind: 'unknown' } as const

test('requires fs needs both a server grant folder and an advertised local mount', () => {
	const grant = {
		...ecpDefaultGrant,
		fs: [{ path: '/Users/k/Desktop', mode: 'rw' as const }],
	}
	expect(
		grantRefusal({
			grant,
			requires: ['fs'],
			credentials: { mode: 'none' },
			credentialUse: none,
			capabilities: {},
		}),
	).toBe('no_local_fs')
	expect(
		grantRefusal({
			grant,
			requires: ['fs'],
			credentials: { mode: 'none' },
			credentialUse: none,
			capabilities: { features: ['fs'] },
		}),
	).toBeNull()
	expect(
		grantRefusal({
			grant: ecpDefaultGrant,
			requires: ['fs'],
			credentials: { mode: 'none' },
			credentialUse: none,
			capabilities: { features: ['fs'] },
		}),
	).toBe('no_fs')
})

test('a grant refuses runs it cannot serve', () => {
	expect(
		grantRefusal({
			capabilities: {},
			grant: ecpDefaultGrant,
			requires: ['fs'],
			credentials: { mode: 'none' },
			credentialUse: none,
		}),
	).toBe('no_fs')
	expect(
		grantRefusal({
			capabilities: {},
			grant: ecpDefaultGrant,
			requires: ['lan'],
			credentials: { mode: 'none' },
			credentialUse: none,
		}),
	).toBe('no_lan')
	expect(
		grantRefusal({
			capabilities: {},
			grant: ecpDefaultGrant,
			requires: [],
			credentials: { mode: 'none' },
			credentialUse: { kind: 'ids', ids: ['cred_gh'] },
		}),
	).toBe('credentials_not_allowed')
	expect(
		grantRefusal({
			grant: ecpDefaultGrant,
			requires: [],
			credentials: { mode: 'none' },
			credentialUse: none,
			capabilities: {},
		}),
	).toBeNull()
})

// Built at runtime so no literal placeholder sits in the source.
const placeholder = (inner: string) =>
	`${'{'.repeat(2)}${inner}${'}'.repeat(2)}`

test('execute code that needs a credential is detected before it runs', () => {
	expect(codeNeedsCredentials(null)).toBe(false)
	expect(
		codeNeedsCredentials(
			"import { kody } from 'kody:runtime'\nexport default () => kody.metaGetCurrentUser({})",
		),
	).toBe(false)
	expect(
		codeNeedsCredentials(
			`export default () => fetch('https://api.example.com', { headers: { authorization: 'Bearer ${placeholder('secret:example-token')}' } })`,
		),
	).toBe(true)
	expect(
		codeNeedsCredentials(
			`export default () => fetch('https://api.example.com', { headers: { authorization: '${placeholder('integration-token:example')}' } })`,
		),
	).toBe(true)
	expect(
		codeNeedsCredentials(
			"import { credential } from 'kody:runtime'\nexport default async () => (await credential('example')).fetch('/')",
		),
	).toBe(true)
	expect(
		codeNeedsCredentials(
			'import { kody, createAuthenticatedFetch as authFetch } from "kody:runtime"\nexport default () => authFetch',
		),
	).toBe(true)
	expect(
		codeNeedsCredentials(
			"import runtime from 'kody:runtime'\nexport default () => runtime.credentials('example')",
		),
	).toBe(true)
	expect(
		codeNeedsCredentials(
			"import * as rt from 'kody:runtime'\nexport default () => rt.kody.metaGetCurrentUser({})",
		),
	).toBe(false)
})

test('a grant that allows no credentials refuses a run that can use one', () => {
	expect(credentialRefusal({ mode: 'none' }, unknown)).toBe(
		'credentials_not_allowed',
	)
	expect(credentialRefusal({ mode: 'none' }, none)).toBeNull()
})

test('an explicit list must cover every credential the run can use', () => {
	const list = { mode: 'list' as const, ids: ['cred_1', 'cred_2'] }
	expect(credentialRefusal(list, none)).toBeNull()
	expect(credentialRefusal(list, { kind: 'ids', ids: ['cred_1'] })).toBeNull()
	expect(
		credentialRefusal(list, { kind: 'ids', ids: ['cred_1', 'cred_3'] }),
	).toBe('credentials_not_in_grant')
	// Which credentials an imported package uses is not statically known.
	expect(credentialRefusal(list, unknown)).toBe('credentials_unverified')
})

test('a requester grant serves any credential use only while unshared', () => {
	expect(credentialRefusal({ mode: 'requester' }, unknown)).toBeNull()
	expect(
		credentialRefusal({ mode: 'requester' }, { kind: 'ids', ids: ['c'] }),
	).toBeNull()
	expect(credentialRefusal({ mode: 'requester_shared' }, unknown)).toBe(
		'credentials_need_unshared_context',
	)
	expect(credentialRefusal({ mode: 'requester_shared' }, none)).toBeNull()
})

test('a run chain follows the default chain shape rules', () => {
	expect(runChainShapeError(['laptop', 'cloud'])).toBeNull()
	expect(runChainShapeError(['laptop'])).toBeNull()
	expect(runChainShapeError(['cloud', 'laptop'])?.code).toBe('invalid_request')
	expect(runChainShapeError(['a', 'a'])?.code).toBe('invalid_request')
	expect(runChainShapeError(['a', 'b', 'c', 'd'])?.code).toBe('chain_too_long')
	expect(runChainShapeError(['a', 'b', 'c', 'cloud'])).toBeNull()
	expect(runChainShapeError([])?.code).toBe('invalid_request')
})

test('an expired queued run records its queued attempt as expired', () => {
	const metadata = {
		trigger: 'job',
		executionContext: {
			id: 'ec_1',
			name: 'laptop',
			attempts: [
				{ target: 'ec_2', name: 'desk', outcome: 'offline' },
				{ target: 'ec_1', name: 'laptop', outcome: 'queued' },
			],
			fellBackToCloud: false,
		},
	}
	expect(markQueuedAttemptExpired(metadata)).toEqual({
		trigger: 'job',
		executionContext: {
			...metadata.executionContext,
			attempts: [
				{ target: 'ec_2', name: 'desk', outcome: 'offline' },
				{
					target: 'ec_1',
					name: 'laptop',
					outcome: 'expired',
					reason: 'queue_expired',
				},
			],
		},
	})
	expect(markQueuedAttemptExpired({ trigger: 'job' })).toEqual({
		trigger: 'job',
	})
})

test('a queued run the context took records its queued attempt as ran', () => {
	const metadata = {
		executionContext: {
			id: 'ec_1',
			name: 'laptop',
			attempts: [{ target: 'ec_1', name: 'laptop', outcome: 'queued' }],
			fellBackToCloud: false,
		},
	}
	expect(markQueuedAttemptRan(metadata)).toEqual({
		executionContext: {
			...metadata.executionContext,
			attempts: [{ target: 'ec_1', name: 'laptop', outcome: 'ran' }],
		},
	})
})

test('a finished context run keeps its timing on the run record', () => {
	const timing = {
		queueMs: 1,
		setupMs: 20,
		executeMs: 3,
		daemonMs: 24,
		serverMs: 40,
		transitMs: 16,
	}
	const metadata = {
		executionContext: { id: 'ec_1', name: 'laptop', attempts: [] },
	}
	expect(withRunTiming(metadata, timing)).toEqual({
		executionContext: { ...metadata.executionContext, timing },
	})
	expect(withRunTiming({}, timing)).toEqual({})
})

test('a cloud fallback says which contexts passed on the run and why', () => {
	expect(
		describeCloudFallback({
			id: 'ec_box',
			name: 'build-box',
			fellBackToCloud: true,
			attempts: [
				{
					target: 'ec_box',
					name: 'build-box',
					outcome: 'rejected',
					reason: 'grant_mismatch',
				},
				{ target: 'ec_gone', outcome: 'skipped', reason: 'gone' },
			],
		}),
	).toBe(
		'Ran on Kody cloud after build-box declined it (grant mismatch) and a context that no longer exists was skipped.',
	)
})

test('describeRanOn names where a run happened with friendly names only', () => {
	expect(describeRanOn(ranOnFromMetadata(null))).toBe('Ran on Kody cloud.')
	expect(
		describeRanOn(
			ranOnFromMetadata({
				id: 'ec_box',
				name: 'build-box',
				yours: true,
				fellBackToCloud: false,
				attempts: [{ target: 'ec_box', name: 'build-box', outcome: 'ran' }],
			}),
		),
	).toBe('Ran on build-box (your machine).')
	expect(
		describeRanOn(
			ranOnFromMetadata({
				id: 'ec_team',
				name: 'team-box',
				yours: false,
				fellBackToCloud: false,
				attempts: [
					{ target: 'ec_box', name: 'build-box', outcome: 'busy' },
					{ target: 'ec_team', name: 'team-box', outcome: 'ran' },
				],
			}),
			{ running: true },
		),
	).toBe('Running on team-box (an execution context) after build-box was busy.')
	expect(
		describeRanOn(
			ranOnFromMetadata({
				id: null,
				name: null,
				fellBackToCloud: true,
				attempts: [
					{
						target: 'ec_box',
						name: 'build-box',
						outcome: 'skipped',
						reason: 'credentials_not_allowed',
					},
				],
			}),
		),
	).toBe(
		'Ran on Kody cloud after build-box was skipped (credentials not allowed).',
	)
	expect(
		describeRanOn(
			ranOnFromMetadata({
				id: 'ec_box',
				name: 'build-box',
				yours: true,
				fellBackToCloud: false,
				attempts: [{ target: 'ec_box', name: 'build-box', outcome: 'queued' }],
			}),
		),
	).toBe('Waiting for build-box (your machine) to take this run.')
	expect(ranOnFromMetadata({ id: 'ec_box', name: 'build-box' })).toEqual({
		kind: 'context',
		id: 'ec_box',
		name: 'build-box',
		attempts: [],
		fellBackToCloud: false,
	})
})

test('a missing chain ref that is a raw context id never reaches the text', () => {
	expect(
		describeRanOn(
			ranOnFromMetadata({
				id: 'cloud',
				name: 'Kody cloud',
				fellBackToCloud: true,
				attempts: [
					{
						target: 'ec_missing1',
						name: 'ec_missing1',
						outcome: 'skipped',
						reason: 'not_found',
					},
					{ target: 'unknown-box', name: 'old-box', outcome: 'skipped' },
					{ target: 'cloud', name: 'Kody cloud', outcome: 'ran' },
				],
			}),
		),
	).toBe(
		'Ran on Kody cloud after an execution context was skipped (not found) and old-box was skipped.',
	)
})

test('run history reports no ranOn for a queued run that expired unrun', () => {
	const expired = {
		id: 'ec_queue1',
		name: 'build-box',
		fellBackToCloud: false,
		attempts: [{ target: 'ec_queue1', name: 'build-box', outcome: 'expired' }],
	}
	expect(historyRanOn(expired)).toBeNull()
	expect(
		historyRanOn({
			...expired,
			attempts: [{ target: 'ec_queue1', name: 'build-box', outcome: 'ran' }],
		}),
	).toMatchObject({ kind: 'context', id: 'ec_queue1', name: 'build-box' })
})

test('a queued run that revocation ended unrun has no ranOn in history', () => {
	const metadata = markQueuedAttemptExpired(
		{
			executionContext: {
				id: 'ec_queue1',
				name: 'build-box',
				fellBackToCloud: false,
				attempts: [
					{ target: 'ec_queue1', name: 'build-box', outcome: 'queued' },
				],
			},
		},
		'context_revoked',
	)
	expect(metadata.executionContext).toMatchObject({
		attempts: [{ outcome: 'expired', reason: 'context_revoked' }],
	})
	expect(historyRanOn(metadata.executionContext)).toBeNull()
})

test('ranOn carries the timing a context reported, and cloud never does', () => {
	const timing = {
		queueMs: 1,
		setupMs: 20,
		packageGraphMs: 0,
		packageGraphCached: true,
		executeMs: 3,
		daemonMs: 24,
		serverMs: 40,
		transitMs: 16,
	}
	expect(
		ranOnFromMetadata({
			id: 'ec_box',
			name: 'build-box',
			fellBackToCloud: false,
			attempts: [{ target: 'ec_box', name: 'build-box', outcome: 'ran' }],
			timing,
		}),
	).toMatchObject({ kind: 'context', id: 'ec_box', timing })
	expect(
		ranOnFromMetadata({
			id: 'ec_box',
			name: 'build-box',
			fellBackToCloud: true,
			attempts: [{ target: 'ec_box', name: 'build-box', outcome: 'busy' }],
			timing,
		}),
	).not.toHaveProperty('timing')
})
