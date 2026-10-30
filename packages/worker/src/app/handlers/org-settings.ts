import { operationResult } from '../operation-result.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
	type ManagedOrg,
} from '#app/org-management-access.ts'
import { processUserAvatar } from '#worker/community/avatar.ts'
import {
	buildOrgAvatarUrl,
	deleteOrgAvatar,
	saveOrgAvatar,
} from '#worker/orgs/org-avatar.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { updateOrgProfile } from '#worker/orgs/org-profile.ts'
import {
	loadOrgProfileVisibility,
	type OrgProfileVisibility,
} from '#worker/orgs/org-public-profile.ts'
import { softDeleteOrg } from '#worker/orgs/soft-delete.ts'
import { type OrgSettingsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { packageAppCustomDomainsCnameTargetFromBaseUrl } from '#worker/package-app-custom-hostnames/cname-target.ts'
import {
	addPackageAppCustomHostname,
	deletePackageAppCustomHostname,
	listPackageAppCustomHostnames,
	orgPlanAllowsCustomDomains,
	PackageAppCustomHostnameError,
	packageAppCustomDomainRecordViews,
	syncPackageAppCustomHostname,
} from '#worker/package-app-custom-hostnames/service.ts'

async function loadCustomDomainsView(
	env: Env,
	orgId: string,
): Promise<OrgSettingsLoaderData['customDomains']> {
	try {
		const listed = await listPackageAppCustomHostnames({ env, orgId })
		return {
			canAdd: await orgPlanAllowsCustomDomains(env.APP_DB, orgId),
			dnsTarget: packageAppCustomDomainsCnameTargetFromBaseUrl(
				env.PACKAGE_APP_BASE_URL,
			),
			hostnames: listed.hostnames.map((row) => ({
				id: row.id,
				hostname: row.hostname,
				bindingKind: row.binding_kind,
				packageId: row.package_id,
				hostnameStatus: row.hostname_status,
				sslStatus: row.ssl_status,
				verifiedAt: row.verified_at,
				dnsMissingSince: row.dns_missing_since,
				ownershipVerification: row.verification.ownership_verification,
				sslValidationRecords: row.verification.ssl_validation_records,
				status: row.status,
				setupRecords: packageAppCustomDomainRecordViews(env, {
					hostname: row.hostname,
					ownershipVerification: row.verification.ownership_verification,
					sslValidationRecords: row.verification.ssl_validation_records,
				}),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			})),
		}
	} catch (error) {
		if (error instanceof PackageAppCustomHostnameError) {
			// Env not ready (e.g. no package-app zone) — hide the panel.
			return null
		}
		throw error
	}
}

export async function loadOrgSettingsData(input: {
	env: Env
	user: Parameters<typeof orgHasPermission>[1]
	org: ManagedOrg
}): Promise<OrgSettingsLoaderData> {
	// Signup orgs keep identity and deletion on Account pages even when
	// another owner somehow holds org:write on that org.
	const teamOrg = !input.org.personal
	const canWrite = await orgHasPermission(input.env, input.user, 'org:write')
	const canManage = teamOrg && canWrite
	return {
		ok: true,
		org: input.org,
		canManage,
		canManageDomains: canWrite,
		canDelete:
			teamOrg && (await orgHasPermission(input.env, input.user, 'org:delete')),
		profileVisibility: teamOrg
			? await loadOrgProfileVisibility(input.env.APP_DB, input.org.id)
			: null,
		customDomains: canWrite
			? await loadCustomDomainsView(input.env, input.org.id)
			: null,
	}
}

async function readFileBytes(file: File): Promise<Uint8Array> {
	return new Uint8Array(await file.arrayBuffer())
}

type OrganizationWriteContext = {
	env: Env
	request: Request
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	orgSlug?: string
}

export async function updateOrganizationProfile(
	input: OrganizationWriteContext & {
		displayName?: string
		slug?: string
		profileVisibility?: OrgProfileVisibility
	},
) {
	const { env, request, user } = input
	const access = await resolveOrgManagementAccess({
		request,
		env,
		user,
		orgSlug: input.orgSlug,
		permission: 'org:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) {
		return operationResult(
			{
				ok: false,
				error: 'Your name, photo, and handle live on your account profile.',
			},
			400,
		)
	}
	const updated = await updateOrgProfile(env.APP_DB, {
		orgId: access.org.id,
		displayName: input.displayName,
		slug: input.slug,
		profileVisibility: input.profileVisibility,
		...(input.profileVisibility === undefined
			? {}
			: { audit: orgAuditWriterFromRequest(env, user.request) }),
	})
	if (!updated.ok) {
		return operationResult({ ok: false, error: updated.error }, 400)
	}
	const next = {
		...access.org,
		slug: updated.slug,
		displayName: updated.displayName,
	}
	return operationResult({ ok: true, org: next })
}

export async function removeOrganizationPhoto(input: OrganizationWriteContext) {
	const { env, request, user } = input
	const access = await resolveOrgManagementAccess({
		request,
		env,
		user,
		orgSlug: input.orgSlug,
		permission: 'org:write',
	})
	if (!access.ok)
		return operationResult({ ok: false, error: access.error }, access.status)
	if (access.org.personal)
		return operationResult(
			{ ok: false, error: 'Your photo lives on your account profile.' },
			400,
		)
	await deleteOrgAvatar({ env, orgId: access.org.id })
	return operationResult({ ok: true, org: { ...access.org, avatarUrl: null } })
}

export async function saveOrganizationPhoto(
	input: OrganizationWriteContext & { avatar: File | null },
) {
	const { env, request, user } = input
	const access = await resolveOrgManagementAccess({
		request,
		env,
		user,
		orgSlug: input.orgSlug,
		permission: 'org:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) {
		return operationResult(
			{
				ok: false,
				error: 'Your photo lives on your account profile.',
			},
			400,
		)
	}

	const avatar = input.avatar
	if (!(avatar instanceof File) || avatar.size === 0) {
		return operationResult(
			{ ok: false, error: 'Avatar file is required.' },
			400,
		)
	}
	let sourceBytes: Uint8Array
	try {
		sourceBytes = await readFileBytes(avatar)
	} catch (error) {
		console.error('org-avatar-read-failed', error)
		return operationResult({ ok: false, error: 'Unable to read avatar.' }, 500)
	}
	let processed: ReturnType<typeof processUserAvatar>
	try {
		processed = processUserAvatar({
			contentType: avatar.type || 'application/octet-stream',
			sourceBytes,
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to process avatar.'
		return operationResult({ ok: false, error: message }, 400)
	}
	try {
		const avatarKey = await saveOrgAvatar({
			env,
			orgId: access.org.id,
			bytes: processed.bytes,
			contentType: processed.contentType,
		})
		return operationResult({
			ok: true,
			org: {
				...access.org,
				avatarUrl: buildOrgAvatarUrl({ slug: access.org.slug, avatarKey }),
			},
		})
	} catch (error) {
		console.error('org-avatar-save-failed', error)
		return operationResult({ ok: false, error: 'Unable to save avatar.' }, 500)
	}
}

export async function deleteOrganization(
	input: OrganizationWriteContext & { confirmation: string },
) {
	const { env, request, user } = input
	const access = await resolveOrgManagementAccess({
		request,
		env,
		user,
		orgSlug: input.orgSlug,
		permission: 'org:delete',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) {
		return operationResult(
			{
				ok: false,
				error:
					'Your personal organization is your account. Delete it from Account → Data & deletion.',
			},
			400,
		)
	}
	const confirmation = input.confirmation.trim()
	if (confirmation !== access.org.slug && confirmation !== 'DELETE') {
		return operationResult(
			{
				ok: false,
				error: `Type ${access.org.slug} or DELETE to confirm.`,
			},
			400,
		)
	}
	await softDeleteOrg({
		env,
		orgId: access.org.id,
		actorUserId: user.mcpUser.userId,
	})
	return operationResult({
		ok: true,
		redirectTo: routes.accountOrganizations.href(),
	})
}

async function writeOrganizationDomain(
	input: OrganizationWriteContext,
	write: (access: {
		orgId: string
		createdByUserId: string
	}) => Promise<unknown>,
) {
	const { env, request, user } = input
	const access = await resolveOrgManagementAccess({
		request,
		env,
		user,
		orgSlug: input.orgSlug,
		permission: 'org:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	try {
		await write({
			orgId: access.org.id,
			createdByUserId: user.mcpUser.userId,
		})
	} catch (error) {
		if (error instanceof PackageAppCustomHostnameError) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}
	return operationResult({ ok: true })
}

export async function addOrganizationDomain(
	input: OrganizationWriteContext & {
		hostname: string
		bindingKind: 'app' | 'org'
		packageId?: string
		sslMethod?: 'txt' | 'http'
	},
) {
	return writeOrganizationDomain(input, (access) =>
		addPackageAppCustomHostname({
			env: input.env,
			...access,
			hostname: input.hostname,
			bindingKind: input.bindingKind,
			packageId: input.packageId,
			sslMethod: input.sslMethod,
		}),
	)
}
export async function syncOrganizationDomain(
	input: OrganizationWriteContext & { hostname?: string; id?: string },
) {
	return writeOrganizationDomain(input, (access) =>
		syncPackageAppCustomHostname({
			env: input.env,
			...access,
			hostname: input.hostname,
			id: input.id,
		}),
	)
}
export async function deleteOrganizationDomain(
	input: OrganizationWriteContext & { hostname?: string; id?: string },
) {
	return writeOrganizationDomain(input, (access) =>
		deletePackageAppCustomHostname({
			env: input.env,
			...access,
			hostname: input.hostname,
			id: input.id,
		}),
	)
}
