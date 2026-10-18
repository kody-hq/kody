import {
	saveSecretSchema,
	deleteSecretSchema,
	saveOAuthAppSchema,
	connectOAuthSchema,
	exchangeOAuthTokenSchema,
} from '#universal/secret-mutations.ts'
import {
	rotateOauthAppCredentialsSchema,
	disconnectConnectionSchema,
	deleteOauthAppSchema,
	setUsageSchema,
	approvePackageSchema,
} from '#universal/integration-mutations.ts'
import { connectSecretsSchema } from '../connect-input.ts'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const saveProfile = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			displayName: z.string(),
			bio: z.string(),
			profileVisibility: z.enum(['public', 'private']),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async (context) => {
			const { saveAccountProfile } =
				await import('../../src/app/handlers/account-profile.ts')
			return saveAccountProfile({ ...context, body: data })
		})
	})

const resourceInput = z.object({
	orgSlug: z
		.string()
		.regex(/^[a-zA-Z0-9_-]+$/)
		.optional(),
	search: z.string().default(''),
})
const secretRefreshSchema = connectSecretsSchema
	.pick({ selectedSecretId: true, approval: true })
	.default({
		selectedSecretId: null,
		approval: { hosts: [], names: [], scope: 'user' },
	})
const secretMutationScope = resourceInput
	.omit({ search: true })
	.extend({ refresh: secretRefreshSchema })
export const saveSecret = createServerFn({ method: 'POST' })
	.inputValidator(
		resourceInput.omit({ search: true }).extend({ fields: saveSecretSchema }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ saveAccountSecret },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secrets.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				const result = await saveAccountSecret({ ...context, ...data })
				if (
					result.status === 400 &&
					!result.data.ok &&
					'selectedSecret' in result.data
				) {
					const recovery = z
						.strictObject({
							ok: z.literal(false),
							error: z.string(),
							selectedSecret: z.strictObject({
								id: z.string(),
								name: z.string(),
							}),
						})
						.parse(result.data)
					return recovery
				}
				return requireOperationResult(result)
			},
		)
	})

export const deleteSecret = createServerFn({ method: 'POST' })
	.inputValidator(
		resourceInput.omit({ search: true }).extend({ fields: deleteSecretSchema }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ deleteAccountSecret },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secrets.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await deleteAccountSecret({ ...context, ...data }),
				),
		)
	})

export const approveSecretAccess = createServerFn({ method: 'POST' })
	.validator(secretMutationScope)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ approveAccountSecretAccess },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secrets.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await approveAccountSecretAccess({ ...context, ...data }),
				),
		)
	})

export const rejectSecretAccess = createServerFn({ method: 'POST' })
	.validator(secretMutationScope)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ rejectAccountSecretAccess },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secrets.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await rejectAccountSecretAccess({ ...context, ...data }),
				),
		)
	})

export const saveOAuthApp = createServerFn({ method: 'POST' })
	.validator(secretMutationScope.extend({ fields: saveOAuthAppSchema }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ saveAccountOAuthApp },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secrets.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await saveAccountOAuthApp({ ...context, ...data }),
				),
		)
	})

export const connectOAuth = createServerFn({ method: 'POST' })
	.validator(secretMutationScope.extend({ fields: connectOAuthSchema }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ connectAccountOAuth },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secrets.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await connectAccountOAuth({ ...context, ...data }),
				),
		)
	})

export const exchangeOAuthToken = createServerFn({ method: 'POST' })
	.validator(secretMutationScope.extend({ fields: exchangeOAuthTokenSchema }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ exchangeAccountOAuthToken },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secrets.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await exchangeAccountOAuthToken({ ...context, ...data }),
				),
		)
	})

const deviceConnectStartSchema = z.object({
	provider: z.string(),
	platformAppSlug: z.string().nullish(),
	tokenUrl: z.string().nullish(),
	apiBaseUrl: z.string().nullish(),
	authorizeUrl: z.string().nullish(),
	deviceAuthorizationUrl: z.string().nullish(),
	clientId: z.string().nullish(),
	clientSecret: z.string().nullish(),
	usePkce: z.boolean().nullish(),
	scopes: z.array(z.string()).optional(),
	scopeSeparator: z.string().nullish(),
	extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
	allowedHosts: z.array(z.string()).optional(),
	tokenExchangeStyle: z.string().nullish(),
})

const deviceConnectPollSchema = z.object({
	sessionId: z.string().min(1),
})

export const startDeviceConnect = createServerFn({ method: 'POST' })
	.validator(secretMutationScope.extend({ fields: deviceConnectStartSchema }))
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { startAccountDeviceConnect }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/account-secrets.ts'),
			])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				const result = await startAccountDeviceConnect({ ...context, ...data })
				return result.data
			},
		)
	})

export const pollDeviceConnect = createServerFn({ method: 'POST' })
	.validator(secretMutationScope.extend({ fields: deviceConnectPollSchema }))
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { pollAccountDeviceConnect }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/account-secrets.ts'),
			])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				const result = await pollAccountDeviceConnect({ ...context, ...data })
				return result.data
			},
		)
	})

export const deleteAccountMemory = createServerFn({ method: 'POST' })
	.validator(
		resourceInput.omit({ search: true }).extend({
			memoryId: z.string().trim().min(1),
			force: z.boolean(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ deleteAccountMemoryRecord },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-memories.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{
				scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined,
			},
			async (context) => {
				return requireOperationResult(
					await deleteAccountMemoryRecord({
						...context,
						memoryId: data.memoryId,
						force: data.force,
					}),
				)
			},
		)
	})

export const setJobKillSwitch = createServerFn({ method: 'POST' })
	.validator(
		resourceInput
			.omit({ search: true })
			.extend({ id: z.string().trim().min(1), killSwitchEnabled: z.boolean() }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ setAccountJobKillSwitch },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-jobs.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				const result = requireOperationResult(
					await setAccountJobKillSwitch({
						...context,
						id: data.id,
						killSwitchEnabled: data.killSwitchEnabled,
					}),
				)
				return result
			},
		)
	})

export const runJobNow = createServerFn({ method: 'POST' })
	.validator(
		resourceInput
			.omit({ search: true })
			.extend({ id: z.string().trim().min(1) }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ runAccountJobNow },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-jobs.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				const result = requireOperationResult(
					await runAccountJobNow({ ...context, id: data.id }),
				)
				return result
			},
		)
	})

export const cancelWorkflowRun = createServerFn({ method: 'POST' })
	.validator(
		resourceInput
			.omit({ search: true })
			.extend({ id: z.string().trim().min(1) }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ cancelAccountWorkflowRun },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-workflows.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				const result = requireOperationResult(
					await cancelAccountWorkflowRun({ ...context, id: data.id }),
				)
				return result
			},
		)
	})
export const bindSecretProvider = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			provider: z.string(),
			packageId: z.string(),
			doorSecretName: z.string(),
			config: z.record(z.string(), z.string()).default({}),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ bindAccountSecretProvider },
			{ requireOperationResult, operationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secret-providers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				try {
					return requireOperationResult(
						await bindAccountSecretProvider({
							...context,
							...data,
							requestUrl: context.request.url,
						}),
					)
				} catch (error) {
					return requireOperationResult(
						operationResult(
							{
								ok: false,
								error:
									error instanceof Error
										? error.message
										: 'Unable to update secret providers.',
							},
							400,
						),
					)
				}
			},
		)
	})

export const unbindSecretProvider = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			provider: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ unbindAccountSecretProvider },
			{ requireOperationResult, operationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secret-providers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				try {
					return requireOperationResult(
						await unbindAccountSecretProvider({
							...context,
							...data,
						}),
					)
				} catch (error) {
					return requireOperationResult(
						operationResult(
							{
								ok: false,
								error:
									error instanceof Error
										? error.message
										: 'Unable to update secret providers.',
							},
							400,
						),
					)
				}
			},
		)
	})

export const grantSecretProvider = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			provider: z.string(),
			packageId: z.string(),
			ref: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ grantAccountSecretProvider },
			{ requireOperationResult, operationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secret-providers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				try {
					return requireOperationResult(
						await grantAccountSecretProvider({
							...context,
							...data,
						}),
					)
				} catch (error) {
					return requireOperationResult(
						operationResult(
							{
								ok: false,
								error:
									error instanceof Error
										? error.message
										: 'Unable to update secret providers.',
							},
							400,
						),
					)
				}
			},
		)
	})

export const revokeSecretProvider = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			provider: z.string(),
			packageId: z.string(),
			ref: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ revokeAccountSecretProvider },
			{ requireOperationResult, operationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-secret-providers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) => {
				try {
					return requireOperationResult(
						await revokeAccountSecretProvider({
							...context,
							...data,
						}),
					)
				} catch (error) {
					return requireOperationResult(
						operationResult(
							{
								ok: false,
								error:
									error instanceof Error
										? error.message
										: 'Unable to update secret providers.',
							},
							400,
						),
					)
				}
			},
		)
	})

export const rotateOauthAppCredentials = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			input: rotateOauthAppCredentialsSchema,
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ rotateAccountOauthAppCredentials },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-integrations.ts'),
			import('../../src/app/operation-result.ts'),
		])
		const input = data.input
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await rotateAccountOauthAppCredentials({ ...context, ...input }),
				),
		)
	})

export const disconnectIntegration = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			input: disconnectConnectionSchema,
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ disconnectAccountIntegration },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-integrations.ts'),
			import('../../src/app/operation-result.ts'),
		])
		const input = data.input
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await disconnectAccountIntegration({ ...context, name: input.name }),
				),
		)
	})

export const deleteOauthApp = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			input: deleteOauthAppSchema,
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ deleteAccountOauthApp },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-integrations.ts'),
			import('../../src/app/operation-result.ts'),
		])
		const input = data.input
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await deleteAccountOauthApp({ ...context, appSlug: input.appSlug }),
				),
		)
	})

export const setIntegrationUsage = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			input: setUsageSchema,
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ setAccountIntegrationUsage },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-integrations.ts'),
			import('../../src/app/operation-result.ts'),
		])
		const input = data.input
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await setAccountIntegrationUsage({ ...context, ...input }),
				),
		)
	})

export const approveIntegrationPackage = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			input: approvePackageSchema,
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ approveAccountIntegrationPackage },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-integrations.ts'),
			import('../../src/app/operation-result.ts'),
		])
		const input = data.input
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await approveAccountIntegrationPackage({ ...context, ...input }),
				),
		)
	})
export const disconnectAccountProvider = createServerFn({ method: 'POST' })
	.validator(
		z.object({ provider: z.enum(['github', 'google', 'x', 'discord']) }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ disconnectAccountProvider: operation },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-connections.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation({}, async (context) =>
			requireOperationResult(
				await operation({ ...context, provider: data.provider }),
			),
		)
	})

export const syncDiscordMemberRole = createServerFn({ method: 'POST' })
	.validator(z.object({}))
	.handler(async () => {
		const [
			{ withWebsiteMutation },
			{ syncAccountDiscordRole: operation },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-connections.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation({}, async (context) =>
			requireOperationResult(await operation({ ...context })),
		)
	})
export const addMcpServer = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			name: z.string(),
			url: z.string(),
			bearerToken: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ addAccountMcpServer },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-servers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await addAccountMcpServer({ ...context, ...data }),
				),
		)
	})

export const reconnectMcpServer = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			id: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ reconnectAccountMcpServer },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-servers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await reconnectAccountMcpServer({ ...context, ...data }),
				),
		)
	})

export const refreshMcpServer = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			id: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ refreshAccountMcpServer },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-servers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await refreshAccountMcpServer({ ...context, ...data }),
				),
		)
	})

export const setMcpServerEnabled = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			id: z.string(),
			enabled: z.boolean(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ setAccountMcpServerEnabled },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-servers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await setAccountMcpServerEnabled({ ...context, ...data }),
				),
		)
	})

export const setMcpServerUsage = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			id: z.string(),
			usageMode: z.enum(['any', 'packages']),
			allowedPackageIds: z.array(z.string()),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ setAccountMcpServerUsage },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-servers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await setAccountMcpServerUsage({ ...context, ...data }),
				),
		)
	})

export const deleteMcpServer = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			id: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ deleteAccountMcpServer },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-servers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await deleteAccountMcpServer({ ...context, ...data }),
				),
		)
	})

export const setMcpServerOAuthClient = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			id: z.string(),
			clientId: z.string(),
			clientSecret: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ setAccountMcpServerOAuthClient },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-servers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await setAccountMcpServerOAuthClient({ ...context, ...data }),
				),
		)
	})

export const removeMcpServerOAuthClient = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			id: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ removeAccountMcpServerOAuthClient },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-servers.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await removeAccountMcpServerOAuthClient({ ...context, ...data }),
				),
		)
	})

export const deleteEmailMessage = createServerFn({ method: 'POST' })
	.validator(
		resourceInput.omit({ search: true }).extend({
			messageId: z.string().trim().min(1),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ deleteAccountEmailMessage },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-email.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{
				scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined,
			},
			async (context) => {
				const result = requireOperationResult(
					await deleteAccountEmailMessage({
						...context,
						messageId: data.messageId,
					}),
				)
				return result
			},
		)
	})

export const classifyEmailMessage = createServerFn({ method: 'POST' })
	.validator(
		resourceInput.omit({ search: true }).extend({
			messageId: z.string().trim().min(1),
			classification: z.enum(['accepted', 'quarantined']),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ classifyAccountEmailMessage },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-email.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{
				scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined,
			},
			async (context) => {
				const result = requireOperationResult(
					await classifyAccountEmailMessage({
						...context,
						messageId: data.messageId,
						classification: data.classification,
					}),
				)
				return result
			},
		)
	})

export const addEmailDestination = createServerFn({ method: 'POST' })
	.validator(z.object({ email: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ addAccountEmailDestination },
			{ requireOperationResult },
			{ setResponseHeader },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-email-destinations.ts'),
			import('../../src/app/operation-result.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await addAccountEmailDestination({
				...context,
				email: data.email,
			})
			new Headers(result.headers).forEach((value, key) =>
				setResponseHeader(key, value),
			)
			return requireOperationResult(result)
		})
	})

export const resendEmailDestination = createServerFn({ method: 'POST' })
	.validator(z.object({ destinationId: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ resendAccountEmailDestination },
			{ requireOperationResult },
			{ setResponseHeader },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-email-destinations.ts'),
			import('../../src/app/operation-result.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await resendAccountEmailDestination({
				...context,
				destinationId: data.destinationId,
			})
			new Headers(result.headers).forEach((value, key) =>
				setResponseHeader(key, value),
			)
			return requireOperationResult(result)
		})
	})

export const setDefaultEmailDestination = createServerFn({ method: 'POST' })
	.validator(z.object({ destinationId: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ setDefaultAccountEmailDestination },
			{ requireOperationResult },
			{ setResponseHeader },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-email-destinations.ts'),
			import('../../src/app/operation-result.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await setDefaultAccountEmailDestination({
				...context,
				destinationId: data.destinationId,
			})
			new Headers(result.headers).forEach((value, key) =>
				setResponseHeader(key, value),
			)
			return requireOperationResult(result)
		})
	})

export const removeEmailDestination = createServerFn({ method: 'POST' })
	.validator(z.object({ destinationId: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ removeAccountEmailDestination },
			{ requireOperationResult },
			{ setResponseHeader },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-email-destinations.ts'),
			import('../../src/app/operation-result.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await removeAccountEmailDestination({
				...context,
				destinationId: data.destinationId,
			})
			new Headers(result.headers).forEach((value, key) =>
				setResponseHeader(key, value),
			)
			return requireOperationResult(result)
		})
	})

export const updateAvatar = createServerFn({ method: 'POST' })
	.validator((data: FormData) => {
		if (!(data instanceof FormData))
			throw new Error('Expected avatar form data.')
		const avatar = data.get('avatar')
		if (data.get('remove') !== 'true' && !(avatar instanceof File))
			throw new Error('Avatar file is required.')
		return data
	})
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { updateAccountAvatar }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/account-avatar.ts'),
			])
		return withWebsiteMutation({}, (context) =>
			updateAccountAvatar({
				...context,
				avatar:
					data.get('remove') === 'true' ? null : (data.get('avatar') as File),
			}),
		)
	})

const profileGrants = z.array(
	z.object({
		resourceType: z.literal('package'),
		resourceId: z.string(),
		actions: z.array(z.enum(['read', 'execute'])),
	}),
)
export const revokeConnectedAgent = createServerFn({ method: 'POST' })
	.validator(
		resourceInput
			.omit({ search: true })
			.extend({ clientId: z.string().trim().min(1) }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ revokeAccountConnectedAgent },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-connected-agents.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await revokeAccountConnectedAgent({
						...context,
						clientId: data.clientId,
					}),
				),
		)
	})

export const createConnectionProfile = createServerFn({ method: 'POST' })
	.validator(
		resourceInput
			.omit({ search: true })
			.extend({ name: z.string(), grants: profileGrants }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ createConnectedAgentProfile },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-connected-agents.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await createConnectedAgentProfile({
						...context,
						name: data.name,
						grants: data.grants,
					}),
				),
		)
	})

export const updateConnectionProfile = createServerFn({ method: 'POST' })
	.validator(
		resourceInput.omit({ search: true }).extend({
			profileId: z.string().trim().min(1),
			name: z.string().optional(),
			grants: profileGrants.optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ updateConnectedAgentProfile },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-connected-agents.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await updateConnectedAgentProfile({
						...context,
						profileId: data.profileId,
						name: data.name,
						grants: data.grants,
					}),
				),
		)
	})

export const deleteConnectionProfile = createServerFn({ method: 'POST' })
	.validator(
		resourceInput
			.omit({ search: true })
			.extend({ profileId: z.string().trim().min(1) }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ deleteConnectedAgentProfile },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-connected-agents.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(
					await deleteConnectedAgentProfile({
						...context,
						profileId: data.profileId,
					}),
				),
		)
	})
export const continueMcpAuthorization = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			serverId: z.string().min(1),
			token: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ loadConsentContext, isConsentRefusal, continueMcpServerAuthorization },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/org-mcp-server-authorize.ts'),
		])
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) => {
				const consent = await loadConsentContext({
					...context,
					params: { orgSlug: data.orgSlug, serverId: data.serverId },
				})
				if (isConsentRefusal(consent))
					throw new Error(
						consent.kind === 'signed-out'
							? 'Please sign in again.'
							: consent.title,
					)
				return (
					await continueMcpServerAuthorization({
						env: context.env,
						context: consent,
						token: data.token,
					})
				).data
			},
		)
	})
export const recordWaitingClick = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			cardId: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ sanitizeWaitingCardId },
			{ recordOnboardingFunnelEvent },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('#universal/onboarding-funnel.ts'),
			import('#worker/identity/onboarding-funnel.ts'),
		])
		const cardId = sanitizeWaitingCardId(data.cardId)
		if (!cardId) throw new Error('Unknown card.')
		return withWebsiteMutation(
			{
				scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined,
			},
			async ({ env, user }) => {
				recordOnboardingFunnelEvent(env, {
					stage: 'waiting_card_clicked',
					userId: user.mcpUser.userId,
					dimension: cardId,
				})
				return { ok: true }
			},
		)
	})
export const updateExperiments = createServerFn({ method: 'POST' })
	.validator(z.object({ experimentsOptIn: z.boolean() }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ saveExperimentsPreference },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-experiments.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation({}, async (context) =>
			requireOperationResult(
				await saveExperimentsPreference({
					...context,
					experimentsOptIn: data.experimentsOptIn,
				}),
			),
		)
	})

export const createMcpOauthClient = createServerFn({ method: 'POST' })
	.validator(z.object({ label: z.string(), redirectUris: z.string() }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ createAccountMcpOauthClient },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-oauth-clients.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation({}, async (context) =>
			requireOperationResult(
				await createAccountMcpOauthClient({ ...context, ...data }),
			),
		)
	})

export const revokeMcpOauthClient = createServerFn({ method: 'POST' })
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ revokeAccountMcpOauthClient },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-mcp-oauth-clients.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation({}, async (context) =>
			requireOperationResult(
				await revokeAccountMcpOauthClient({ ...context, ...data }),
			),
		)
	})

export const resumeOutboundEmailDelivery = createServerFn({ method: 'POST' })
	.validator(
		z.strictObject({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ resumeAccountOutboundDelivery },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/account-email.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async (context) =>
				requireOperationResult(await resumeAccountOutboundDelivery(context)),
		)
	})
