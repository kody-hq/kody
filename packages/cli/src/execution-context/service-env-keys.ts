/** Variables kody itself writes into every service file. */
export const reservedServiceEnvKeys = [
	'PATH',
	'KODY_DAEMON_SERVICE',
	'XDG_CONFIG_HOME',
] as const

const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/
export function validateServiceEnvKey(key: string) {
	if (!envKeyPattern.test(key)) {
		throw new Error(
			`${JSON.stringify(key)} is not a valid variable name. Use letters, digits and _, not starting with a digit.`,
		)
	}
	if ((reservedServiceEnvKeys as ReadonlyArray<string>).includes(key)) {
		throw new Error(
			`${key} is set by kody in the service file and cannot be overridden.`,
		)
	}
}

export function normalizeServiceEnv(value: unknown) {
	if (value === undefined) return undefined
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const entries = Object.entries(value as Record<string, unknown>)
	if (
		!entries.every(
			([key, entry]) =>
				envKeyPattern.test(key) &&
				!(reservedServiceEnvKeys as ReadonlyArray<string>).includes(key) &&
				typeof entry === 'string',
		)
	) {
		return null
	}
	return Object.fromEntries(entries) as Record<string, string>
}
