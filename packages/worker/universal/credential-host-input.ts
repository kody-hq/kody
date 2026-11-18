import { normalizeAllowedHosts } from './allowed-hosts.ts'
import { classifyApprovalHosts } from './approval-host-shape.ts'

export const credentialHostsMax = 20
/** A bound on one request, above any list an existing credential holds. */
const credentialHostsInputMax = 200

export type ParsedCredentialHosts =
	| { ok: true; hosts: Array<string> }
	| { ok: false; error: string }

const otherSchemePattern = /^[a-z][a-z0-9+.-]*:\/\//

function parseCredentialHost(
	raw: string,
): { ok: true; host: string } | { ok: false; error: string } {
	const entry = raw.trim().toLowerCase()
	if (entry.startsWith('http://')) {
		return {
			ok: false,
			error: `"${raw.trim()}": Kody sends credentials only over HTTPS. Enter the host without http://.`,
		}
	}
	if (!entry.startsWith('https://') && otherSchemePattern.test(entry)) {
		return {
			ok: false,
			error: `"${raw.trim()}": enter a host name such as api.example.com.`,
		}
	}
	const host = entry.replace(/^https:\/\//, '').replace(/\/$/, '')
	if (host.includes('*')) {
		return {
			ok: false,
			error: `"${raw.trim()}": wildcards are not supported. List each host.`,
		}
	}
	if (/[:/?#@\s\\]/.test(host)) {
		return {
			ok: false,
			error: `"${raw.trim()}": enter just the host name, with no port, path, or query.`,
		}
	}
	const { valid, rejected } = classifyApprovalHosts([host])
	const accepted = valid[0]
	if (!accepted || rejected.length > 0) {
		return {
			ok: false,
			error: `"${raw.trim()}" is not a valid host name.`,
		}
	}
	if (
		accepted === 'localhost' ||
		accepted.endsWith('.localhost') ||
		/^[\d.]+$/.test(accepted) ||
		accepted.startsWith('[')
	) {
		return {
			ok: false,
			error: `"${raw.trim()}": enter a public host name, not localhost or an IP address.`,
		}
	}
	return { ok: true, host: accepted }
}

/**
 * Validates hosts typed on the website: public host names only, `https://`
 * optional, nothing that would send a credential over plain HTTP. Returns
 * the lowercased, deduplicated, sorted list.
 */
export function parseCredentialHostsInput(
	raw: ReadonlyArray<unknown>,
): ParsedCredentialHosts {
	if (raw.length > credentialHostsInputMax) {
		return { ok: false, error: 'Too many hosts in one request.' }
	}
	const hosts: Array<string> = []
	for (const value of raw) {
		if (typeof value !== 'string') {
			return { ok: false, error: 'Hosts must be text.' }
		}
		if (!value.trim()) continue
		const parsed = parseCredentialHost(value)
		if (!parsed.ok) return parsed
		hosts.push(parsed.host)
	}
	return { ok: true, hosts: normalizeAllowedHosts(hosts) }
}

/** A list that already exceeds the cap may still shrink or be saved unchanged. */
export function credentialHostsLimitError(count: number, storedCount: number) {
	return count > credentialHostsMax && count > storedCount
		? `A credential can allow at most ${credentialHostsMax} hosts.`
		: null
}
