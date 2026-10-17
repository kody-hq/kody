import { buildCredentialCreateHref } from '#universal/credential-contracts.ts'
import { z } from 'zod'
import { routes } from '#universal/routes.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { notFound, redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { readJsonRecord } from './json-value.ts'

export const loadSecretsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			selectedSecretId: z.string().nullable(),
			create: z.boolean(),
			creation: z.object({
				name: z.string().nullable(),
				provider: z.string().nullable(),
				description: z.string().nullable(),
				allowedHosts: z.array(z.string()),
				packageKodyId: z.string().nullable(),
				needKey: z.string().nullable(),
				packageScopedTo: z.string().nullable(),
				packageScopeMissingId: z.boolean(),
				expiresAt: z.string().nullable(),
				allowedPackages: z.array(z.string()),
			}),
			approval: z.object({
				hosts: z.array(z.string()),
				names: z.array(z.string()),
				packageId: z.string().optional(),
				scope: z.enum(['user', 'package', 'session']),
				storagePackageId: z.string().optional(),
				sessionId: z.string().optional(),
			}),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadAccountSecretsSelection },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/account-secrets-data.ts'),
			import('./document-head.ts'),
		])
		const pathname = routes.orgSecrets.href({ orgSlug: data.orgSlug })
		if (data.create && data.creation.name) {
			throw redirect({
				href:
					buildCredentialCreateHref({
						...data.creation,
						orgSlug: data.orgSlug,
						kind: 'secret',
					}) + (data.creation.packageScopeMissingId ? '&scope=package' : ''),
				statusCode: 302,
			})
		}
		const { bindings, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'secrets',
			returnTo: pathname,
		})
		const payload = await loadAccountSecretsSelection({
			env: bindings,
			user,
			selectedSecretId: data.selectedSecretId,
			approval: data.approval,
		})
		return {
			payload,
			head: loadDocumentHead('orgSecrets', pathname, {
				accountSecrets: payload,
			}),
		}
	})

export const loadMemoriesPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			memoryId: z.string().trim().min(1).optional(),
			selected: z.string().trim().min(1).optional(),
			query: z.string().default(''),
			includeDeleted: z.boolean().default(false),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadAccountMemoriesData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/account-memories-data.ts'),
			import('./document-head.ts'),
		])
		const pathname =
			routes.orgMemories.href({ orgSlug: data.orgSlug }) +
			(data.memoryId ? `/${encodeURIComponent(data.memoryId)}` : '')
		const params = new URLSearchParams()
		if (data.selected) params.set('selected', data.selected)
		if (data.query) params.set('q', data.query)
		if (data.includeDeleted) params.set('includeDeleted', 'true')
		const search = params.size ? `?${params}` : ''
		const { bindings, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'memories',
			returnTo: pathname + search,
		})
		const payload = await loadAccountMemoriesData({
			env: bindings,
			user,
			query: data.query,
			includeDeleted: data.includeDeleted,
			selectedMemoryId: data.memoryId ?? data.selected ?? null,
		})
		return {
			payload,
			head: loadDocumentHead(
				'orgMemories',
				pathname,
				{ accountMemories: payload },
				search,
			),
		}
	})
export const loadJobsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			jobId: z.string().optional(),
			selected: z.string().optional(),
		}),
	)
	.handler(async ({ data: input }) => {
		const { loadScopedCollection } = await import('./collection-context.ts')
		const pathname =
			routes.orgJobs.href({ orgSlug: input.orgSlug }) +
			(input.jobId ? `/${encodeURIComponent(input.jobId)}` : '')
		const search = input.selected
			? `?${new URLSearchParams({ selected: input.selected })}`
			: ''
		const { bindings, user } = await loadScopedCollection({
			orgSlug: input.orgSlug,
			section: 'jobs',
			returnTo: pathname + search,
		})
		const [{ loadAccountJobsData }, { loadDocumentHead }] = await Promise.all([
			import('../../src/app/account-jobs-data.ts'),
			import('./document-head.ts'),
		])
		const data = await loadAccountJobsData({
			env: bindings,
			user,
			selectedJobId: input.jobId?.trim() || input.selected?.trim() || null,
		})
		const payload = {
			...data,
			selectedJob: data.selectedJob
				? {
						...data.selectedJob,
						params: data.selectedJob.params
							? readJsonRecord(data.selectedJob.params)
							: null,
					}
				: null,
		}
		return {
			payload,
			head: loadDocumentHead(
				'orgJobs',
				pathname,
				{ accountJobs: payload },
				search,
			),
		}
	})

export const loadWorkflowsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			workflowId: z.string().optional(),
			selected: z.string().optional(),
		}),
	)
	.handler(async ({ data: input }) => {
		const { loadScopedCollection } = await import('./collection-context.ts')
		const pathname =
			routes.orgWorkflows.href({ orgSlug: input.orgSlug }) +
			(input.workflowId ? `/${encodeURIComponent(input.workflowId)}` : '')
		const search = input.selected
			? `?${new URLSearchParams({ selected: input.selected })}`
			: ''
		const { bindings, user } = await loadScopedCollection({
			orgSlug: input.orgSlug,
			section: 'workflows',
			returnTo: pathname + search,
		})
		const [{ loadAccountWorkflowsData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/app/account-workflows-data.ts'),
				import('./document-head.ts'),
			])
		const payload = await loadAccountWorkflowsData({
			env: bindings,
			user,
			selectedWorkflowId:
				input.workflowId?.trim() || input.selected?.trim() || null,
		})
		return {
			payload,
			head: loadDocumentHead(
				'orgWorkflows',
				pathname,
				{ accountWorkflows: payload },
				search,
			),
		}
	})

export const loadWaitingPage = createServerFn({ method: 'GET' })
	.validator(z.object({ orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/) }))
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadAccountWaitingData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/account-waiting-data.ts'),
			import('./document-head.ts'),
		])
		const pathname = routes.orgWaiting.href({ orgSlug: data.orgSlug })
		const { bindings, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'waiting',
			returnTo: pathname,
		})
		const payload = await loadAccountWaitingData({
			env: bindings,
			user,
			waitUntil: (await import('cloudflare:workers')).waitUntil,
		})
		return {
			payload,
			head: loadDocumentHead('orgWaiting', pathname, {
				accountWaiting: payload,
			}),
		}
	})

export const loadExperimentsPage = createServerFn({ method: 'GET' })
	.validator(z.object({}))
	.handler(async () => {
		const [
			{ loadPersonalCollection },
			{ loadAccountExperimentsData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/account-experiments-data.ts'),
			import('./document-head.ts'),
		])
		const pathname = '/account/experiments'
		const { bindings, user } = await loadPersonalCollection(pathname)
		const payload = await loadAccountExperimentsData({
			db: bindings.APP_DB,
			userId: user.userId,
		})
		return {
			payload,
			head: loadDocumentHead('accountExperiments', pathname, {
				accountExperiments: payload,
			}),
		}
	})

export const loadActivityPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			selectedRunId: z.string().nullable(),
			viewFilter: z.enum(['errors', 'recent']),
			statusFilter: z.enum(['error', 'all', 'success', 'running']),
			surfaceFilter: z.enum([
				'all',
				'execute',
				'export',
				'subscription',
				'app_fetch',
				'app_realtime',
				'job',
				'workflow',
				'retriever',
				'webhook',
			]),
			triageFilter: z.enum(['open', 'ignored', 'resolved', 'all']),
			cursor: z.string().nullable(),
		}),
	)
	.handler(async ({ data: input }) => {
		const [
			{ loadScopedCollection },
			{ loadAccountActivityData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/account-activity-data.ts'),
			import('./document-head.ts'),
		])
		const pathname = routes.orgActivity.href({ orgSlug: input.orgSlug })
		const { bindings, user } = await loadScopedCollection({
			orgSlug: input.orgSlug,
			section: 'activity',
			returnTo: pathname,
		})
		const data = await loadAccountActivityData({
			env: bindings,
			user,
			...input,
		})
		const payload = {
			...data,
			selectedRun: data.selectedRun
				? {
						...data.selectedRun,
						metadata: readJsonRecord(data.selectedRun.metadata),
						logs: data.selectedRun.logs.map((log) => ({
							...log,
							fields: log.fields ? readJsonRecord(log.fields) : null,
						})),
					}
				: null,
		}

		return {
			payload,
			head: loadDocumentHead('orgActivity', pathname, {
				accountActivity: payload,
			}),
		}
	})

export const loadBillingPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			billing: z.string().nullable(),
			error: z.string().nullable(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadOrgBillingPageData, resolveOrgBillingAccess },
			{ loadDocumentHead },
			{ orgBillingPath },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/handlers/org-billing.ts'),
			import('./document-head.ts'),
			import('../../universal/org-pages.ts'),
		])
		const pathname = orgBillingPath(data.orgSlug)
		const params = new URLSearchParams()
		if (data.billing !== null) params.set('billing', data.billing)
		if (data.error !== null) params.set('error', data.error)
		const search = params.size ? `?${params}` : ''
		const { bindings, request, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'billing',
			returnTo: pathname + search,
		})
		const access = await resolveOrgBillingAccess({
			orgSlug: data.orgSlug,
			request,
			env: bindings,
			user,
			permission: 'billing:read',
		})
		if (!access.ok) {
			if (access.status === 404) throw notFound()
			const { setResponseStatus } = await import('@tanstack/react-start/server')
			setResponseStatus(access.status)
			throw new Error(access.error)
		}
		const payload = await loadOrgBillingPageData({
			env: bindings,
			user,
			org: access.org,
			errorCode: data.error,
			noticeCode: data.billing,
		})
		if (!payload) throw notFound()
		return {
			payload,
			head: loadDocumentHead(
				'orgBilling',
				pathname,
				{ accountBilling: payload },
				search,
			),
		}
	})

export const loadUsagePage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			credits: z.string().nullable(),
			error: z.string().nullable(),
			topup: z.string().nullable(),
			sessionId: z.string().nullable(),
			hash: z.string().optional(),
			navigationSearch: z.array(z.tuple([z.string(), z.string()])).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection, loadPersonalCollection },
			{ loadOrgUsagePageResult },
			{ loadDocumentHead },
			{ orgUsagePath },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/handlers/org-usage.ts'),
			import('./document-head.ts'),
			import('../../universal/org-pages.ts'),
		])
		const pathname = data.orgSlug
			? orgUsagePath(data.orgSlug)
			: '/account/usage'
		const params = new URLSearchParams()
		for (const [key, value] of [
			['credits', data.credits],
			['error', data.error],
			['topup', data.topup],
			['session_id', data.sessionId],
		] as const)
			if (value !== null) params.set(key, value)
		const search = params.size ? `?${params}` : ''
		const hash = data.hash ? `#${data.hash.replace(/^#/, '')}` : ''
		if (!data.orgSlug) {
			const navigationParams = new URLSearchParams(
				data.navigationSearch ?? params,
			)
			const navigationSearch = navigationParams.size
				? `?${navigationParams}`
				: ''
			const { bindings, user } = await loadPersonalCollection(
				pathname + navigationSearch + hash,
			)
			const { personalUsageSlug } =
				await import('../../src/app/handlers/account-usage.ts')
			throw redirect({
				href:
					orgUsagePath(await personalUsageSlug(bindings, user)) +
					navigationSearch +
					hash,
				statusCode: 302,
			})
		}
		const { bindings, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'usage',
			returnTo: pathname + search,
		})
		const result = await loadOrgUsagePageResult({
			...data,
			orgSlug: data.orgSlug,
			env: bindings,
			user,
		})
		if (result.kind === 'denied') {
			if (result.status === 404) throw notFound()
			const { setResponseStatus } = await import('@tanstack/react-start/server')
			setResponseStatus(result.status)
			throw new Error(result.error)
		}
		return {
			payload: result.payload,
			head: loadDocumentHead(
				'orgUsage',
				pathname,
				{ accountUsage: result.payload },
				search,
			),
		}
	})

export const loadConnectionsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			view: z.enum(['list', 'usage', 'new']),
			agent: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { loadScopedCollection } = await import('./collection-context.ts')
		const { isAccountConnectionAgent } =
			await import('../../universal/account-connections.ts')
		if (
			data.agent &&
			(data.view !== 'new' || !isAccountConnectionAgent(data.agent))
		)
			throw notFound()
		const pathname =
			routes.orgAgents.href({ orgSlug: data.orgSlug }) +
			(data.view === 'list' ? '' : `/${data.view}`) +
			(data.agent ? `/${encodeURIComponent(data.agent)}` : '')
		const { bindings, request, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'agents',
			returnTo: pathname,
		})
		const [{ loadAccountConnectedAgentsData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/app/handlers/account-connected-agents.ts'),
				import('./document-head.ts'),
			])
		const payload = await loadAccountConnectedAgentsData({
			env: bindings,
			requestUrl: request.url,
			user,
		})
		return {
			payload,
			head: loadDocumentHead('orgAgents', pathname, {
				accountConnectedAgents: payload,
			}),
		}
	})

export const loadMcpOauthClientsPage = createServerFn({ method: 'GET' })
	.validator(z.object({}))
	.handler(async () => {
		const [
			{ loadPersonalCollection },
			{ loadClientsPayload },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/handlers/account-mcp-oauth-clients.ts'),
			import('./document-head.ts'),
		])
		const pathname = '/account/mcp-oauth-clients'
		const { bindings, user } = await loadPersonalCollection(pathname)
		const payload = await loadClientsPayload(bindings.APP_DB, user.userId)
		return {
			payload,
			head: loadDocumentHead('accountMcpOauthClients', pathname, {
				accountMcpOauthClients: payload,
			}),
		}
	})

export const loadWebhooksPage = createServerFn({ method: 'GET' })
	.validator(z.object({ orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/) }))
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadAccountWebhooksData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/package-webhooks-data.ts'),
			import('./document-head.ts'),
		])
		const pathname = routes.orgWebhooks.href({ orgSlug: data.orgSlug })
		const { bindings, user, request } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'webhooks',
			returnTo: pathname,
		})
		const payload = await loadAccountWebhooksData({
			env: bindings,
			user,
			requestUrl: request.url,
		})
		return {
			payload,
			head: loadDocumentHead('orgWebhooks', pathname, {
				accountWebhooks: payload,
			}),
		}
	})

export const loadSecretProvidersPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			approve: z.boolean().optional(),
			provider: z.string().optional(),
			ref: z.string().optional(),
			packageId: z.string().optional(),
			packageName: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadAccountSecretProvidersData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/account-secret-providers-data.ts'),
			import('./document-head.ts'),
		])
		const pathname =
			routes.orgSecretProviders.href({ orgSlug: data.orgSlug }) +
			(data.approve ? '/approve' : '')
		const params = new URLSearchParams()
		if (data.provider) params.set('provider', data.provider)
		if (data.ref) params.set('ref', data.ref)
		if (data.packageId) params.set('package_id', data.packageId)
		if (data.packageName) params.set('package', data.packageName)
		const search = params.size ? `?${params}` : ''
		const { bindings, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'secret-providers',
			returnTo: pathname + search,
		})
		const payload = await loadAccountSecretProvidersData({
			env: bindings,
			userId: ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
			email: user.email,
			approval: data,
		})
		return {
			payload,
			head: loadDocumentHead(
				'orgSecretProviders',
				pathname,
				{ accountSecretProviders: payload },
				search,
			),
		}
	})

export const loadMcpServersPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			serverId: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { loadScopedCollection } = await import('./collection-context.ts')
		const pathname =
			routes.orgMcpServers.href({ orgSlug: data.orgSlug }) +
			(data.serverId ? `/${encodeURIComponent(data.serverId)}` : '')
		const { bindings, request, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'mcp-servers',
			returnTo: pathname,
		})
		const [{ loadAccountMcpServersData }, { loadDocumentHead }, { waitUntil }] =
			await Promise.all([
				import('../../src/app/account-mcp-servers-data.ts'),
				import('./document-head.ts'),
				import('cloudflare:workers'),
			])
		const payload = await loadAccountMcpServersData({
			env: bindings,
			user,
			requestUrl: request.url,
			waitUntil,
		})
		return {
			payload,
			head: loadDocumentHead('orgMcpServers', pathname, {
				accountMcpServers: payload,
			}),
		}
	})

export const loadIntegrationsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			integrationName: z.string().optional(),
			appSlug: z.string().optional(),
			approve: z.boolean().optional(),
			name: z.string().optional(),
			packageId: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadAccountIntegrationsData },
			{ loadDocumentHead },
			{ waitUntil },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/account-integrations-data.ts'),
			import('./document-head.ts'),
			import('cloudflare:workers'),
		])
		const pathname =
			routes.orgIntegrations.href({ orgSlug: data.orgSlug }) +
			(data.appSlug
				? `/apps/${encodeURIComponent(data.appSlug)}`
				: data.approve
					? '/approve'
					: data.integrationName
						? `/${encodeURIComponent(data.integrationName)}`
						: '')
		const params = new URLSearchParams()
		if (data.name) params.set('name', data.name)
		if (data.packageId) params.set('package_id', data.packageId)
		const search = params.size ? `?${params}` : ''
		const { bindings, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'integrations',
			returnTo: pathname + search,
		})
		const payload = await loadAccountIntegrationsData(bindings, user, {
			waitUntil,
			approvalName: data.name,
			approvalPackageId: data.packageId,
		})
		return {
			payload,
			head: loadDocumentHead(
				'orgIntegrations',
				pathname,
				{ accountIntegrations: payload },
				search,
			),
		}
	})
