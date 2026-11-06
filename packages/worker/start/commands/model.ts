import type { IconName } from '#universal/icon-names.ts'

export type Command = {
	id: string
	title: string
	subtitle?: string
	keywords?: string
	kind:
		| 'page'
		| 'workspace'
		| 'action'
		| 'repository'
		| 'job'
		| 'credential'
		| 'memory'
		| 'guide'
		| 'workflow'
	icon: IconName
	href?: string
	context?: boolean
	jobAction?: {
		id: string
		orgSlug: string
		operation: 'run' | 'pause' | 'resume'
	}
	confirm?: string
	run?: () => void | Promise<void>
}
export type CommandHistory = Record<
	string,
	{ count: number; lastUsed: number; pinned?: boolean }
>

export function parseCommandQuery(value: string) {
	const commandsOnly = value.trimStart().startsWith('>')
	const raw = value.trim().replace(/^>\s*/, '')
	const match =
		/^(pages?|workspaces?|actions?|repositories|repository|repos?|jobs?|credentials?|memories|memory|docs?|guides?|workflows?):\s*/i.exec(
			raw,
		)
	const kinds: Record<string, Command['kind']> = {
		page: 'page',
		pages: 'page',
		workspace: 'workspace',
		workspaces: 'workspace',
		action: 'action',
		actions: 'action',
		repositories: 'repository',
		repository: 'repository',
		repo: 'repository',
		repos: 'repository',
		job: 'job',
		jobs: 'job',
		credential: 'credential',
		credentials: 'credential',
		memory: 'memory',
		doc: 'guide',
		docs: 'guide',
		guide: 'guide',
		guides: 'guide',
		workflow: 'workflow',
		workflows: 'workflow',
		memories: 'memory',
	}
	return {
		text: (match ? raw.slice(match[0].length) : raw).trim(),
		kind: match ? kinds[match[1]!.toLowerCase()] : undefined,
		commandsOnly,
	}
}
function normalize(value: string) {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
}
function matchScore(text: string, query: string): number {
	if (text === query) return 180
	if (text.startsWith(query)) return 95
	if (text.split(/\W+/).some((word) => word.startsWith(query))) return 75
	if (text.includes(query)) return 60
	let cursor = -1
	let gaps = 0
	for (const character of query) {
		const next = text.indexOf(character, cursor + 1)
		if (next < 0) return 0
		gaps += next - cursor - 1
		cursor = next
	}
	return gaps > query.length * 2 ? 0 : Math.max(5, 35 - gaps)
}
export function rankCommands(
	commands: readonly Command[],
	query: string,
	history: CommandHistory,
	now = Date.now(),
) {
	const parsed = parseCommandQuery(query)
	const tokens = normalize(parsed.text).split(/\s+/).filter(Boolean)
	return commands
		.flatMap((command) => {
			if (parsed.kind && command.kind !== parsed.kind) return []
			if (
				parsed.commandsOnly &&
				!['action', 'page', 'workspace'].includes(command.kind)
			)
				return []
			const title = normalize(command.title)
			const extra = normalize(
				`${command.subtitle ?? ''} ${command.keywords ?? ''}`,
			)
			const scores = tokens.map((token) =>
				Math.max(matchScore(title, token), matchScore(extra, token) * 0.45),
			)
			if (scores.some((score) => !score)) return []
			const use = history[command.id]
			const learned = use
				? Math.min(12, Math.log2(use.count + 1) * 3) +
					Math.max(0, 8 - (now - use.lastUsed) / 86_400_000)
				: 0
			const base =
				command.kind === 'page' ? 10 : command.kind === 'guide' ? -10 : 0
			const score =
				base +
				scores.reduce((a, b) => a + b, 0) +
				learned +
				(command.context ? 10 : 0) +
				(use?.pinned ? 18 : 0)
			return [{ command, score }]
		})
		.sort(
			(a, b) =>
				b.score - a.score || a.command.title.localeCompare(b.command.title),
		)
		.map(({ command }) => command)
}
