import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { capabilityProxyCredentialClientBinding } from '#worker/credentials/credential-client-handle.ts'
import { type ApiInvocationContext } from './context.ts'
import {
	parseCapabilityProxyOauthClientCredentialsArgs,
	runCapabilityProxyOauthClientCredentials,
} from './capability-proxy-oauth-client-credentials.ts'
import { ApiError } from './errors.ts'

const gatewayCalls = vi.hoisted(
	() => [] as Array<{ props: Record<string, unknown>; request: Request }>,
)

vi.mock('#mcp/fetch-gateway.ts', () => ({
	executeGatewayFetch: async (input: {
		props: Record<string, unknown>
		request: Request
	}) => {
		gatewayCalls.push(input)
		return Response.json({
			access_token: 'sealed-by-gateway',
			token_type: 'Bearer',
		})
	},
}))

function createContext(): ApiInvocationContext {
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.codes',
		executionOrigin: 'interactive',
		user: {
			userId: personIdFromStored('user-local'),
			email: 'caller@example.com',
			displayName: 'Caller',
		},
		storageContext: null,
		repoContext: null,
	})
	if (!callerContext.user) throw new Error('Caller context needs a user')
	return {
		env: { SECRET_STORE_KEY: 'test-secret-store-key' } as Env,
		callerContext: { ...callerContext, user: callerContext.user },
		principal: { kind: 'token' },
	} as unknown as ApiInvocationContext
}

test('--local oauthClientCredentials mints on the host gateway bound to the CapabilityProxy credential', async () => {
	const ctx = createContext()
	const result = await runCapabilityProxyOauthClientCredentials({
		ctx,
		args: [
			{
				tokenUrl: 'https://auth.example.com/oauth/token',
				clientIdSecret: 'exampleClientId',
				clientSecretSecret: 'exampleClientSecret',
			},
		],
	})
	expect(result).toEqual({
		access_token: 'sealed-by-gateway',
		token_type: 'Bearer',
	})
	expect(gatewayCalls).toHaveLength(1)
	const [call] = gatewayCalls
	expect(call?.request.url).toBe('https://auth.example.com/oauth/token')
	// The same binding local gatewayFetch sends, so the sealed token fills there.
	expect(call?.props.credentialClientBinding).toBe(
		capabilityProxyCredentialClientBinding(
			ctx.callerContext.request as NonNullable<
				ApiInvocationContext['callerContext']['request']
			>,
		),
	)
})

test('parseCapabilityProxyOauthClientCredentialsArgs accepts a valid grant and rejects missing secrets or non-basic auth', () => {
	expect(
		parseCapabilityProxyOauthClientCredentialsArgs([
			{
				tokenUrl: 'https://oauth.example.com/token',
				clientIdSecret: 'client-id',
				clientSecretSecret: 'client-secret',
				authStyle: 'basic',
				body: { audience: 'api' },
				packageId: 'pkg-1',
			},
		]),
	).toEqual({
		tokenUrl: 'https://oauth.example.com/token',
		clientIdSecret: 'client-id',
		clientSecretSecret: 'client-secret',
		authStyle: 'basic',
		body: { audience: 'api' },
		packageId: 'pkg-1',
	})
	expect(() =>
		parseCapabilityProxyOauthClientCredentialsArgs([
			{ tokenUrl: 'https://oauth.example.com/token', clientIdSecret: 'id' },
		]),
	).toThrow(ApiError)
	expect(() =>
		parseCapabilityProxyOauthClientCredentialsArgs([
			{
				tokenUrl: 'https://oauth.example.com/token',
				clientIdSecret: 'id',
				clientSecretSecret: 'secret',
				authStyle: 'post',
			},
		]),
	).toThrow(ApiError)
})
