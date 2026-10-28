import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	ExecutionContextsUnavailableError,
	normalizeAuditEvent,
	normalizeContext,
	normalizeRun,
	parseChain,
	readCapabilityFailure,
	readExecutionContextFailure,
} from './execution-contexts.ts'

test('parseChain keeps cloud last and marks stored unusable entries', () => {
	const chain = parseChain({
		entries: [
			{ kind: 'cloud' },
			{ kind: 'context', id: 'ec_a', usable: false, unusableReason: 'revoked' },
			{ kind: 'context', id: 'ec_b', usable: true },
		],
		updatedAt: '2026-01-02T03:04:05.000Z',
	})
	expect(chain.entries).toEqual([
		{ kind: 'context', id: 'ec_a', usable: false, unusableReason: 'revoked' },
		{ kind: 'context', id: 'ec_b', usable: true },
		{ kind: 'cloud' },
	])
	expect(chain.updatedAt).toBe('2026-01-02T03:04:05.000Z')
})

test('parseChain defaults to cloud only when the chain is missing', () => {
	expect(parseChain(undefined).entries).toEqual([{ kind: 'cloud' }])
})

test('readExecutionContextFailure maps chain_changed with the current chain', () => {
	const failure = readExecutionContextFailure({
		status: 409,
		error: 'chain_changed',
		message: 'Chain changed.',
		details: {
			current: { entries: [{ kind: 'context', id: 'ec_a', usable: true }] },
		},
	})
	expect(failure).toMatchObject({
		ok: false,
		error: 'chain_changed',
		status: 409,
		current: {
			entries: [{ kind: 'context', id: 'ec_a', usable: true }],
		},
	})
})

test('readExecutionContextFailure keeps contextId for context_not_usable', () => {
	expect(
		readExecutionContextFailure({
			error: 'context_not_usable',
			message: 'Not usable.',
			contextId: 'ec_b',
		}),
	).toEqual({
		ok: false,
		error: 'context_not_usable',
		message: 'Not usable.',
		contextId: 'ec_b',
	})
})

test('readExecutionContextFailure reads nested error codes', () => {
	expect(
		readExecutionContextFailure({
			message: 'Your login is too old.',
			body: { error: { code: 'credential_scope' } },
		}),
	).toMatchObject({ ok: false, error: 'credential_scope' })
})

test('an unavailable registry reads as feature_disabled, not denied', () => {
	expect(
		readExecutionContextFailure(new ExecutionContextsUnavailableError()),
	).toMatchObject({ ok: false, error: 'feature_disabled' })
	expect(readExecutionContextFailure(new Error('plain'))).toBeNull()
})

test('normalizeContext fills deleted handles and slugs and parses sharing', () => {
	const context = normalizeContext({
		id: 'ec_a',
		name: 'buildbox',
		ownerOrg: { id: 'org_1', slug: null },
		operator: { handle: null },
		client: { name: null, version: null },
		sharing: {
			level: 'team',
			allMembers: false,
			grants: [
				{
					grantId: 'g_1',
					subject: { kind: 'team', slug: 'build', name: 'Build' },
					preset: null,
				},
				{
					grantId: 'g_2',
					subject: { kind: 'user', handle: null, outside: true },
					preset: 'manage',
				},
			],
			attachedOrgs: [],
		},
	})
	expect(context?.ownerOrg).toEqual({ id: 'org_1', slug: '' })
	expect(context?.operator.handle).toBe('deleted user')
	expect(context?.client).toBeNull()
	expect(context?.sharing?.grants).toEqual([
		{
			grantId: 'g_1',
			subject: { kind: 'team', slug: 'build', name: 'Build' },
			preset: 'use',
		},
		{
			grantId: 'g_2',
			subject: { kind: 'user', handle: 'deleted user', outside: true },
			preset: 'manage',
		},
	])
})

test('normalizeRun and normalizeAuditEvent read the session DO row shapes', () => {
	expect(
		normalizeRun({
			runId: 'run_1',
			requester: { userId: 'u_1', handle: null },
			runOrgId: 'org_1',
			dispatchedAt: '2026-01-02T03:04:05.000Z',
			startedAt: null,
			endedAt: null,
			durationMs: null,
			outcome: null,
			cancelReason: null,
			fallback: { position: 1, ranOn: 'cloud' },
		}),
	).toMatchObject({
		requester: { userId: 'u_1', handle: 'deleted user' },
		outcome: null,
		fallback: { position: 1, ranOn: 'cloud' },
	})
	expect(
		normalizeAuditEvent({
			id: 7,
			at: '2026-01-02T03:04:05.000Z',
			event: 'share_added',
			actor: { userId: 'u_1', handle: 'jane' },
			orgId: 'org_1',
			detail: { grantId: 'g_1' },
		}),
	).toEqual({
		id: '7',
		action: 'share_added',
		actor: { label: 'jane' },
		at: '2026-01-02T03:04:05.000Z',
		detail: '{"grantId":"g_1"}',
	})
})

test('readCapabilityFailure turns caller errors into a shown message', () => {
	expect(
		readCapabilityFailure(new McpCallerError('No user named "nobody".')),
	).toEqual({
		ok: false,
		error: 'invalid_input',
		message: 'No user named "nobody".',
	})
	expect(readCapabilityFailure(new Error('boom'))).toBeNull()
})

test('readExecutionContextFailure drops the code suffix from shown messages', () => {
	const error = Object.assign(
		new Error('The audit log is for the operator. (not_granted)'),
		{ code: 'not_granted' },
	)
	expect(readExecutionContextFailure(error)).toMatchObject({
		error: 'not_granted',
		message: 'The audit log is for the operator.',
	})
})
