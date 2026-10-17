import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadCollaboratorsScope } from '#app/handlers/package-collaborators.ts'
import {
	inviteLinkUrl,
	readInviteLinkOptions,
} from '#app/invite-link-options.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	createOrgInviteLink,
	generateInviteLinkToken,
	hashInviteLinkToken,
	isInviteLinkResourcePreset,
	listActiveOrgInviteLinks,
	revokeOrgInviteLink,
	type InviteLinkScope,
	type ListedInviteLink,
} from '#worker/orgs/invite-links.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	type PackageInviteLinksView,
	type ScopedInviteLinkView,
} from '#universal/loader-data.ts'
import { packageCollaboratorPresetLabel } from '#universal/package-collaborators.ts'

function toView(link: ListedInviteLink): Array<ScopedInviteLinkView> {
	if (link.target.kind !== 'resource') return []
	return [
		{
			id: link.id,
			label: packageCollaboratorPresetLabel(link.target.preset),
			teamId: null,
			maxUses: link.maxUses,
			useCount: link.useCount,
			expiresAt: link.expiresAt,
			createdByUsername: link.createdByUsername,
			createdByDisplayName: link.createdByDisplayName,
		},
	]
}

async function listView(
	db: D1Database,
	orgId: string,
	scope: InviteLinkScope,
): Promise<PackageInviteLinksView> {
	const links = await listActiveOrgInviteLinks(
		db,
		orgId,
		new Date().toISOString(),
		scope,
	)
	return { ok: true, links: links.flatMap(toView) }
}

type PackageInviteScope = InviteOperationContext & {
	username: string
	kodyId: string
}

/** Every operation independently verifies package:manage_access. */
async function loadPackageInviteScope({
	env,
	request,
	user,
	username,
	kodyId,
}: PackageInviteScope) {
	const loaded = await loadCollaboratorsScope({
		env,
		request,
		user,
		username: username,
		kodyId: kodyId,
	})
	if (loaded.kind === 'not_found') {
		return {
			ok: false as const,
			result: operationResult({ ok: false, error: 'Package not found.' }, 404),
		}
	}
	if (loaded.kind === 'forbidden') {
		return {
			ok: false as const,
			result: operationResult(
				{
					ok: false,
					error: 'You need Manage on this package to share it with a link.',
				},
				403,
			),
		}
	}
	const { scope } = loaded
	const linkScope: InviteLinkScope = {
		kind: 'resource',
		resourceType: 'package',
		resourceId: scope.savedPackage.id,
	}
	return { ok: true as const, scope, linkScope }
}

export async function readPackageInviteLinks(input: PackageInviteScope) {
	const loaded = await loadPackageInviteScope(input)
	if (!loaded.ok) return loaded.result
	return operationResult(
		await listView(input.env.APP_DB, loaded.scope.org.id, loaded.linkScope),
	)
}

export async function revokePackageInviteLink(
	input: PackageInviteScope & { linkId: string },
) {
	const loaded = await loadPackageInviteScope(input)
	if (!loaded.ok) return loaded.result
	const { scope, linkScope } = loaded
	const { env, user } = input
	const db = env.APP_DB
	const body = input
	const linkId = typeof body?.linkId === 'string' ? body.linkId.trim() : ''
	if (!linkId) {
		return operationResult(
			{ ok: false, error: 'An invite link is required.' },
			400,
		)
	}
	try {
		await revokeOrgInviteLink({
			db,
			orgId: scope.org.id,
			linkId,
			scope: linkScope,
			audit: orgAuditWriterFromRequest(env, user.request),
		})
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to revoke that invite link.',
			},
			400,
		)
	}
	return operationResult({ ok: true, linkId })
}

export async function createPackageInviteLink(
	input: PackageInviteScope & {
		preset: string
		maxUses?: string | number | null
		expiresInDays?: string | number | null
		allowedEmailDomains?: string | string[]
	},
) {
	const loaded = await loadPackageInviteScope(input)
	if (!loaded.ok) return loaded.result
	const { scope } = loaded
	const { env, request, user } = input
	const db = env.APP_DB
	const body = input
	if (!isInviteLinkResourcePreset(body?.preset)) {
		return operationResult(
			{ ok: false, error: 'Choose Use, Contribute, or Manage.' },
			400,
		)
	}
	const preset = body.preset
	const parsedOptions = readInviteLinkOptions(body)
	if (!parsedOptions.ok) {
		return operationResult({ ok: false, error: parsedOptions.error }, 400)
	}
	const { allowedEmailDomains, maxUses, expiresAt } = parsedOptions.options
	const token = generateInviteLinkToken()
	const tokenHash = await hashInviteLinkToken(token)
	try {
		const created = await createOrgInviteLink({
			db,
			orgId: scope.org.id,
			target: {
				kind: 'resource',
				resourceType: 'package',
				resourceId: scope.savedPackage.id,
				preset,
			},
			createdByUserId: user.mcpUser.userId,
			tokenHash,
			allowedEmailDomains,
			maxUses,
			expiresAt,
			audit: orgAuditWriterFromRequest(env, user.request),
		})
		return operationResult({
			ok: true,
			inviteLink: {
				id: created.id,
				expiresAt: created.expiresAt,
				maxUses: created.maxUses,
				preset,
				url: inviteLinkUrl(request, token),
			},
		})
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to create that invite link.',
			},
			400,
		)
	}
}

type InviteOperationContext = {
	env: Env
	request: Request
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
}
