import { expect, test } from 'vitest'
import { signupOrgCredentialCreateHref } from './connect-credential.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'

test('credential entry keeps requested organization and prefilled query', () => {
	const user = { username: 'jane', request: { org: { slug: 'acme' } } } as Pick<
		AuthenticatedAppUser,
		'username' | 'request'
	>
	expect(signupOrgCredentialCreateHref(user, '?kind=secret&name=KEY')).toBe(
		'/@acme/-/credentials/new?kind=secret&name=KEY',
	)
	expect(signupOrgCredentialCreateHref(user, '?org=team&kind=key')).toBe(
		'/@team/-/credentials/new?org=team&kind=key',
	)
})
