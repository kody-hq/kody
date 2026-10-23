import { getDomain } from 'tldts'
import { type PackageAppCustomHostnameDnsRecord } from '#worker/package-app-custom-hostnames/types.ts'

/**
 * One DNS record the customer must publish at their DNS provider. `name` is
 * the fully qualified record name; `relative_name` is the same name with the
 * customer's registrable domain removed (`@` for the apex), which is what most
 * provider forms expect in their Name / Host field.
 */
export type PackageAppCustomHostnameSetupRecord = {
	type: 'CNAME' | 'TXT'
	name: string
	relative_name: string
	value: string
	/** Always `dns_only`: proxied records never validate. */
	proxy: 'dns_only'
	purpose: 'routing' | 'ownership' | 'certificate'
}

/**
 * Plain-language setup a person (or agent) can follow without knowing
 * Cloudflare for SaaS. Returned by add and sync so the records stay current
 * while the hostname is pending.
 */
export type PackageAppCustomHostnameSetup = {
	records: Array<PackageAppCustomHostnameSetupRecord>
	steps: Array<string>
	provider_notes: Array<string>
}

export const packageAppCustomHostnameProviderNotes: ReadonlyArray<string> = [
	'Cloudflare DNS: set Proxy status to "DNS only" (grey cloud). A proxied (orange cloud) record never validates.',
	'GoDaddy, Namecheap, Squarespace, Porkbun, and most registrar DNS forms add your domain to the Name automatically. Enter relative_name (for example "apps" or "_cf-custom-hostname.apps"), not the full name.',
	'Route 53, Google Cloud DNS, and other zone-file style editors take the full name. Use name (a trailing dot is fine).',
	'A root domain such as example.com cannot use a plain CNAME at most providers. Use a subdomain such as apps.example.com, or a provider that supports CNAME flattening or ALIAS records.',
	'If the domain has CAA records, they must allow the certificate authorities Cloudflare uses, or the certificate cannot issue.',
]

function relativeRecordName(name: string, zone: string | null) {
	const normalized = name.trim().toLowerCase().replace(/\.+$/, '')
	if (!zone) return normalized
	if (normalized === zone) return '@'
	if (normalized.endsWith(`.${zone}`)) {
		return normalized.slice(0, -(zone.length + 1))
	}
	return normalized
}

function toSetupRecord(input: {
	type: 'CNAME' | 'TXT'
	name: string
	value: string
	purpose: PackageAppCustomHostnameSetupRecord['purpose']
	zone: string | null
}): PackageAppCustomHostnameSetupRecord {
	return {
		type: input.type,
		name: input.name,
		relative_name: relativeRecordName(input.name, input.zone),
		value: input.value,
		proxy: 'dns_only',
		purpose: input.purpose,
	}
}

/**
 * Build the exact DNS records and steps for one custom hostname. HTTP
 * certificate validation records are omitted: Cloudflare completes those
 * itself once the CNAME resolves, so the customer has nothing to publish.
 */
export function buildPackageAppCustomHostnameSetup(input: {
	hostname: string
	bindingKind: 'app' | 'org'
	cnameTarget: string | null
	/**
	 * True when Cloudflare no longer has the hostname. The local binding is
	 * stale, so the only fix is to delete it and add the hostname again.
	 */
	gone?: boolean
	ownershipVerification: PackageAppCustomHostnameDnsRecord | null
	sslValidationRecords: ReadonlyArray<PackageAppCustomHostnameDnsRecord>
}): PackageAppCustomHostnameSetup {
	const zone = getDomain(input.hostname)
	const records: Array<PackageAppCustomHostnameSetupRecord> = []
	if (input.cnameTarget) {
		records.push(
			toSetupRecord({
				type: 'CNAME',
				name: input.hostname,
				value: input.cnameTarget,
				purpose: 'routing',
				zone,
			}),
		)
	}
	const seen = new Set<string>()
	const txtCandidates: Array<{
		record: PackageAppCustomHostnameDnsRecord
		purpose: PackageAppCustomHostnameSetupRecord['purpose']
	}> = [
		...(input.ownershipVerification
			? [
					{
						record: input.ownershipVerification,
						purpose: 'ownership' as const,
					},
				]
			: []),
		...input.sslValidationRecords.map((record) => ({
			record,
			purpose: 'certificate' as const,
		})),
	]
	for (const { record, purpose } of txtCandidates) {
		if (record.type.trim().toLowerCase() !== 'txt') continue
		const key = `${record.name.toLowerCase()}\n${record.value}`
		if (seen.has(key)) continue
		seen.add(key)
		records.push(
			toSetupRecord({
				type: 'TXT',
				name: record.name,
				value: record.value,
				purpose,
				zone,
			}),
		)
	}
	const servesAt =
		input.bindingKind === 'app'
			? `the app serves at https://${input.hostname}/`
			: `your organization's private apps serve at https://${input.hostname}/packages/{kodyId}`
	if (input.gone) {
		return {
			records: [],
			steps: [
				`${input.hostname} is no longer registered with Cloudflare, so its records will never validate.`,
				'Delete this custom hostname (packageAppCustomHostnameDelete, or Remove in organization settings), then add it again to get fresh records.',
			],
			provider_notes: [...packageAppCustomHostnameProviderNotes],
		}
	}
	const providerLabel = zone ?? input.hostname
	const hasTxt = records.some((record) => record.type === 'TXT')
	const steps = [
		`Open the DNS settings for ${providerLabel} at the provider that hosts its DNS.`,
		records.length
			? `Add the ${records.length === 1 ? 'record' : `${records.length} records`} listed in records exactly as shown (type, name, value). Set every record to DNS only, with any proxy or CDN option turned off.`
			: 'Add a CNAME for the hostname pointing at the package-app domains host. Set it to DNS only, with any proxy or CDN option turned off.',
		...(input.cnameTarget
			? []
			: [
					'This environment has no routing target configured, so the routing CNAME is not listed. The hostname cannot serve traffic until a CNAME points at the package-app domains host.',
				]),
		...(hasTxt && input.cnameTarget
			? [
					`If ${input.hostname} already serves traffic somewhere else, publish the TXT records first, wait until ssl_status is "active", and only then switch the CNAME, so the move has no downtime.`,
				]
			: []),
		'Wait. Kody re-checks pending hostnames every few minutes, and most go active a few minutes after the records are published. There is no need to call sync repeatedly; call it once only if you want an immediate check.',
		`When status.state is "active" (hostname_status and ssl_status both "active"), ${servesAt} and Kody emails the owners. If it is still not active after 48 hours, Kody stops checking, marks it needs_attention with a reason, and emails the owners.`,
	]
	return {
		records,
		steps,
		provider_notes: [...packageAppCustomHostnameProviderNotes],
	}
}
