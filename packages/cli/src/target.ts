/**
 * Shared `--target prod|mock` for `dev`, `execute`, `invoke`, and `search`.
 *
 * Defaults (Kent-approved design 2026-10-13):
 * - `kody dev` → `mock` (safe iteration; unpublished code never touches real secrets)
 * - `execute` / `search` (and invoke via execute) → `prod` (preserve existing behavior)
 *
 * Override with `--target` or `KODY_TARGET`.
 */

export const targetEnvVar = 'KODY_TARGET'

export type KodyTarget = 'prod' | 'mock'

export type TargetAwareCommand = 'dev' | 'execute' | 'search' | 'whoami'

/** Default target when neither flag nor env is set. */
export function defaultTargetFor(command: TargetAwareCommand): KodyTarget {
	switch (command) {
		case 'dev':
			return 'mock'
		case 'execute':
		case 'search':
		case 'whoami':
			return 'prod'
		default: {
			const exhaustive: never = command
			throw new Error(
				`Unhandled command for target default: ${String(exhaustive)}`,
			)
		}
	}
}

/**
 * Resolve the active target. Precedence: `--target` flag → `KODY_TARGET` → command default.
 * When `env` is omitted, reads `process.env` so `KODY_TARGET` works without every
 * caller threading the environment (CLI dispatch omits `env`).
 */
export function resolveTarget(input: {
	command: TargetAwareCommand
	flag?: string
	env?: NodeJS.ProcessEnv
}): KodyTarget {
	const env = input.env ?? process.env
	const raw = input.flag ?? env[targetEnvVar]
	if (raw === undefined || raw === '') {
		return defaultTargetFor(input.command)
	}
	return parseTargetFlag(raw)
}

export function parseTargetFlag(value: string): KodyTarget {
	const normalized = value.trim().toLowerCase()
	if (normalized === 'prod' || normalized === 'mock') return normalized
	throw new Error(
		`\`--target\` must be \`prod\` or \`mock\` (got ${JSON.stringify(value)}). Example: \`kody execute --target mock --local --code '…'\`.`,
	)
}
