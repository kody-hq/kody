/**
 * Clipboard-only handoff for the workspace Apps empty state. Copying this
 * string runs nothing; the person pastes it into their agent.
 */
export function workspaceAppsAgentPrompt(orgSlug: string) {
	const slug = orgSlug.trim().replace(/^@/, '')
	return [
		`Build a hosted app for my Kody workspace @${slug}.`,
		'Apps are dashboards and tools your agent builds and Kody hosts in this workspace.',
		'Open search({ entity: ["guide:package_apps", "guide:package_authoring"] }) first.',
		`Concrete first win: ask to build a simple dashboard for @${slug} (for example a short status board or recent-activity view). Put it in a package with package.json#kody.app so it shows up on /@${slug}/-/apps.`,
		'Create or update the package in this workspace, save or publish it, then show me where to open the app. Explain what you will change and get my approval before publishing or deleting anything.',
	].join('\n\n')
}
