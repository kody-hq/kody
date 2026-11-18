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

export function normalizeAllowedHosts(hosts: Array<string>): Array<string> {
	return Array.from(
		new Set(
			hosts
				.map((host) => normalizeHost(host))
				.filter((host) => host.length > 0),
		),
	).sort()
}
