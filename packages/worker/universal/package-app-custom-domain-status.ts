/**
 * One customer-facing state for a package-app custom hostname, derived from
 * Cloudflare's hostname and certificate statuses plus Kody's own re-check
 * bookkeeping. Shared by the API, the package page, org settings, and email
 * so every surface says the same thing.
 */
export const packageAppCustomDomainStates = [
	'pending',
	'active',
	'needs_attention',
] as const

type PackageAppCustomDomainState =
	(typeof packageAppCustomDomainStates)[number]

export type PackageAppCustomDomainStatus = {
	state: PackageAppCustomDomainState
	/** Plain-language reason for `pending` and `needs_attention`; null when active. */
	reason: string | null
}

/** How long Kody keeps re-checking a hostname that has never gone active. */
export const packageAppCustomDomainCheckWindowMs = 48 * 60 * 60 * 1000

const failedHostnameStatuses: Readonly<Record<string, string>> = {
	blocked: 'Cloudflare blocked this hostname. Remove it and contact support.',
	moved:
		'The CNAME no longer points at Kody. Point it back at the routing target, DNS only.',
	deleted:
		'The hostname is no longer registered with Cloudflare. Remove it and add it again.',
	test_failed: 'Cloudflare could not verify the hostname.',
	test_blocked: 'Cloudflare blocked the hostname verification.',
}

const failedSslStatuses: Readonly<Record<string, string>> = {
	expired: 'The certificate expired.',
	deleted: 'The certificate was deleted.',
	validation_timed_out:
		'The certificate validation record was never found, so Cloudflare stopped trying.',
	issuance_timed_out: 'The certificate could not be issued in time.',
	deployment_timed_out: 'The certificate could not be deployed in time.',
	deletion_timed_out: 'The certificate could not be removed in time.',
}

export function describePackageAppCustomDomainStatus(input: {
	hostnameStatus: string
	sslStatus: string
	needsAttentionAt: string | null
	verificationErrors: ReadonlyArray<string>
}): PackageAppCustomDomainStatus {
	if (input.hostnameStatus === 'active' && input.sslStatus === 'active') {
		return { state: 'active', reason: null }
	}
	const cloudflareReason = input.verificationErrors[0]?.trim() || null
	const failedReason =
		failedHostnameStatuses[input.hostnameStatus] ??
		failedSslStatuses[input.sslStatus] ??
		null
	if (failedReason) {
		return {
			state: 'needs_attention',
			reason: cloudflareReason
				? `${failedReason} Cloudflare says: ${cloudflareReason}`
				: failedReason,
		}
	}
	const waitingOn =
		input.hostnameStatus === 'active'
			? 'the certificate validation TXT record'
			: 'the CNAME and ownership TXT records'
	if (input.needsAttentionAt) {
		return {
			state: 'needs_attention',
			reason: cloudflareReason
				? `Still not active after 48 hours. Cloudflare says: ${cloudflareReason}`
				: `Still not active after 48 hours. Cloudflare has not found ${waitingOn}. Check that each record matches exactly and is DNS only (proxy off), then sync to start checking again.`,
		}
	}
	return {
		state: 'pending',
		reason: cloudflareReason
			? `Waiting on Cloudflare: ${cloudflareReason}`
			: `Waiting for Cloudflare to find ${waitingOn}. Kody checks again every few minutes.`,
	}
}

/**
 * Minimum gap between automatic re-checks for a hostname that has never gone
 * active, by how long Kody has been checking it. `null` means the window is
 * over: stop polling and mark the hostname as needing attention. The cron
 * runs every 5 minutes, so `0` means every tick.
 */
export function packageAppCustomDomainRecheckIntervalMs(
	checkingForMs: number,
): number | null {
	if (checkingForMs < 60 * 60 * 1000) return 0
	if (checkingForMs < 6 * 60 * 60 * 1000) return 15 * 60 * 1000
	if (checkingForMs < packageAppCustomDomainCheckWindowMs) return 60 * 60 * 1000
	return null
}

/** One DNS record to publish, as shown in the UI. */
export type PackageAppCustomDomainRecordView = {
	type: 'CNAME' | 'TXT'
	name: string
	/** Name without the customer's domain (`@` for the root). */
	relativeName: string
	value: string
	purpose: 'routing' | 'ownership' | 'certificate'
}

/** A custom hostname as the package page and org settings render it. */
export type PackageAppCustomDomainView = {
	id: string
	hostname: string
	bindingKind: 'app' | 'org'
	status: PackageAppCustomDomainStatus
	/** Records to publish; the UI only shows them while not active. */
	records: Array<PackageAppCustomDomainRecordView>
	verifiedAt: string | null
	/** Last time Kody (or a sync) read status from Cloudflare. */
	lastCheckedAt: string
}
