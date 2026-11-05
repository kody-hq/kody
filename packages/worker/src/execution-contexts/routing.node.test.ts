import { expect, test } from 'vitest'
import { ecpDefaultGrant } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { runChainShapeError } from './chain-rules.ts'
import {
	describeAttempts,
	describeCloudFallback,
	describeRanOn,
	historyRanOn,
	ranOnFromMetadata,
	grantRefusal,
	markQueuedAttemptExpired,
	markQueuedAttemptRan,
	planTargets,
	withRunTiming,
	sharedRunHostRefusal,
} from './routing.ts'
import type { ExecutionContextRow } from './store.ts'

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

test('requires fs needs both a server grant folder and an advertised local mount', () => {
	const grant = {
		...ecpDefaultGrant,
		fs: [{ path: '/Users/k/Desktop', mode: 'rw' as const }],
	}
	expect(
		grantRefusal({
			grant,
			requires: ['fs'],
			sharedRun: false,
			capabilities: {},
		}),
	).toBe('no_local_fs')
	expect(
		grantRefusal({
			grant,
			requires: ['fs'],
			sharedRun: false,
			capabilities: { features: ['fs'] },
		}),
	).toBeNull()
	expect(
		grantRefusal({
			grant: ecpDefaultGrant,
			requires: ['fs'],
			sharedRun: false,
			capabilities: { features: ['fs'] },
		}),
	).toBe('no_fs')
})

test('a grant refuses runs it cannot serve', () => {
	expect(
		grantRefusal({
			sharedRun: false,
			capabilities: {},
			grant: ecpDefaultGrant,
			requires: ['fs'],
		}),
	).toBe('no_fs')
	expect(
		grantRefusal({
			sharedRun: false,
			capabilities: {},
			grant: ecpDefaultGrant,
			requires: ['lan'],
		}),
	).toBe('no_lan')
	expect(
		grantRefusal({
			grant: ecpDefaultGrant,
			requires: [],
			sharedRun: false,
			capabilities: {},
		}),
	).toBeNull()
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
						reason: 'no_lan',
					},
				],
			}),
		),
	).toBe('Ran on Kody cloud after build-box was skipped (no lan).')
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

test('every credential kind needs execution_context:execute to reach a context', async () => {
	const { hasContextScope } = await import('./routing.ts')
	// CLI logins, API tokens and OAuth grants all carry scopes now; none of
	// them reach a context without the execution-context scope.
	expect(hasContextScope({ request: { scopes: ['org:execute'] } })).toBe(false)
	expect(
		hasContextScope({
			request: { scopes: ['org:execute', 'execution_context:execute'] },
		}),
	).toBe(true)
	// Unscoped credentials (a signed-in browser session) keep full access.
	expect(hasContextScope({ request: { scopes: null } })).toBe(true)
})

test('host folders stay with the operator: shared runs skip fs and outdated daemons with folders', () => {
	const withFs = {
		...ecpDefaultGrant,
		fs: [{ path: '/Users/k/Desktop', mode: 'rw' as const }],
	}
	const current = { features: ['host-operator-only', 'fs'] }
	expect(
		sharedRunHostRefusal({
			grant: withFs,
			requires: ['fs'],
			capabilities: current,
			sharedRun: false,
		}),
	).toBeNull()
	expect(
		sharedRunHostRefusal({
			grant: withFs,
			requires: ['fs'],
			capabilities: current,
			sharedRun: true,
		}),
	).toBe('fs_operator_only')
	expect(
		sharedRunHostRefusal({
			grant: withFs,
			requires: [],
			capabilities: { features: ['fs'] },
			sharedRun: true,
		}),
	).toBe('fs_daemon_outdated')
	// The queue drain on reconnect checks the same rule through grantRefusal.
	expect(
		grantRefusal({
			grant: withFs,
			requires: [],
			capabilities: { features: ['fs'] },
			sharedRun: true,
		}),
	).toBe('fs_daemon_outdated')
	expect(
		sharedRunHostRefusal({
			grant: withFs,
			requires: [],
			capabilities: current,
			sharedRun: true,
		}),
	).toBeNull()
	expect(
		sharedRunHostRefusal({
			grant: ecpDefaultGrant,
			requires: [],
			capabilities: {},
			sharedRun: true,
		}),
	).toBeNull()
})

test('fs and lan skips name the server grant layer and the command that turns it on', () => {
	const text = describeAttempts([
		{
			target: 'ec_box',
			name: 'wsl-box',
			outcome: 'skipped',
			reason: 'no_fs',
		},
		{
			target: 'ec_lan',
			name: 'lan-box',
			outcome: 'skipped',
			reason: 'no_lan',
		},
	])
	expect(text).toContain('grant.fs is off on the server')
	expect(text).toContain('kody context grant allow <folder> --context wsl-box')
	expect(text).toContain('grant.egress is not public-and-lan')
	expect(text).toContain('kody context grant lan on --context lan-box')
})
