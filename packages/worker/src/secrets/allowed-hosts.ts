import { normalizeAllowedHosts } from '#universal/allowed-hosts.ts'
import { parseAllowedStringList } from './allowed-string-list.ts'

export {
	normalizeAllowedHosts,
	normalizeHost,
} from '#universal/allowed-hosts.ts'

export function parseAllowedHosts(raw: string | null | undefined) {
	return parseAllowedStringList(raw, normalizeAllowedHosts)
}

export function stringifyAllowedHosts(hosts: Array<string>) {
	return JSON.stringify(normalizeAllowedHosts(hosts))
}
