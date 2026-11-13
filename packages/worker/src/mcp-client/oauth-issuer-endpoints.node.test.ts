import { expect, test } from 'vitest'
import {
	assertCallbackIssuerMatchesDiscovery,
	assertEndpointsOnIssuerOrigin,
	assertIssuerMatchesAuthorizationServerUrl,
	assertTrustedMcpOAuthDiscovery,
	McpOAuthFailedError,
	mcpOAuthFailedCode,
} from './oauth-issuer-endpoints.ts'

function discovery(overrides: Record<string, unknown> = {}) {
	return {
		authorizationServerUrl: 'https://auth.example',
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
			...overrides,
		},
	}
}

function issuerDiscovery(
	issuer: string,
	endpoints: { authorize: string; token: string },
	authorizationServerUrl = issuer,
) {
	return {
		authorizationServerUrl,
		authorizationServerMetadata: {
			issuer,
			authorization_endpoint: endpoints.authorize,
			token_endpoint: endpoints.token,
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
		},
	}
}

const offSite = (field: string) =>
	new RegExp(
		`${mcpOAuthFailedCode}[\\s\\S]*${field} .*not on its issuer's origin or registrable domain`,
	)

test('assertEndpointsOnIssuerOrigin accepts same-origin authorize and token endpoints', () => {
	expect(() => assertEndpointsOnIssuerOrigin(discovery())).not.toThrow()
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			issuerDiscovery('https://auth.example:8443/tenant', {
				authorize: 'https://auth.example:8443/authorize',
				token: 'https://auth.example:8443/token',
			}),
		),
	).not.toThrow()
	expect(() =>
		assertEndpointsOnIssuerOrigin({
			authorizationServerMetadata: undefined,
		}),
	).not.toThrow()
	expect(() => assertEndpointsOnIssuerOrigin({})).not.toThrow()
})

test('assertTrustedMcpOAuthDiscovery accepts sibling hosts on one registrable domain', () => {
	const shapes = [
		issuerDiscovery('https://mcp.us5.example.com/v1/mcp', {
			authorize: 'https://us5.example.com/oauth2/authorize',
			token: 'https://us5.example.com/oauth2/token',
		}),
		issuerDiscovery(
			'https://mcp.example.com',
			{
				authorize: 'https://example.com/oauth/authorize',
				token: 'https://example.com/api/oauth/token',
			},
			'https://mcp.example.com/',
		),
		issuerDiscovery(
			'https://api.example.com',
			{
				authorize: 'https://www.example.com/oauth',
				token: 'https://api.example.com/oauth/token',
			},
			'https://api.example.com/',
		),
	]
	for (const fixture of shapes) {
		expect(() => assertEndpointsOnIssuerOrigin(fixture)).not.toThrow()
		expect(() => assertTrustedMcpOAuthDiscovery(fixture)).not.toThrow()
	}
})

test('assertEndpointsOnIssuerOrigin accepts the issuer host being the registrable domain itself', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			issuerDiscovery('https://slack.com', {
				authorize: 'https://mcp.slack.com/authorize',
				token: 'https://api.slack.com/token',
			}),
		),
	).not.toThrow()
})

test('assertEndpointsOnIssuerOrigin refuses metadata that omits issuer', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin({
			authorizationServerMetadata: {
				authorization_endpoint: 'https://evil.example/authorize',
				token_endpoint: 'https://evil.example/token',
			},
		}),
	).toThrow(/missing a usable issuer/)
})

test('assertEndpointsOnIssuerOrigin refuses http issuer or endpoints, even on the issuer site', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({
				issuer: 'http://auth.example',
				authorization_endpoint: 'http://auth.example/authorize',
				token_endpoint: 'http://auth.example/token',
			}),
		),
	).toThrow(/must use https/)
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({ token_endpoint: 'http://auth.example/token' }),
		),
	).toThrow(offSite('token_endpoint'))
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			issuerDiscovery('https://mcp.example.com', {
				authorize: 'http://example.com/oauth/authorize',
				token: 'https://example.com/api/oauth/token',
			}),
		),
	).toThrow(offSite('authorization_endpoint'))
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			issuerDiscovery('https://mcp.example.com', {
				authorize: 'https://example.com/oauth/authorize',
				token: 'http://example.com/api/oauth/token',
			}),
		),
	).toThrow(offSite('token_endpoint'))
})

for (const [field, endpoint] of [
	['authorization_endpoint', 'https://evil.example/authorize'],
	['token_endpoint', 'https://evil.example/token'],
] as const) {
	test(`assertEndpointsOnIssuerOrigin refuses a cross-site ${field}`, () => {
		expect(() =>
			assertEndpointsOnIssuerOrigin(discovery({ [field]: endpoint })),
		).toThrow(McpOAuthFailedError)
		expect(() =>
			assertEndpointsOnIssuerOrigin(discovery({ [field]: endpoint })),
		).toThrow(offSite(field))
		const sibling = issuerDiscovery('https://mcp.example.com', {
			authorize: 'https://example.com/oauth/authorize',
			token: 'https://example.com/api/oauth/token',
		})
		expect(() =>
			assertEndpointsOnIssuerOrigin({
				...sibling,
				authorizationServerMetadata: {
					...sibling.authorizationServerMetadata,
					[field]: endpoint,
				},
			}),
		).toThrow(offSite(field))
	})
}

test('assertEndpointsOnIssuerOrigin refuses lookalike and cross-domain hosts', () => {
	for (const endpoint of [
		'https://slack.com.evil.example/authorize',
		'https://evilslack.com/authorize',
		'https://slack.co/authorize',
	]) {
		expect(() =>
			assertEndpointsOnIssuerOrigin(
				issuerDiscovery('https://mcp.slack.com', {
					authorize: endpoint,
					token: 'https://slack.com/api/oauth.v2.user.access',
				}),
			),
		).toThrow(offSite('authorization_endpoint'))
	}
	// Google-style split across registrable domains stays refused.
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			issuerDiscovery('https://accounts.google.com', {
				authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
				token: 'https://oauth2.googleapis.com/token',
			}),
		),
	).toThrow(offSite('token_endpoint'))
})

test('assertEndpointsOnIssuerOrigin refuses sibling tenants on private Public Suffix List domains', () => {
	for (const suffix of [
		'github.io',
		'workers.dev',
		'pages.dev',
		'vercel.app',
		'herokuapp.com',
		'netlify.app',
		'supabase.co',
	]) {
		for (const field of ['authorization_endpoint', 'token_endpoint'] as const) {
			expect(() =>
				assertEndpointsOnIssuerOrigin(
					discovery({
						issuer: `https://a.${suffix}`,
						authorization_endpoint: `https://a.${suffix}/authorize`,
						token_endpoint: `https://a.${suffix}/token`,
						[field]: `https://b.${suffix}/${field}`,
					}),
				),
			).toThrow(offSite(field))
		}
		// The bare suffix has no registrable domain either.
		expect(() =>
			assertEndpointsOnIssuerOrigin(
				discovery({
					issuer: `https://a.${suffix}`,
					authorization_endpoint: `https://${suffix}/authorize`,
					token_endpoint: `https://a.${suffix}/token`,
				}),
			),
		).toThrow(offSite('authorization_endpoint'))
	}
	// Same tenant, sibling host: one registrable domain.
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({
				issuer: 'https://mcp.a.workers.dev',
				authorization_endpoint: 'https://auth.a.workers.dev/authorize',
				token_endpoint: 'https://a.workers.dev/token',
			}),
		),
	).not.toThrow()
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({
				issuer: 'https://a.b.s3.amazonaws.com',
				authorization_endpoint: 'https://a.c.s3.amazonaws.com/authorize',
				token_endpoint: 'https://a.b.s3.amazonaws.com/token',
			}),
		),
	).toThrow(offSite('authorization_endpoint'))
})

test('assertEndpointsOnIssuerOrigin requires the exact origin for IPs, localhost and public suffixes', () => {
	const cases: Array<[string, string]> = [
		['https://127.0.0.1', 'https://127.0.0.1:8443/authorize'],
		['https://10.0.0.1', 'https://10.0.0.2/authorize'],
		['https://[::1]', 'https://[::1]:8443/authorize'],
		['https://localhost', 'https://localhost:8443/authorize'],
		['https://localhost', 'https://127.0.0.1/authorize'],
		['https://127.0.0.1', 'https://localhost/authorize'],
		['https://co.uk', 'https://a.co.uk/authorize'],
		['https://a.co.uk', 'https://co.uk/authorize'],
		['https://github.io', 'https://github.io:8443/authorize'],
	]
	for (const [issuer, authorize] of cases) {
		expect(() =>
			assertEndpointsOnIssuerOrigin(
				issuerDiscovery(issuer, { authorize, token: `${issuer}/token` }),
			),
		).toThrow(offSite('authorization_endpoint'))
	}
	for (const issuer of [
		'https://127.0.0.1:8443',
		'https://[::1]',
		'https://localhost',
	]) {
		expect(() =>
			assertEndpointsOnIssuerOrigin(
				issuerDiscovery(issuer, {
					authorize: `${issuer}/authorize`,
					token: `${issuer}/token`,
				}),
			),
		).not.toThrow()
	}
})

test('assertEndpointsOnIssuerOrigin refuses an unparseable endpoint URL', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({ authorization_endpoint: 'not a url' }),
		),
	).toThrow(offSite('authorization_endpoint'))
})

test('assertEndpointsOnIssuerOrigin skips registration_endpoint', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({
				registration_endpoint: 'https://evil.example/register',
			}),
		),
	).not.toThrow()
})

test('assertIssuerMatchesAuthorizationServerUrl requires the issuer to echo the discovery URL (RFC 8414 §3.3)', () => {
	expect(() =>
		assertIssuerMatchesAuthorizationServerUrl(discovery()),
	).not.toThrow()
	// Trailing slash and URL spelling are tolerated, like the SDK's issuersMatch.
	for (const [issuer, serverUrl] of [
		['https://auth.example', 'https://auth.example/'],
		['https://auth.example/', 'https://auth.example'],
		['https://auth.example/tenant', 'https://auth.example/tenant/'],
		['https://AUTH.example:443/tenant', 'https://auth.example/tenant'],
	] as const) {
		expect(() =>
			assertIssuerMatchesAuthorizationServerUrl(
				issuerDiscovery(
					issuer,
					{ authorize: `${issuer}/a`, token: `${issuer}/t` },
					serverUrl,
				),
			),
		).not.toThrow()
	}
	for (const [issuer, serverUrl] of [
		['https://other.example', 'https://auth.example'],
		['https://auth.example', 'https://auth.example/tenant'],
		['https://auth.example/tenant', 'https://auth.example'],
		['https://auth.example/tenant-a', 'https://auth.example/tenant-b'],
		['https://mcp.slack.com', 'https://slack.com'],
		['https://auth.example:8443', 'https://auth.example'],
		['http://auth.example', 'https://auth.example'],
	] as const) {
		expect(() =>
			assertIssuerMatchesAuthorizationServerUrl(
				issuerDiscovery(
					issuer,
					{ authorize: `${issuer}/a`, token: `${issuer}/t` },
					serverUrl,
				),
			),
		).toThrow(
			new RegExp(
				`${mcpOAuthFailedCode}[\\s\\S]*issuer .*does not match the discovered authorization server`,
			),
		)
	}
})

test('assertIssuerMatchesAuthorizationServerUrl fails closed on missing issuer or discovery URL', () => {
	expect(() => assertIssuerMatchesAuthorizationServerUrl({})).not.toThrow()
	expect(() =>
		assertIssuerMatchesAuthorizationServerUrl({
			authorizationServerUrl: 'https://auth.example',
			authorizationServerMetadata: {},
		}),
	).toThrow(/missing a usable issuer/)
	expect(() =>
		assertIssuerMatchesAuthorizationServerUrl({
			authorizationServerMetadata: discovery().authorizationServerMetadata,
		}),
	).toThrow(McpOAuthFailedError)
	expect(() =>
		assertIssuerMatchesAuthorizationServerUrl({
			authorizationServerMetadata: discovery().authorizationServerMetadata,
		}),
	).toThrow(/missing the URL its metadata was fetched for/)
})

test('assertTrustedMcpOAuthDiscovery runs both checks', () => {
	expect(() => assertTrustedMcpOAuthDiscovery(discovery())).not.toThrow()
	expect(() =>
		assertTrustedMcpOAuthDiscovery(
			discovery({ token_endpoint: 'https://evil.example/token' }),
		),
	).toThrow(offSite('token_endpoint'))
	expect(() =>
		assertTrustedMcpOAuthDiscovery({
			...issuerDiscovery('https://mcp.example.com', {
				authorize: 'https://example.com/oauth/authorize',
				token: 'https://example.com/api/oauth/token',
			}),
			authorizationServerUrl: 'https://evil.example/',
		}),
	).toThrow(/does not match the discovered authorization server/)
})

test('callback iss: matching issuer passes, trailing slash tolerated', () => {
	expect(() =>
		assertCallbackIssuerMatchesDiscovery({
			discovery: discovery(),
			iss: 'https://auth.example/',
		}),
	).not.toThrow()
})

test('callback iss: a different authorization server is refused', () => {
	expect(() =>
		assertCallbackIssuerMatchesDiscovery({
			discovery: discovery(),
			iss: 'https://attacker.example',
		}),
	).toThrow(McpOAuthFailedError)
	expect(() =>
		assertCallbackIssuerMatchesDiscovery({ discovery: discovery(), iss: '' }),
	).toThrow(/does not match/)
})

test('callback iss: required only when the metadata advertises it', () => {
	expect(() =>
		assertCallbackIssuerMatchesDiscovery({ discovery: discovery(), iss: null }),
	).not.toThrow()
	expect(() =>
		assertCallbackIssuerMatchesDiscovery({
			discovery: discovery({
				authorization_response_iss_parameter_supported: true,
			}),
			iss: null,
		}),
	).toThrow(new RegExp(`^${mcpOAuthFailedCode}: .*missing the iss`))
})

test('callback iss: no stored issuer means nothing to compare', () => {
	expect(() =>
		assertCallbackIssuerMatchesDiscovery({
			discovery: null,
			iss: 'https://auth.example',
		}),
	).not.toThrow()
})
