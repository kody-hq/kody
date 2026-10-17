import { describe, expect, it } from 'vitest'
import { isRedirect } from '@tanstack/react-router'
import {
	documentActorHeader,
	documentDestinationHeader,
	verifyDocumentActor,
} from './session-identity.ts'

function verify(
	expected: string | undefined,
	actor: string | null,
	destination = '/account?tab=profile#name',
) {
	const headers = new Headers()
	if (expected !== undefined) {
		headers.set(documentActorHeader, expected)
		headers.set(documentDestinationHeader, destination)
	}
	return verifyDocumentActor({
		headers,
		actor,
		requestUrl: 'https://kody.example/_serverFn/read',
	})
}

describe('document-bound RPC identity', () => {
	it('allows the same actor and anonymous browser, plus unbound SSR/API requests', () => {
		expect(() => verify('"actor-a"', 'actor-a')).not.toThrow()
		expect(() => verify('null', null)).not.toThrow()
		expect(() => verify(undefined, 'actor-a')).not.toThrow()
	})
	it('redirects any mismatched actor before returning another account payload', () => {
		for (const [expected, actor] of [
			['"actor-a"', 'actor-b'],
			['"actor-a"', null],
			['null', 'actor-a'],
		] as const) {
			try {
				verify(expected, actor)
				throw new Error('Expected redirect')
			} catch (error) {
				expect(isRedirect(error)).toBe(true)
				if (!isRedirect(error)) throw error
				expect(error.options).toMatchObject({
					href: '/account?tab=profile#name',
					reloadDocument: true,
					replace: true,
				})
			}
		}
	})
	it('rejects malformed actor bindings and unsafe destinations', () => {
		for (const actor of ['undefined', '{}', '42', '""'])
			expect(() => verify(actor, null)).toThrow()
		for (const destination of [
			'',
			'//external.example',
			'/\\external.example',
			'https://external.example',
			'/bad\tpath',
		])
			expect(() => verify('"actor-a"', 'actor-b', destination)).toThrow()
	})
})
