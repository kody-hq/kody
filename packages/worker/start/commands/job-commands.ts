import { useQueryClient } from '@tanstack/react-query'
import { runJobNow, setJobKillSwitch } from '#start/server/account-mutations'
import { Route } from '../routes/__root.tsx'
import {
	settleAccountMutation,
	jobResources,
} from '../pages/account-mutation-settlement.ts'
import { toast } from '#client/toast.ts'
import type { Command } from './model.ts'

export function useJobCommands(commands: Command[]): Command[] {
	const client = useQueryClient()
	const { actorKey } = Route.useRouteContext()
	return commands.map((command) => {
		const action = command.jobAction
		if (!action) return command
		return {
			...command,
			run: async () => {
				try {
					const data = { id: action.id, orgSlug: action.orgSlug }
					if (action.operation === 'run') await runJobNow({ data })
					else
						await setJobKillSwitch({
							data: {
								...data,
								killSwitchEnabled: action.operation === 'pause',
							},
						})
					toast.success(
						action.operation === 'run'
							? 'Job run requested'
							: action.operation === 'pause'
								? 'Job paused'
								: 'Job resumed',
					)
				} finally {
					await Promise.all([
						settleAccountMutation(client, actorKey, jobResources, {
							orgSlug: action.orgSlug,
						}),
						client.invalidateQueries({ queryKey: ['command-search'] }),
					])
				}
			},
		}
	})
}
