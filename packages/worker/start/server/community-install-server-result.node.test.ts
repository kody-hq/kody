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

test('requireOperationResult refuses an already-unwrapped install payload (status string footgun)', () => {
	// The install *outcome* field is also named `status` (`'installed'`).
	// requireOperationResult must not treat that string as an HTTP code and
	// return undefined via `.data`. Community install does not use this
	// helper on the happy path; this guards other callers and mistaken wraps.
	expect(() => requireOperationResult(successPayload as never)).toThrow(
		'Unable to complete operation.',
	)
})

test('createServerFn-style result.result unwrap is undefined when the RPC envelope omits result', () => {
	// Start's client does `return result.result`. A lost/incomplete envelope
	// after a committed install leaves `result` unset → undefined — the
	// screenshot TypeError when the UI then reads `.ok`.
	const middlewareResult = {
		result: (undefined as { result?: unknown } | undefined)?.result,
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
