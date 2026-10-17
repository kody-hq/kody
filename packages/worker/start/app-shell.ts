export type AppShell = {
	mode: 'standard' | 'auth' | 'focused'
	gutters: 'app' | 'page'
	preserveLoginReturn: boolean
}

declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		shell?: Partial<AppShell>
	}
}

/** Capture the destination policy alongside root loader data so pending links
 * cannot change the shell around the still-committed page. */
export function appShellForMatches(
	matches: readonly { staticData: { shell?: Partial<AppShell> } }[],
): AppShell {
	return matches.reduce<AppShell>(
		(shell, match) => ({ ...shell, ...match.staticData.shell }),
		{ mode: 'standard', gutters: 'app', preserveLoginReturn: false },
	)
}
