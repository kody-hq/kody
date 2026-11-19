import {
	normalizeAllowedStringList,
	parseAllowedStringList,
} from './allowed-string-list.ts'

const compareAllowedPackages = (left: string, right: string) =>
	left.localeCompare(right)

export function normalizeAllowedPackages(input: Array<string>) {
	return normalizeAllowedStringList({
		values: input,
		normalizeEntry: (value) => value.trim(),
		compare: compareAllowedPackages,
	})
}

export function parseAllowedPackages(value: string | null | undefined) {
	return parseAllowedStringList(value, normalizeAllowedPackages)
}

export function stringifyAllowedPackages(input: Array<string>) {
	return JSON.stringify(normalizeAllowedPackages(input))
}

export type PackageLockOutcome =
	| 'locked'
	| 'already_granted'
	| 'approval_required'

/**
 * Decides what an agent's package lock request may do. Locking a resource
 * that any context can use to its first package only narrows access, so it
 * applies. Adding a package to an existing lock widens access, so it never
 * applies: only the owner can approve it on the website.
 */
export function planPackageLock(input: {
	usageMode: 'any' | 'packages'
	allowedPackageIds: ReadonlyArray<string>
	packageId: string
}):
	| { outcome: 'locked'; allowedPackageIds: Array<string> }
	| { outcome: Exclude<PackageLockOutcome, 'locked'> } {
	if (input.usageMode === 'any') {
		return {
			outcome: 'locked',
			allowedPackageIds: normalizeAllowedPackages([input.packageId]),
		}
	}
	return input.allowedPackageIds.includes(input.packageId)
		? { outcome: 'already_granted' }
		: { outcome: 'approval_required' }
}

export function createPackageLockMessage(input: {
	outcome: PackageLockOutcome
	resource: string
	packageName: string
	approvalUrl: string
}) {
	switch (input.outcome) {
		case 'locked':
			return `Locked ${input.resource} to package "${input.packageName}". Adding another package later needs the account owner's approval on the website.`
		case 'already_granted':
			return `Package "${input.packageName}" can already use ${input.resource}.`
		case 'approval_required':
			return `Agents cannot add packages to ${input.resource}. Only the account owner can grant access on the website. Send the user this approval link and wait: ${input.approvalUrl}`
	}
}
