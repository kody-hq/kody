import { z } from 'zod'

const text = z.string().nullish()
export const saveSecretSchema = z.object({
	currentId: text,
	name: z.string(),
	value: z.string(),
	scope: z.enum(['user', 'package']),
	packageId: text,
	description: text,
	expiresAt: text,
	allowedHosts: z.array(z.string()).default([]),
	allowedPackages: z.array(z.string()).default([]),
	provider: text,
	kind: text,
	hosts: z.array(z.string()).optional(),
	loginExchange: z.unknown().optional(),
})
export const deleteSecretSchema = z.object({ currentId: z.string() })
const oauthFields = {
	provider: z.string(),
	tokenUrl: text,
	apiBaseUrl: text,
	authorizeUrl: text,
	deviceAuthorizationUrl: text,
	flow: text,
	usePkce: z.boolean().nullish(),
	clientId: text,
	clientSecret: text,
	scopeSeparator: text,
	extraAuthorizeParams: z.record(z.string(), z.string()).default({}),
	tokenExchangeStyle: text,
}
export const saveOAuthAppSchema = z.object(oauthFields)
export const connectOAuthSchema = z.object({
	...oauthFields,
	platformAppSlug: text,
	allowedHosts: z.array(z.string()).default([]),
	scopes: z.array(z.string()).default([]),
	tokenPayload: z.record(z.string(), z.unknown()),
})
export const exchangeOAuthTokenSchema = z.object({
	params: z.string(),
	platformAppSlug: text,
	tokenUrl: text,
	flow: text,
	allowedHosts: z.array(z.string()).default([]),
	tokenExchangeStyle: text,
	provider: text,
	clientSecret: text,
})
export type SaveSecretInput = z.input<typeof saveSecretSchema>
export type SaveOAuthAppInput = z.input<typeof saveOAuthAppSchema>
export type ConnectOAuthInput = z.input<typeof connectOAuthSchema>
export type ExchangeOAuthTokenInput = z.input<typeof exchangeOAuthTokenSchema>
