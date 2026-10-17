import { z } from 'zod'
import { secretsInput } from './secrets-input.ts'

const locationFields = {
	orgSlug: z
		.string()
		.regex(/^[a-zA-Z0-9_-]+$/)
		.optional(),
	// Lossless navigation state only. Authorization and reads use the explicit fields.
	search: z.array(z.tuple([z.string(), z.string()])),
}
export const connectSecretsSchema = z.object({
	...locationFields,
	selectedSecretId: z.string().nullable(),
	approval: z.object({
		hosts: z.array(z.string()),
		names: z.array(z.string()),
		packageId: z.string().optional(),
		scope: z.enum(['user', 'session', 'package']),
		storagePackageId: z.string().optional(),
		sessionId: z.string().optional(),
	}),
})
export const connectOauthSchema = z.object({
	...locationFields,
	provider: z.string().optional(),
	code: z.string().optional(),
	error: z.string().optional(),
	appSlug: z.string().optional(),
	platformSlug: z.string().optional(),
})
export const connectWebhookSchema = z.object({
	...locationFields,
	handle: z.string().nullable(),
	fingerprint: z.string().nullable(),
})
function connectionLocation(search: string) {
	const params = new URLSearchParams(search)
	return {
		params,
		// Present-but-empty scope must fail validation, never select personal scope.
		orgSlug: params.has('org') ? params.get('org')!.trim() : undefined,
		search: Array.from(params.entries()),
	}
}
export function connectSecretsInput(
	search: string,
): z.infer<typeof connectSecretsSchema> {
	const { params: _, ...location } = connectionLocation(search)
	const { selectedSecretId, approval } = secretsInput(
		location.orgSlug ?? '',
		search,
	)
	return { ...location, selectedSecretId, approval }
}
export function connectOauthInput(
	search: string,
): z.infer<typeof connectOauthSchema> {
	const { params, ...location } = connectionLocation(search)
	return {
		...location,
		provider: params.get('provider') ?? undefined,
		code: params.get('code') ?? undefined,
		error: params.get('error') ?? undefined,
		appSlug: params.get('app') ?? undefined,
		platformSlug: params.get('platform') ?? undefined,
	}
}
export function connectWebhookInput(
	search: string,
): z.infer<typeof connectWebhookSchema> {
	const { params, ...location } = connectionLocation(search)
	return {
		...location,
		handle: params.get('handle')?.trim() || null,
		fingerprint: params.get('fingerprint')?.trim() || null,
	}
}
