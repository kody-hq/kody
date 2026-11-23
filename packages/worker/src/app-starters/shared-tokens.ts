/**
 * CSS custom properties every starter defines in its theme tokens file, for
 * light and dark, so agents can restyle any starter with the same names.
 */
export const sharedAppTokenNames = [
	'--color-bg',
	'--color-surface',
	'--color-text',
	'--color-text-muted',
	'--color-border',
	'--color-primary',
	'--color-on-primary',
	'--color-danger',
	'--font-sans',
	'--radius',
	'--space-1',
	'--space-2',
	'--space-3',
	'--space-4',
] as const

/** Shared names the stylesheet never declares, and whether it styles dark mode. */
export function readSharedTokenUsage(css: string) {
	const declared = new Set(
		[...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) =>
			match[1]!.toLowerCase(),
		),
	)
	return {
		missing: sharedAppTokenNames.filter((name) => !declared.has(name)),
		hasDark:
			/prefers-color-scheme:\s*dark|data-theme\s*=\s*["']?dark|\.dark(?![\w-])|light-dark\(/i.test(
				css,
			),
	}
}
