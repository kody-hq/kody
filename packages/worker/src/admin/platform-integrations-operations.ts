import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import type { PlatformIntegrationSaveInput } from '#universal/admin-provider-mutations.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	deletePlatformOauthAppLogoAsset,
	setPlatformOauthAppLogo,
} from '#worker/integrations/platform-app-logo.ts'
import {
	deletePlatformOauthApp,
	getPlatformOauthAppBySlug,
	renamePlatformOauthApp,
	upsertPlatformOauthApp,
} from '#worker/integrations/platform-apps.ts'
import { adminOperationResult } from './operation-result.ts'

export async function saveAdminPlatformIntegration(input: {
	env: Env
	request: Request
	data: PlatformIntegrationSaveInput
}) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	const record = input.data
	const slug = record.slug.trim()
	const clientId = record.clientId.trim()
	const tokenUrl = record.tokenUrl.trim()
	const authorizeUrl = record.authorizeUrl.trim()
	const deviceAuthorizationUrl =
		typeof record.deviceAuthorizationUrl === 'string'
			? record.deviceAuthorizationUrl.trim() || null
			: (record.deviceAuthorizationUrl ?? null)
	const flow = record.flow
	if (!slug) {
		return adminOperationResult({ ok: false, error: 'Slug is required.' }, 400)
	}
	if (!clientId || !tokenUrl) {
		return adminOperationResult(
			{
				ok: false,
				error: 'Client id and token URL are required.',
			},
			400,
		)
	}
	if (flow !== 'pkce' && flow !== 'confidential' && flow !== 'device') {
		return adminOperationResult(
			{ ok: false, error: 'Invalid OAuth flow.' },
			400,
		)
	}
	if (flow !== 'device' && !authorizeUrl) {
		return adminOperationResult(
			{ ok: false, error: 'Authorize URL is required.' },
			400,
		)
	}
	if (flow === 'device' && !deviceAuthorizationUrl) {
		return adminOperationResult(
			{
				ok: false,
				error: 'Device authorization URL is required for device flow.',
			},
			400,
		)
	}
	const visibility = record.visibility

	// A changed slug renames in place first, carrying the write-only client
	// secret, logo, and user connections, then the normal upsert applies the
	// rest of the edit against the new slug. Case-only edits canonicalize to
	// the same slug and are not renames.
	const newSlug = optionalText(record.newSlug)
	const renameTo =
		newSlug &&
		canonicalIntegrationName(newSlug) !== canonicalIntegrationName(slug)
			? newSlug
			: null
	let renamedSlug: string | null = null
	try {
		if (renameTo) {
			const renamed = await renamePlatformOauthApp({
				db: input.env.APP_DB,
				env: input.env,
				slug,
				newSlug: renameTo,
			})
			renamedSlug = renamed.slug
		}
		const targetSlug = renamedSlug ?? slug
		const app = await upsertPlatformOauthApp({
			db: input.env.APP_DB,
			env: input.env,
			app: {
				slug: targetSlug,
				provider: optionalText(record.provider),
				label: optionalText(record.label),
				description: optionalText(record.description),
				clientId,
				clientSecret: optionalText(record.clientSecret),
				tokenUrl,
				authorizeUrl,
				deviceAuthorizationUrl,
				apiBaseUrl: optionalText(record.apiBaseUrl),
				flow,
				usePkce: record.usePkce,
				tokenExchangeStyle: record.tokenExchangeStyle,
				scopeSeparator: optionalText(record.scopeSeparator),
				extraAuthorizeParams: record.extraAuthorizeParams,
				allowedScopes: record.allowedScopes,
				defaultScopes: record.defaultScopes,
				requiredHosts: record.requiredHosts,
				enabled: record.enabled ?? undefined,
				visibility,
			},
		})
		const logoBase64 = record.logoBase64
		if (logoBase64 !== undefined) {
			await setPlatformOauthAppLogo({
				db: input.env.APP_DB,
				env: input.env,
				slug: app.slug,
				sourceBytes:
					typeof logoBase64 === 'string' && logoBase64.trim()
						? base64ToBytes(logoBase64.trim())
						: null,
			})
		}
	} catch (error) {
		// The rename committed before the failing step; undo it (best effort)
		// so a rejected edit never leaves the row under a half-applied slug.
		if (renamedSlug) {
			await renamePlatformOauthApp({
				db: input.env.APP_DB,
				env: input.env,
				slug: renamedSlug,
				newSlug: slug,
			}).catch(() => {})
		}
		return adminOperationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to save platform integration.',
			},
			400,
		)
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'platform_oauth_app_admin_save',
		result: 'success',
		email: actor.email,
		ip: getRequestIp(input.request) ?? undefined,
		path: '/admin/platform-integrations',
		reason: `platform_oauth_app=${slug}`,
	})
	return adminOperationResult({ ok: true as const })
}

export async function deleteAdminPlatformIntegration(input: {
	env: Env
	request: Request
	slug: string
}) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	const slug = input.slug.trim()
	if (!slug) {
		return adminOperationResult({ ok: false, error: 'Slug is required.' }, 400)
	}
	try {
		const existing = await getPlatformOauthAppBySlug({
			db: input.env.APP_DB,
			slug,
			includeDisabled: true,
		})
		const deleted = await deletePlatformOauthApp({
			db: input.env.APP_DB,
			slug,
		})
		if (!deleted) {
			return adminOperationResult(
				{ ok: false, error: 'Platform integration not found.' },
				404,
			)
		}
		await deletePlatformOauthAppLogoAsset({
			env: input.env,
			logoKey: existing?.logoKey ?? null,
		})
	} catch (error) {
		return adminOperationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to delete platform integration.',
			},
			400,
		)
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'platform_oauth_app_admin_delete',
		result: 'success',
		email: actor.email,
		ip: getRequestIp(input.request) ?? undefined,
		path: '/admin/platform-integrations',
		reason: `platform_oauth_app=${slug}`,
	})
	return adminOperationResult({ ok: true as const })
}

function optionalText(value: string | null | undefined) {
	return value === undefined ? undefined : value?.trim() || null
}
