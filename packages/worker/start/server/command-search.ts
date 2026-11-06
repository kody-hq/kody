import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { type Command, rankCommands } from '../commands/model.ts'

/** Reuse the page loaders' authorization, project only searchable metadata. */
export const searchCommands = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			query: z.string().max(200),
			preferredIds: z.array(z.string().max(512)).max(40).default([]),
			kind: z.enum(['repository', 'job', 'credential', 'memory', 'workflow']),
		}),
	)
	.handler(async ({ data }): Promise<Array<Omit<Command, 'run'>>> => {
		const base = `/@${data.orgSlug}/-/`
		let commands: Command[] = []
		if (data.kind === 'repository') {
			const { loadOrgRepositories } = await import('./org-management.ts')
			const result = await loadOrgRepositories({
				data: { slug: data.orgSlug, query: '' },
			})
			commands = result.packages
				.filter((item) => item.canOpenDetail !== false)
				.map((item) => ({
					id: `repository:${data.orgSlug}:${item.kodyId}`,
					title: item.name,
					subtitle: item.description,
					keywords: item.tags.join(' '),
					href: `/@${result.profile.username}/${item.kodyId}`,
					kind: 'repository',
					icon: 'box',
				}))
		} else if (data.kind === 'job') {
			const { loadJobsPage } = await import('./account-collections.ts')
			const { payload } = await loadJobsPage({
				data: { orgSlug: data.orgSlug },
			})
			commands = payload.jobs.map((item) => ({
				id: `job:${data.orgSlug}:${item.id}`,
				title: item.name,
				subtitle: `${item.packageName ?? item.packageId} · ${item.scheduleSummary}`,
				href: `${base}jobs/${encodeURIComponent(item.id)}`,
				kind: 'job',
				icon: 'briefcase',
			}))

			for (const item of payload.jobs) {
				const operation = item.killSwitchEnabled ? 'resume' : 'pause'
				const label = item.killSwitchEnabled ? 'Resume' : 'Pause'
				commands.push(
					{
						id: `run-job:${data.orgSlug}:${item.id}`,
						title: `Run ${item.name} now`,
						subtitle: item.packageName ?? item.packageId,
						kind: 'action',
						icon: 'play',
						confirm: `Run ${item.name} now? This executes the job with its saved parameters.`,
						jobAction: { id: item.id, orgSlug: data.orgSlug, operation: 'run' },
					},
					{
						id: `toggle-job:${data.orgSlug}:${item.id}`,
						title: `${label} ${item.name}`,
						subtitle: item.packageName ?? item.packageId,
						kind: 'action',
						icon: 'pause',
						confirm: `${label} scheduled runs for ${item.name}?`,
						jobAction: { id: item.id, orgSlug: data.orgSlug, operation },
					},
				)
			}
		} else if (data.kind === 'workflow') {
			const { loadWorkflowsPage } = await import('./account-collections.ts')
			const { payload } = await loadWorkflowsPage({
				data: { orgSlug: data.orgSlug },
			})
			commands = payload.workflows.map((item) => ({
				id: `workflow:${data.orgSlug}:${item.id}`,
				title: item.workflowName,
				subtitle: item.status ?? 'Pending',
				href: `${base}workflows/${encodeURIComponent(item.id)}`,
				kind: 'workflow',
				icon: 'trending-up',
			}))
		} else if (data.kind === 'credential') {
			const { loadCredentialsPage } = await import('./credentials.ts')
			const { payload } = await loadCredentialsPage({
				data: { orgSlug: data.orgSlug, create: false, search: [] },
			})
			commands = payload.credentials.map((item) => ({
				id: `credential:${data.orgSlug}:${item.id}`,
				title: item.name,
				subtitle: `${item.kind} · ${item.provider ?? item.status}`,
				href: `${base}credentials/${encodeURIComponent(item.id)}`,
				kind: 'credential',
				icon: 'key',
			}))
		} else {
			const { loadCommandMemories } = await import('./command-memories.ts')
			const memories = await loadCommandMemories(
				data.orgSlug,
				data.query,
				data.preferredIds.map((id) =>
					id.replace(`memory:${data.orgSlug}:`, ''),
				),
			)
			commands = memories.map((item) => ({
				id: `memory:${data.orgSlug}:${item.id}`,
				title: item.subject,
				subtitle: item.category ?? 'Memory',
				keywords: item.tags,
				href: `${base}memories/${encodeURIComponent(item.id)}`,
				kind: 'memory',
				icon: 'book',
			}))
		}
		return rankCommands(
			commands,
			data.query,
			Object.fromEntries(
				data.preferredIds.map((id) => [
					id,
					{ count: 0, lastUsed: 0, pinned: true },
				]),
			),
		).slice(0, 40)
	})
