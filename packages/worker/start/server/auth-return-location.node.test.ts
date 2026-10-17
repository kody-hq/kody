import { expect, test } from 'vitest'
import { accountReturnLocation } from './auth-return-location.ts'
import { documentDestinationHeader } from '../session-identity.ts'

test.each([
	'/account/security?audit=return-target',
	'/account/data?view=export',
	'/account?notice=saved',
])(
	'keeps the document return target %s while account data is shared',
	(path) => {
		expect(
			accountReturnLocation(
				new Request(`https://kody.test${path}`),
				'/account',
			),
		).toBe(path)
	},
)
test('keeps a client navigation destination and its fragment', () => {
	const path = '/account/security?audit=return-target#sessions'
	expect(
		accountReturnLocation(
			new Request('https://kody.test/_serverFn/account', {
				headers: { [documentDestinationHeader]: path },
			}),
			'/account',
		),
	).toBe(path)
})
test.each([
	'https://evil.test/account',
	'//evil.test/account',
	'/\\evil.test/account',
	'/other',
	'/accounting',
])('never uses unsafe or unrelated client destinations %s', (destination) => {
	expect(
		accountReturnLocation(
			new Request('https://kody.test/_serverFn/account', {
				headers: { [documentDestinationHeader]: destination },
			}),
			'/account',
		),
	).toBe('/account')
})
test('a direct RPC does not become the login return target', () => {
	expect(
		accountReturnLocation(
			new Request('https://kody.test/_serverFn/account'),
			'/account',
		),
	).toBe('/account')
})
