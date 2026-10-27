import {
	kodyInstanceNamePattern,
	normalizeKodyInstanceName,
} from '@kody-internal/shared/stable-name.ts'

/** Repo name rules shared with `repoCreate` (`assertValidUserRepoName`). */
export const repositoryNameHint =
	'Use lowercase letters, numbers, and dashes. Start and end with a letter or number. Up to 64 characters.'

export const repositoryNameMaxLength = 64

/** The same check `repoCreate` runs, for live feedback before submit. */
export function repositoryNameError(name: string): string | null {
	const normalized = normalizeKodyInstanceName(name)
	if (!normalized) return 'Enter a repository name.'
	if (normalized.length > repositoryNameMaxLength)
		return `Repository names can be up to ${repositoryNameMaxLength} characters.`
	if (/[^a-z0-9-]/.test(normalized))
		return 'Repository names can only use lowercase letters, numbers, and dashes.'
	if (!kodyInstanceNamePattern.test(normalized))
		return 'Repository names must start and end with a letter or number.'
	return null
}

export type RepositoryOwnerOption = {
	slug: string
	displayName: string | null
	personal: boolean
}

export type RepositoryCreateOptions = {
	ok: true
	owners: Array<RepositoryOwnerOption>
}

export type RepositoryCreated = {
	ok: true
	owner: string
	name: string
	personal: boolean
	repositoryHref: string
	cloneUrl: string
	prompt: string
}

type RepositoryCreateRefused = {
	ok: false
	error: string
	field: 'name' | 'owner' | null
}

export type RepositoryCreateResult = RepositoryCreated | RepositoryCreateRefused

/**
 * What the new-repository page hands to the user's agent. Generic on
 * purpose: it names the repo, the real clone and CLI commands, the MCP
 * lane, and asks what to build. No tokens; the agent signs in itself.
 */
export function buildRepositoryStartPrompt(input: {
	origin: string
	owner: string
	name: string
	personal: boolean
}): string {
	const ref = `@${input.owner}/${input.name}`
	const cloneUrl = repositoryCloneUrl(input)
	const org = input.personal ? '' : ` --org ${input.owner}`
	const mcpOrg = input.personal
		? ''
		: ` connected to @${input.owner} (\`${new URL('/mcp', input.origin).href}?org=${input.owner}\`)`
	return [
		`You're working in my Kody repository ${ref}. It's new, empty, and private.`,
		'',
		'With a shell and git (Node 22 or newer):',
		`1. Sign in with \`npx @kodycodes/cli@latest login${org}\`, then run \`npx @kodycodes/cli@latest auth setup-git\` once so git can use my Kody credentials.`,
		`2. Clone it: \`git clone ${cloneUrl}\``,
		'3. Commit and `git push` to `main`. Pushes go live right away; there is no publish step for a plain repo.',
		`4. If this becomes a Kody package (a root package.json with a \`kody\` section), run \`npx @kodycodes/cli@latest dev check\` before you push, then turn it into a package with \`repoPromoteToPackage\` and publish later changes with \`npx @kodycodes/cli@latest package publish ${ref}${org}\`.`,
		'',
		`Without a shell, use the Kody MCP server${mcpOrg}: open a session with \`repoOpenSession\` and \`target: { kind: "repo", name: "${input.name}" }\`, edit files there, then save with \`repoPublishSession\`.`,
		'',
		"If I haven't told you what to build yet, ask me before you write any code.",
	].join('\n')
}

export function repositoryCloneUrl(input: {
	origin: string
	owner: string
	name: string
}) {
	return `${new URL(input.origin).origin}/@${input.owner}/${input.name}.git`
}
