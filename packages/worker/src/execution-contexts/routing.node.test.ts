import { expect, test } from 'vitest'
import { ecpDefaultGrant } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { runChainShapeError } from './chain-rules.ts'
import {
	codeNeedsCredentials,
	describeCloudFallback,
	grantRefusal,
	markQueuedAttemptExpired,
	markQueuedAttemptRan,
	planTargets,
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

test('a grant refuses runs it cannot serve', () => {
	expect(
		grantRefusal({
			grant: ecpDefaultGrant,
			requires: ['fs'],
			credentials: null,
		}),
	).toBe('no_fs')
	expect(
		grantRefusal({
			grant: ecpDefaultGrant,
			requires: ['lan'],
			credentials: null,
		}),
	).toBe('no_lan')
	expect(
		grantRefusal({
			grant: ecpDefaultGrant,
			requires: [],
			credentials: new Map([['github', [{ name: 'gh', scope: null }]]]),
		}),
	).toBe('credentials_not_allowed')
	expect(
		grantRefusal({ grant: ecpDefaultGrant, requires: [], credentials: null }),
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

test('a grant that allows no credentials refuses code that needs one', () => {
	const code =
		"import { credentials } from 'kody:runtime'\nexport default () => credentials('example')"
	expect(
		grantRefusal({
			grant: ecpDefaultGrant,
			requires: [],
			credentials: null,
			code,
		}),
	).toBe('credentials_not_allowed')
	expect(
		grantRefusal({
			grant: {
				...ecpDefaultGrant,
				credentials: { mode: 'list', ids: ['cred_1'] },
			},
			requires: [],
			credentials: null,
			code,
		}),
	).toBeNull()
	expect(
		grantRefusal({
			grant: ecpDefaultGrant,
			requires: [],
			credentials: null,
			code: 'export default () => 1',
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
		'Ran on Kody cloud: no execution context in your chain took this run (build-box (ec_box): rejected grant_mismatch; ec_gone: skipped gone).',
	)
})
