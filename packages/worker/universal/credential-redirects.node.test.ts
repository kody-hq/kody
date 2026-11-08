import { expect, test } from 'vitest'
import { parseCredentialCreateQuery } from './credential-contracts.ts'
import { credentialRedirectFor } from './credential-redirects.ts'

const redirect = (path: string) =>
	credentialRedirectFor(new URL(path, 'https://kody.test'))

test('old org index pages go to the Credentials list filtered by kind, except the Integrations catalog', () => {
	expect(redirect('/@acme/-/secrets')).toBe('/@acme/-/credentials?kind=secret')
	expect(redirect('/@acme/-/secrets/')).toBe('/@acme/-/credentials?kind=secret')
	expect(redirect('/@acme/-/mcp-servers?url=https%3A%2F%2Fmcp.test')).toBe(
		'/@acme/-/credentials?url=https%3A%2F%2Fmcp.test&kind=mcp',
	)
	expect(redirect('/@acme/-/secrets?scope=package&q=x')).toBe(
		'/@acme/-/credentials?q=x&kind=secret&packageScoped=true',
	)
	expect(redirect('/@acme/-/secrets?scope=user')).toBe(
		'/@acme/-/credentials?kind=secret&scope=org&packageScoped=false',
	)
	expect(redirect('/@acme/-/secrets?kind=oauth&q=x')).toBe(
		'/@acme/-/credentials?kind=secret&q=x',
	)
	expect(redirect('/@jane%2Bold/-/secrets')).toBe(
		'/@jane%2Bold/-/credentials?kind=secret',
	)
	expect(redirect('/@acme/-/secret-providers')).toBeNull()
	expect(redirect('/@acme/-/integrations')).toBeNull()
	expect(redirect('/@acme/-/integrations?q=git')).toBeNull()
	expect(redirect('/@acme/-/integrations/github')).toBeNull()
	expect(redirect('/@acme/-/mcp-servers/srv-1/authorize')).toBeNull()
	expect(redirect('/@acme/-/credentials')).toBeNull()
})

test('/connect/secret-set opens the Key form with the same prefill', () => {
	const open = (search: string) => {
		const location = redirect(`/connect/secret-set${search}`)
		const url = new URL(location!, 'https://kody.test')
		expect(url.pathname).toBe('/connect/credential')
		return { url, query: parseCredentialCreateQuery(url.searchParams) }
	}
	const locked = open(
		'?name=stripe&allowed-host=api.stripe.com&allowedHosts=uploads.stripe.com&package=pkg-1&package_id=pkg-3&allowedPackages=pkg-2&scope=user&kind=oauth&description=Billing&provider=stripe&expiresAt=2026-12-31',
	)
	expect(locked.url.searchParams.getAll('kind')).toEqual(['secret'])
	expect(locked.url.searchParams.has('package')).toBe(false)
	expect(locked.query).toMatchObject({
		kind: 'secret',
		name: 'stripe',
		description: 'Billing',
		provider: 'stripe',
		expiresAt: '2026-12-31',
		allowedHosts: ['api.stripe.com', 'uploads.stripe.com'],
		allowedPackages: ['pkg-1', 'pkg-3', 'pkg-2'],
		packageScopedTo: null,
		packageKodyId: null,
	})

	expect(
		open('?name=t&scope=package&packageId=pkg-1&package=pkg-2').query,
	).toMatchObject({ packageScopedTo: 'pkg-1', allowedPackages: [] })
	expect(open('?name=t&packageId=pkg-1').query).toMatchObject({
		packageScopedTo: 'pkg-1',
	})
	expect(open('?name=t&scope=package').query).toMatchObject({
		packageScopeMissingId: true,
	})
	expect(redirect('/connect/secret-set')).toBe(
		'/connect/credential?kind=secret',
	)
})
