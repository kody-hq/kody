import { type PackageSecurityAuditNextStep } from '../package-capabilities/security-audit-next-step.ts'
import { type RepoSessionCheckStatus } from '../repo/types.ts'
import { type AccountPackageListingBehindHint } from '#universal/loader-data.ts'
export type PackageMutationPayload = {
	ok: boolean
	error?: string
	approvalUrl?: string
	securityAudit?: PackageSecurityAuditNextStep
	deleted?: boolean
	packageId?: string
	listing?: AccountPackageListingBehindHint | null
	secret_mount_compat?: string | null
	failed_checks?: NonNullable<RepoSessionCheckStatus['results']>
}
export function packageMutationResult(
	data: PackageMutationPayload,
	status = 200,
) {
	return { data, status }
}
export type PackageMutationResult = ReturnType<typeof packageMutationResult>
