import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { z } from 'zod'
import {
	connectionTroubleActors,
	integrationAuthFailureReasons,
} from '#universal/connection-trouble.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'

export const integrationFlowValues = ['pkce', 'confidential', 'device'] as const

/**
 * Integration identity is the canonical provider key (lowercase kebab via
 * normalizeProviderKey). Every read and write path derives names and value
 * keys through this one function, so lookups never depend on how a caller
 * cased or spaced the provider name.
 */
export function canonicalIntegrationName(name: string) {
	return normalizeProviderKey(name)
}

const integrationNameSchema = z
	.string()
	.min(1)
	.refine((name) => /[a-z0-9]/.test(canonicalIntegrationName(name)), {
		message: 'Integration name must contain letters or numbers.',
	})

const defaultIntegrationScopeSeparator = ' '

export const tokenExchangeStyleValues = [
	'form',
	'basic-json',
	'basic-form',
] as const

export const integrationAuthorizationSchema = z
	.object({
		authorizeUrl: z.string().url().refine(isHttpUrl, {
			message: 'Authorize URL must use http or https.',
		}),
		scopes: z.array(
			z
				.string()
				.min(1)
				.refine((scope) => scope.trim().length > 0, {
					message: 'Scope cannot be whitespace-only.',
				}),
		),
		scopeSeparator: z.string().min(1).optional().nullable(),
		extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
	})
	.strict()

export const integrationConfigSchema = z.object({
	name: integrationNameSchema,
	tokenUrl: z.string().url(),
	apiBaseUrl: z.string().url().optional().nullable(),
	flow: z.enum(integrationFlowValues),
	/**
	 * PKCE is orthogonal to `flow`. Absent means the flow default: PKCE on for
	 * `pkce` flow, off for `confidential`. Canva-style providers store
	 * `usePkce: true` with `confidential` flow. Device flow ignores PKCE.
	 */
	usePkce: z.boolean().optional().nullable(),
	clientId: z.string().min(1),
	requiredHosts: z.array(z.string()).optional(),
	tokenExchangeStyle: z.enum(tokenExchangeStyleValues).optional().nullable(),
	/**
	 * RFC 8628 device authorization endpoint. Required when `flow` is
	 * `device`; unused for authorization_code flows.
	 */
	deviceAuthorizationUrl: z
		.string()
		.url()
		.refine(isHttpUrl, {
			message: 'Device authorization URL must use http or https.',
		})
		.optional()
		.nullable(),
	authorization: integrationAuthorizationSchema.optional().nullable(),
	/**
	 * True when the connection uses a platform (built-in) OAuth app. The
	 * shared client secret lives encrypted on the platform app row and token
	 * exchange runs host-side (`integrationTokenRefresh`).
	 */
	platform: z.boolean().optional(),
	/**
	 * Omitted means `any` (execute plus every package). `packages` is only
	 * the listed saved package ids — execute is denied.
	 */
	usageMode: z.enum(['any', 'packages']).optional(),
	allowedPackageIds: z.array(z.string()).optional(),
	/** Stable credential id for accessGrant. Output-only; save ignores it. */
	credentialId: z.string().optional(),
	/** Last classified OAuth refresh outcome. Output-only; save ignores it. */
	lastAuthFailure: z
		.object({
			reason: z.enum(integrationAuthFailureReasons),
			occurredAt: z.string().min(1),
			reconnectable: z.boolean(),
			providerError: z.string().nullable(),
			providerErrorDescription: z.string().nullable(),
			httpStatus: z.number().int().nullable(),
			title: z.string(),
			why: z.string(),
			who: z.enum(connectionTroubleActors),
			doLabel: z.string(),
			reconnectHref: z.string(),
			accountHref: z.string(),
		})
		.optional(),
})

export type IntegrationConfig = z.infer<typeof integrationConfigSchema>
type IntegrationAuthorization = z.infer<typeof integrationAuthorizationSchema>

export const integrationSaveSchema = z
	.object({
		name: integrationNameSchema,
		tokenUrl: z.string().url().optional(),
		apiBaseUrl: z.string().url().nullable().optional(),
		flow: z.enum(integrationFlowValues).optional(),
		usePkce: z.boolean().nullable().optional(),
		clientId: z.string().min(1).optional(),
		requiredHosts: z.array(z.string()).optional(),
		tokenExchangeStyle: z.enum(tokenExchangeStyleValues).nullable().optional(),
		deviceAuthorizationUrl: z
			.string()
			.url()
			.refine(isHttpUrl, {
				message: 'Device authorization URL must use http or https.',
			})
			.nullable()
			.optional(),
		authorization: integrationAuthorizationSchema.nullable().optional(),
		accountLabel: z.string().min(1).nullable().optional(),
		logoBase64: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Base64-encoded OAuth app logo (SVG, PNG, JPEG, or WebP). Kody fits the image to 256px WebP before storage. Omit to keep the current logo, pass null to clear it and re-fetch the provider favicon.',
			),
	})
	.strict()

export type IntegrationSaveInput = z.infer<typeof integrationSaveSchema>

export function normalizeIntegrationConfig(
	value: IntegrationConfig,
): IntegrationConfig {
	const normalized = normalizeIntegrationConfigFields(value)
	return {
		...normalized,
		clientId: value.clientId.trim(),
	}
}

function normalizeIntegrationConfigFields(
	value: Pick<
		IntegrationConfig,
		| 'name'
		| 'tokenUrl'
		| 'apiBaseUrl'
		| 'flow'
		| 'usePkce'
		| 'requiredHosts'
		| 'tokenExchangeStyle'
		| 'deviceAuthorizationUrl'
		| 'authorization'
		| 'usageMode'
		| 'allowedPackageIds'
	>,
) {
	const authorization = value.authorization
		? normalizeIntegrationAuthorization(value.authorization)
		: null
	const tokenExchangeStyle = value.tokenExchangeStyle ?? null
	const deviceAuthorizationUrl = value.deviceAuthorizationUrl?.trim() || null
	// Store usePkce only when it differs from the flow default so existing
	// integration records keep their canonical shape. Device flow has no PKCE.
	const usePkce =
		value.flow === 'device'
			? null
			: typeof value.usePkce === 'boolean' &&
				  value.usePkce !== (value.flow === 'pkce')
				? value.usePkce
				: null
	return {
		name: canonicalIntegrationName(value.name),
		tokenUrl: value.tokenUrl.trim(),
		apiBaseUrl: value.apiBaseUrl?.trim() || null,
		flow: value.flow,
		...(usePkce == null ? {} : { usePkce }),
		requiredHosts: normalizeAllowedHosts(value.requiredHosts ?? []),
		...(tokenExchangeStyle ? { tokenExchangeStyle } : {}),
		...(deviceAuthorizationUrl ? { deviceAuthorizationUrl } : {}),
		...(authorization ? { authorization } : {}),
		...(value.usageMode === 'packages'
			? {
					usageMode: 'packages' as const,
					allowedPackageIds: Array.from(
						new Set(
							(value.allowedPackageIds ?? [])
								.map((id) => id.trim())
								.filter(Boolean),
						),
					).sort((left, right) => left.localeCompare(right)),
				}
			: {}),
	}
}

export function normalizeIntegrationAuthorization(
	value: IntegrationAuthorization,
): IntegrationAuthorization {
	const scopeSeparator =
		value.scopeSeparator == null ||
		value.scopeSeparator === defaultIntegrationScopeSeparator
			? null
			: value.scopeSeparator
	const extraAuthorizeParams: Record<string, string> = {}
	for (const [rawKey, paramValue] of Object.entries(
		value.extraAuthorizeParams ?? {},
	)) {
		const key = rawKey.trim()
		if (key) extraAuthorizeParams[key] = paramValue
	}
	return {
		authorizeUrl: value.authorizeUrl.trim(),
		scopes: value.scopes.map((scope) => scope.trim()).filter(Boolean),
		scopeSeparator,
		extraAuthorizeParams: Object.fromEntries(
			Object.keys(extraAuthorizeParams)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => [key, extraAuthorizeParams[key] ?? '']),
		),
	}
}

export function mergeIntegrationConfig(
	current: IntegrationConfig,
	update: IntegrationSaveInput,
): IntegrationConfig {
	return normalizeIntegrationConfig({
		...current,
		...update,
		name: update.name,
	})
}

function isHttpUrl(raw: string) {
	try {
		const url = new URL(raw)
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}
