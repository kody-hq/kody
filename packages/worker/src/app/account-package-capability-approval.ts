import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	packageMutationResult,
	type PackageMutationResult,
} from './package-mutation-result.ts'
import {
	type AuthenticatedAppUser,
	type readAuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { loadWritableAccountSavedPackage } from '#app/account-package-write-access.ts'
import {
	approveCredentialNeedsRequest,
	approveWentPublicRequest,
	loadPendingPackageApprovals,
} from '#app/account-package-approval-requests.ts'
import { routes } from '#universal/routes.ts'
import {
	approvePackageCapabilitySet,
	CapabilityApprovalError,
	clearInternetVisible,
	loadCapabilityApprovalSummary,
} from '#worker/package-capabilities/capability-approval-service.ts'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import {
	applyMatchingPinInternetVisible,
	attemptSelfPublish,
} from '#worker/package-capabilities/self-publish.ts'
import {
	enqueueWentPublicApproval,
	getPendingWentPublicApproval,
} from '#worker/package-capabilities/went-public-approval.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { loadPackageSecurityAuditState } from '#worker/package-capabilities/security-audit-state.ts'
import { loadPackageSecurityAuditNextStep } from '#worker/package-capabilities/security-audit-next-step.ts'
import { type AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import { viewerCanManageSavedPackage } from '#app/package-viewer-access.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountPackageApproveCapabilitiesData(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	packageId: string
}): Promise<
	AccountPackageApproveCapabilitiesLoaderData | { ok: false; error: string }
> {
	const savedPackage = await getSavedPackageByIdInAnyOrg(
		input.env.APP_DB,
		input.packageId,
	)
	if (
		!savedPackage ||
		!(await viewerCanManageSavedPackage({
			env: input.env,
			viewer: input.user.mcpUser,
			ownerId: savedPackage.userId,
			packageId: savedPackage.id,
		}))
	) {
		return { ok: false, error: 'Package not found.' }
	}

	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		savedPackage.userId,
	)
	const username = binding?.org.slug ?? input.user.username
	const summary = await loadCapabilityApprovalSummary({
		env: input.env,
		ownerUserId: savedPackage.userId,
		savedPackage,
		requestUrl: input.request.url,
	})

	const packageHref = routes.communityPackage.href({
		username,
		kodyId: savedPackage.kodyId,
	})
	const settingsHref = routes.communityPackageSettings.href({
		username,
		kodyId: savedPackage.kodyId,
	})
	const approveHref = routes.communityPackageApproveCapabilities.href({
		username,
		kodyId: savedPackage.kodyId,
	})

	const [pendingApprovals, securityAudit] = await Promise.all([
		loadPendingPackageApprovals({
			env: input.env,
			ownerUserId: savedPackage.userId,
			packageId: savedPackage.id,
			publishedCommit: summary.publishedCommit,
		}),
		loadPackageSecurityAuditState({
			db: input.env.APP_DB,
			ownerUserId: savedPackage.userId,
			packageId: savedPackage.id,
			packageName: savedPackage.name,
			publishedCommit: summary.publishedCommit,
			fingerprint: summary.capabilitySet.fingerprint,
			approvalUrl: buildPackageCapabilityApprovalUrl({
				baseUrl: new URL(input.request.url).origin,
				username,
				kodyId: savedPackage.kodyId,
			}),
		}),
	])

	// A pending went_public request means the owner asked to go public. One
	// Approve always covers that request: when the capability set still needs
	// approval it records both; when the set already matches it only turns
	// internet-visible on. Leaving this null after a matching pin made the
	// main Approve re-pin capabilities and never flip internet_visible.
	const goPublicRequestId = !savedPackage.isInternetVisible
		? (pendingApprovals.find((approval) => approval.reason === 'went_public')
				?.id ?? null)
		: null

	return {
		ok: true,
		pendingApprovals,
		goPublicRequestId,
		email: input.user.email,
		package: {
			id: savedPackage.id,
			name: savedPackage.name,
			kodyId: savedPackage.kodyId,
			sourceId: savedPackage.sourceId,
			hasApp: savedPackage.hasApp,
			isInternetVisible: savedPackage.isInternetVisible,
		},
		publishedCommit: summary.publishedCommit,
		fingerprint: summary.capabilitySet.fingerprint,
		entries: summary.capabilitySet.entries,
		fingerprintMatchesApproval: summary.fingerprintMatchesApproval,
		// Timestamp for the matching fingerprint row, not the chronologically
		// latest approval (which may be a different capability set).
		latestApprovedAt: summary.matchingApproval?.approvedAt ?? null,
		securityAudit,
		settingsHref,
		packageHref,
		approveHref,
	}
}

type PackageDecisionAuditAction =
	| 'package.capabilities.approve'
	| 'package.went_public.approve'

async function auditPackageDecision(input: {
	env: Env
	user: AuthenticatedUser
	ownerUserId: string
	actorUserId: string
	savedPackage: { id: string; kodyId: string }
	action: PackageDecisionAuditAction
	result: 'success' | 'failure'
	details: Record<string, unknown>
}) {
	await logOrgAuditEvent({
		env: input.env,
		orgId: input.ownerUserId,
		action: input.action,
		result: input.result,
		actorUserId: input.actorUserId,
		actorUsername: input.user.username,
		credentialKind: 'session',
		resourceType: 'package',
		resourceId: input.savedPackage.id,
		details: {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			...input.details,
		},
	}).catch((error: unknown) => {
		console.error('Failed to audit package approval decision:', {
			packageId: input.savedPackage.id,
			action: input.action,
			error: getErrorMessage(error),
		})
	})
}

type CapabilityMutationContext = {
	env: Env
	request: Request
	user: AuthenticatedUser
	packageId: string
}
type CapabilityChange =
	| {
			action: 'set-internet-visible'
			internetVisible: boolean
			confirmName: string
	  }
	| { action: 'approve-capabilities'; fingerprint: string }
	| {
			action: 'approve-capabilities-and-go-public'
			fingerprint: string
			requestId: string
	  }
	| {
			action: 'approve-credential-needs' | 'approve-went-public'
			requestId: string
	  }
export function setAccountPackageInternetVisible(
	input: CapabilityMutationContext & {
		internetVisible: boolean
		confirmName: string
	},
) {
	return changePackageCapabilityApproval({
		...input,
		action: 'set-internet-visible',
	})
}
export function approveAccountPackageCapabilities(
	input: CapabilityMutationContext & { fingerprint: string },
) {
	return changePackageCapabilityApproval({
		...input,
		action: 'approve-capabilities',
	})
}
export function approveAccountPackageCapabilitiesAndGoPublic(
	input: CapabilityMutationContext & { fingerprint: string; requestId: string },
) {
	return changePackageCapabilityApproval({
		...input,
		action: 'approve-capabilities-and-go-public',
	})
}
export function approveAccountPackageCredentialNeeds(
	input: CapabilityMutationContext & { requestId: string },
) {
	return changePackageCapabilityApproval({
		...input,
		action: 'approve-credential-needs',
	})
}
export function approveAccountPackageWentPublic(
	input: CapabilityMutationContext & { requestId: string },
) {
	return changePackageCapabilityApproval({
		...input,
		action: 'approve-went-public',
	})
}
async function changePackageCapabilityApproval(
	input: CapabilityMutationContext & CapabilityChange,
): Promise<PackageMutationResult> {
	const action = input.action
	const packageId = input.packageId.trim()
	if (!packageId) {
		return packageMutationResult(
			{ ok: false, error: 'Package id is required.' },
			400,
		)
	}

	const resolved = await loadWritableAccountSavedPackage({
		env: input.env,
		user: input.user,
		packageId,
		permission: 'package:publish',
	})
	if (!resolved.ok)
		return packageMutationResult(
			{ ok: false, error: 'Package not found.' },
			404,
		)
	const { savedPackage, ownerUserId, actorUserId } = resolved.package

	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		ownerUserId,
	)
	const username = binding?.org.slug ?? input.user.username
	const approvalUrl = buildPackageCapabilityApprovalUrl({
		baseUrl: new URL(input.request.url).origin,
		username,
		kodyId: savedPackage.kodyId,
	})

	const audit = (
		auditAction: PackageDecisionAuditAction,
		result: 'success' | 'failure',
		details: Record<string, unknown>,
	) =>
		auditPackageDecision({
			env: input.env,
			user: input.user,
			ownerUserId,
			actorUserId,
			savedPackage,
			action: auditAction,
			result,
			details,
		})

	const approveCapabilities = async (
		expectedFingerprint: string,
		options: { enqueueWentPublic?: boolean } = {},
	) => {
		try {
			const approved = await approvePackageCapabilitySet({
				env: input.env,
				ownerUserId,
				actorUserId,
				savedPackage,
				requestUrl: input.request.url,
				expectedFingerprint,
				recordPin: true,
				...options,
			})
			await audit('package.capabilities.approve', 'success', {
				fingerprint: approved.capabilitySet.fingerprint,
				publishedCommit: approved.approval.publishedCommit,
				approvalId: approved.approval.id,
			})
			return { ok: true as const, approved }
		} catch (error) {
			if (error instanceof CapabilityApprovalError) {
				await audit('package.capabilities.approve', 'failure', {
					fingerprint: expectedFingerprint,
					error: error.message,
				})
				return {
					ok: false as const,
					response: packageMutationResult(
						{ ok: false, error: error.message, approvalUrl },
						400,
					),
				}
			}
			throw error
		}
	}

	const approveWentPublic = async (requestId: string) => {
		const approved = await approveWentPublicRequest({
			env: input.env,
			request: input.request,
			savedPackage,
			ownerUserId,
			actorUserId,
			requestId,
		})
		await audit(
			'package.went_public.approve',
			approved.ok ? 'success' : 'failure',
			approved.ok ? { requestId } : { requestId, error: approved.error },
		)
		return approved
	}

	const accepted = () => packageMutationResult({ ok: true, packageId })

	if (
		action === 'approve-credential-needs' ||
		action === 'approve-went-public' ||
		action === 'approve-capabilities-and-go-public'
	) {
		const requestId = 'requestId' in input ? input.requestId.trim() : ''
		if (!requestId) {
			return packageMutationResult(
				{ ok: false, error: 'Approval request id is required.' },
				400,
			)
		}
		if (action === 'approve-capabilities-and-go-public') {
			// A request turned off in another tab gets no pin either.
			const pending = await getPendingWentPublicApproval({
				env: input.env,
				ownerUserId,
				packageId: savedPackage.id,
			})
			if (pending?.id !== requestId) {
				return packageMutationResult(
					{
						ok: false,
						error:
							'The request to make this package internet-visible changed. Reload the page.',
						approvalUrl,
					},
					409,
				)
			}
			// One click, two decisions: the capability pin, then this exact
			// went_public request. Each keeps its own checks and audit event.
			// The pin does not enqueue, so a request turned off meanwhile stays
			// off and approving it below fails.
			const capabilities = await approveCapabilities(
				'fingerprint' in input ? input.fingerprint.trim() : '',
				{ enqueueWentPublic: false },
			)
			if (!capabilities.ok) return capabilities.response
		}
		const approved =
			action === 'approve-credential-needs'
				? await approveCredentialNeedsRequest({
						env: input.env,
						request: input.request,
						savedPackage,
						ownerUserId,
						actorUserId,
						requestId,
					})
				: await approveWentPublic(requestId)
		if (!approved.ok) {
			return packageMutationResult(
				{ ok: false, error: approved.error, approvalUrl },
				approved.status,
			)
		}
		return accepted()
	}

	if (action === 'approve-capabilities') {
		const capabilities = await approveCapabilities(
			'fingerprint' in input ? input.fingerprint.trim() : '',
		)
		if (!capabilities.ok) return capabilities.response
		return accepted()
	}

	const internetVisible =
		'internetVisible' in input && input.internetVisible === true
	const confirmName = 'confirmName' in input ? input.confirmName.trim() : ''

	if (!internetVisible) {
		if (confirmName !== savedPackage.kodyId) {
			return packageMutationResult(
				{
					ok: false,
					error: `Type the package slug "${savedPackage.kodyId}" to turn off internet-visible serving.`,
				},
				400,
			)
		}
		const changed = await clearInternetVisible({
			env: input.env,
			ownerUserId,
			packageId,
			actorUserId,
		})
		if (!changed) {
			return packageMutationResult(
				{ ok: false, error: 'Package not found.' },
				404,
			)
		}
		return accepted()
	}

	if (confirmName !== savedPackage.kodyId) {
		return packageMutationResult(
			{
				ok: false,
				error: `Type the package slug "${savedPackage.kodyId}" to continue. Review and approve the capability summary first.`,
				approvalUrl,
			},
			400,
		)
	}
	try {
		const summary = await loadCapabilityApprovalSummary({
			env: input.env,
			ownerUserId,
			savedPackage,
			requestUrl: input.request.url,
		})
		if (!summary.publishedCommit) {
			return packageMutationResult(
				{
					ok: false,
					error: 'Publish the package before making it internet-visible.',
				},
				400,
			)
		}
		// Same evaluation as packageUpdate: empty capability set + passing
		// audit self-publishes and clears a pending went_public ask.
		const selfPublishRequest = binding
			? deriveRequestContext({
					user: input.user.mcpUser,
					source: { kind: 'session' },
					orgBinding: binding,
				})
			: input.user.request
		const attempt = await attemptSelfPublish({
			env: input.env,
			request: selfPublishRequest,
			requestUrl: input.request.url,
			ownerUserId,
			actorUserId,
			savedPackage,
			summary,
		})
		if (attempt.status === 'self_published') {
			return accepted()
		}
		if (attempt.status === 'failed') {
			// Same as packageUpdate: do not recreate a went_public ask or apply
			// a matching pin after a concurrent clear superseded the request.
			const pending = await getPendingWentPublicApproval({
				env: input.env,
				ownerUserId,
				packageId: savedPackage.id,
			})
			if (!pending) {
				return packageMutationResult(
					{
						ok: false,
						error: `${attempt.error} Nothing is pending; try turning internet-visible on again.`,
						approvalUrl,
					},
					400,
				)
			}
			return packageMutationResult(
				{
					ok: false,
					error: attempt.error,
					approvalUrl,
				},
				400,
			)
		}
		if (summary.fingerprintMatchesApproval) {
			// Capability set already approved, turn internet-visible on now
			// (same as packageUpdate when the pin matches).
			const applied = await applyMatchingPinInternetVisible({
				env: input.env,
				requestUrl: input.request.url,
				ownerUserId,
				actorUserId,
				savedPackage,
				fingerprint: summary.capabilitySet.fingerprint,
			})
			if (!applied.ok) {
				await audit('package.went_public.approve', 'failure', {
					error: applied.error,
				})
				return packageMutationResult(
					{ ok: false, error: applied.error, approvalUrl },
					400,
				)
			}
			await audit('package.went_public.approve', 'success', {})
			return accepted()
		}
		// Record the ask so the approval page offers one Approve for the
		// capability set and going public together.
		await enqueueWentPublicApproval({
			env: input.env,
			ownerUserId,
			savedPackage,
			publishedCommit: summary.publishedCommit,
			fingerprint: summary.capabilitySet.fingerprint,
			requestedByUserId: actorUserId,
		})
		const securityAudit = await loadPackageSecurityAuditNextStep({
			db: input.env.APP_DB,
			ownerUserId,
			packageId: savedPackage.id,
			packageName: savedPackage.name,
			publishedCommit: summary.publishedCommit,
			fingerprint: summary.capabilitySet.fingerprint,
			approvalUrl,
		})
		const approvalStep =
			'Review the credentials and capabilities on the approval page. One Approve records them and makes this package internet-visible.'
		return packageMutationResult(
			{
				ok: false,
				error: securityAudit
					? `${approvalStep} No security audit is recorded for this version yet; the approval page has a prompt to copy for your agent.`
					: approvalStep,
				approvalUrl,
				...(securityAudit ? { securityAudit } : {}),
			},
			400,
		)
	} catch (error) {
		if (error instanceof CapabilityApprovalError) {
			return packageMutationResult(
				{ ok: false, error: error.message, approvalUrl },
				400,
			)
		}
		throw error
	}
}
