import { useMutationState } from '@tanstack/react-query'
import { type ProfileVisibility } from '#universal/loader-data.ts'
type ProfileEdit = {
	displayName: string
	bio: string
	profileVisibility: ProfileVisibility
}
export function usePendingProfile(actorKey: string | null) {
	const changes = useMutationState({
		filters: { mutationKey: ['profile', actorKey], status: 'pending' },
		select: (mutation) =>
			(mutation.state.variables as { data: ProfileEdit } | undefined)?.data,
	})
	return changes.at(-1)
}
