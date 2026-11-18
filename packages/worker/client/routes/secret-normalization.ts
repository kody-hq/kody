export { normalizeAllowedHosts } from '#universal/allowed-hosts.ts'

/** Matches server `normalizeAllowedPackages` in `#mcp/secrets/allowed-packages.ts`. */
export function normalizeAllowedPackages(
	packages: Array<string>,
): Array<string> {
	return Array.from(
		new Set(
			packages.map((value) => value.trim()).filter((value) => value.length > 0),
		),
	).sort((left, right) => left.localeCompare(right))
}
