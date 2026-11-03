import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	collectUserSecretRefsFromPackageSource,
	toSecretMountsFromUserRefs,
} from './collect-package-secret-refs.ts'
import { buildSecretPackageBulkApprovalUrlIfNeeded } from './package-approval-url.ts'
import { findMissingPackageApprovals } from './package-access.ts'
import type { SecretScope } from './types.ts'

export type PendingPackageSecretApproval = {
	secret_name: string
	approval_url: string
}

export type PendingPackageSecretApprovalsSummary = {
	package_id: string
	kody_id: string
	slug: string
	secrets: Array<PendingPackageSecretApproval>
	bulk_approval_url: string | null
}

export async function buildPendingPackageSecretApprovalsSummary(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	packageId: string
	kodyId: string
	orgSlug?: string | null
	secretMounts?: Record<
		string,
		{
			name: string
			scope?: SecretScope
		}
	> | null
	files?: Record<string, string> | null
	storageContext?: McpCallerContext['storageContext']
}): Promise<PendingPackageSecretApprovalsSummary | null> {
	const refs = collectUserSecretRefsFromPackageSource({
		secretMounts: input.secretMounts,
		files: input.files,
	})
	if (refs.length === 0) return null

	const storageContext = {
		sessionId: input.storageContext?.sessionId ?? null,
		appId: input.storageContext?.appId ?? null,
		packageId: input.storageContext?.packageId ?? input.packageId,
		storageId: input.storageContext?.storageId ?? null,
	}
	const missing = await findMissingPackageApprovals({
		env: input.env,
		baseUrl: input.baseUrl,
		orgSlug: input.orgSlug,
		userId: input.userId,
		packageId: input.packageId,
		mounts: toSecretMountsFromUserRefs(refs),
		storageContext,
	})
	if (missing.length === 0) return null

	const secrets = missing.map((entry) => ({
		secret_name: entry.secretName,
		approval_url: entry.approvalUrl,
	}))
	const firstApprovalUrl = missing[0]?.approvalUrl?.trim() ?? ''
	const orgSlug = firstApprovalUrl
		? (() => {
				try {
					return (
						/^\/@([^/]+)\/-\/secrets(?:\/|$)/.exec(
							new URL(firstApprovalUrl).pathname,
						)?.[1] ?? null
					)
				} catch {
					return null
				}
			})()
		: null
	return {
		package_id: input.packageId,
		kody_id: input.kodyId,
		slug: input.kodyId,
		secrets,
		bulk_approval_url:
			orgSlug == null
				? null
				: buildSecretPackageBulkApprovalUrlIfNeeded({
						baseUrl: input.baseUrl,
						orgSlug,
						packageId: input.packageId,
						kodyId: input.kodyId,
						names: secrets.map((secret) => secret.secret_name),
					}),
	}
}

export function formatPendingPackageSecretApprovalsGuidance(
	summary: PendingPackageSecretApprovalsSummary,
) {
	const preferredUrl =
		summary.bulk_approval_url ?? summary.secrets[0]?.approval_url ?? null
	if (!preferredUrl) return ''
	const adoptOption = `either review the forked package source and call \`communityForkAdopt\` for a website adoption link the user must open to adopt it (user-secret read/use then works like a self-authored package), or`
	if (summary.secrets.length === 1) {
		return `Before treating this community-forked package as ready to run, ${adoptOption} send the user this package secret approval link and wait for approval: ${preferredUrl}. An ad hoc execute smoke test does not grant package secret access.`
	}
	return `Before treating this community-forked package as ready to run, ${adoptOption} send the user this bulk package secret approval link (one click for all listed secrets) and wait for approval: ${preferredUrl}. An ad hoc execute smoke test does not grant package secret access.`
}
