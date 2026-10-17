import { parseAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
export type ApprovalAction = 'approve' | 'reject'
export type ApprovalScope = 'session' | 'package' | 'user'

export type ApprovalView = {
	name: string
	names: Array<string>
	scope: ApprovalScope
	requestedHost: string
	requestedHosts: Array<string>
	rejectedHosts: Array<{
		host: string
		reason: 'malformed' | 'unknown_suffix'
		message: string
	}>
	currentAllowedHosts: Array<string>
	requestedPackageId: string | null
	currentAllowedPackages: Array<string>
}

export function approvalRequestedHosts(approval: ApprovalView) {
	if (approval.requestedHosts.length > 0) return approval.requestedHosts
	return approval.requestedHost ? [approval.requestedHost] : []
}

export function approvalRejectedHosts(approval: ApprovalView) {
	return approval.rejectedHosts ?? []
}

export function allowHostsButtonLabel(
	validCount: number,
	rejectedCount: number,
) {
	if (validCount <= 1) return 'Allow access'
	if (rejectedCount > 0) return `Allow ${validCount} valid hosts`
	return `Allow all ${validCount} hosts`
}

export function allowPackagesButtonLabel(secretCount: number) {
	if (secretCount <= 1) return 'Allow access'
	return `Allow all ${secretCount} secrets`
}

export function getScopeLabel(scope: ApprovalScope) {
	if (scope === 'package') return 'Package'
	if (scope === 'session') return 'Session'
	return 'User'
}
