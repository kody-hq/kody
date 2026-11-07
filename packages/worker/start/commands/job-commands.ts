import {
	useIsMutating,
	useMutation,
	useQueryClient,
} from '@tanstack/react-query'
import { runJobNow, setJobKillSwitch } from '#start/server/account-mutations'
import { Route } from '../routes/__root.tsx'
import {
	settleAccountMutation,
	jobResources,
} from '../pages/account-mutation-settlement.ts'
import { toast } from '#client/toast.ts'
import type { Command } from './model.ts'

export function useJobCommands(
	commands: Command[],
	orgSlug: string | undefined,
): Command[] {
	const client = useQueryClient()
	const { actorKey } = Route.useRouteContext()
	const mutationKey = ['jobs', actorKey, orgSlug ?? null] as const
	const pending = useIsMutating({ mutationKey }) > 0
	const mutation = useMutation({
		mutationKey,
		retry: false,
		mutationFn: async (action: NonNullable<Command['jobAction']>) => {
			const data = { id: action.id, orgSlug: action.orgSlug }
			if (action.operation === 'run') await runJobNow({ data })
			else
				await setJobKillSwitch({
					data: { ...data, killSwitchEnabled: action.operation === 'pause' },
				})
			toast.success(
				action.operation === 'run'
					? 'Job run requested'
					: action.operation === 'pause'
						? 'Job paused'
						: 'Job resumed',
			)
		},
		onSettled: (_data, _error, action) =>
			settleAccountMutation(client, actorKey, jobResources, {
				orgSlug: action.orgSlug,
			}),
	})
	return commands
		.filter((command) => !command.jobAction || !pending)
		.map((command) => {
			const action = command.jobAction
			if (!action) return command
			return {
				...command,
				run: async () => {
					if (client.isMutating({ mutationKey }))
						throw new Error(
							'A job operation is already in progress. Try again when it finishes.',
						)
					await mutation.mutateAsync(action)
				},
			}
		})
}
