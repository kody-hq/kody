import {
	normalizeAllowedStringList,
	parseAllowedStringList,
} from './allowed-string-list.ts'

export function normalizeHost(host: string) {
	const trimmed = host.trim().toLowerCase()
	if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
		return trimmed
	}
	try {
		return new URL(trimmed).hostname
	} catch {
		const withoutScheme = trimmed.replace(/^https?:\/\//, '')
		const slash = withoutScheme.indexOf('/')
		return slash === -1 ? withoutScheme : withoutScheme.slice(0, slash)
	}
}

export function normalizeAllowedHosts(hosts: Array<string>) {
	return normalizeAllowedStringList({
		values: hosts,
		normalizeEntry: normalizeHost,
	})
}

export function parseAllowedHosts(raw: string | null | undefined) {
	return parseAllowedStringList(raw, normalizeAllowedHosts)
}

export function stringifyAllowedHosts(hosts: Array<string>) {
	return JSON.stringify(normalizeAllowedHosts(hosts))
}
