import { expect, test } from 'vitest'
import { requireOperationResult } from '#app/operation-result.ts'
import { unwrapCommunityInstallHandlerResult } from './community-install-server-result.ts'
import { readCommunityInstallResult } from '../community-install-result.ts'

const successPayload = {
	ok: true as const,
	status: 'installed' as const,
	packageId: 'pkg-1',
	targetName: '@nstudio/tanstack-github-dashboard',
	agentPrompt: 'Review then publish.',
	alreadyInstalled: false,
}

test('requireOperationResult on an already-unwrapped install payload used to return undefined (screenshot bug)', () => {
	// The install *outcome* field is also named `status` (`'installed'`).
	// Before the operation-result guard, requireOperationResult treated that
	// string as an HTTP code, returned `.data` (missing), and the serverFn
	// resolved to undefined after the fork had already succeeded.
	// It must now throw instead of returning undefined.
	expect(() => requireOperationResult(successPayload as never)).toThrow(
		'Unable to complete operation.',
	)
})

test('createServerFn-style result.result unwrap of a bare install payload is undefined', () => {
	// When the wire body is the payload (no `{ result, error, context }`
	// wrapper), Start's client `next(payload)` leaves `ctx.result` unset and
	// `return result.result` is undefined — same UI TypeError.
	const middlewareResult = {
		result: (successPayload as { result?: unknown }).result,
	}
	expect(middlewareResult.result).toBeUndefined()
})

test('unwrapCommunityInstallHandlerResult returns a defined POJO for a successful wrapper', () => {
	expect(
		unwrapCommunityInstallHandlerResult({
			data: successPayload,
			status: 200,
		}),
	).toEqual(successPayload)
})

test('unwrapCommunityInstallHandlerResult refuses an empty or already-unwrapped payload', () => {
	expect(() =>
		unwrapCommunityInstallHandlerResult(successPayload as never),
	).toThrow(/empty response/)
	expect(() => unwrapCommunityInstallHandlerResult(undefined)).toThrow(
		/empty response/,
	)
	expect(() =>
		unwrapCommunityInstallHandlerResult({
			data: undefined as never,
			status: 200,
		}),
	).toThrow(/empty response/)
})

test('unwrapCommunityInstallHandlerResult surfaces HTTP error bodies', () => {
	expect(() =>
		unwrapCommunityInstallHandlerResult({
			data: { ok: false, error: 'Catalog entry not found.' },
			status: 404,
		}),
	).toThrow('Catalog entry not found.')
})

test('readCommunityInstallResult turns an undefined serverFn resolution into a clear Error, not undefined.ok', () => {
	expect(() => readCommunityInstallResult(undefined)).toThrow(
		'Unable to install this public package.',
	)
	expect(() => readCommunityInstallResult(undefined)).not.toThrow(
		/reading 'ok'/,
	)
	expect(() => readCommunityInstallResult(successPayload)).not.toThrow()
})
