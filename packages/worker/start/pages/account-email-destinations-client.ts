import {
	addEmailDestination,
	resendEmailDestination,
	setDefaultEmailDestination,
	removeEmailDestination,
} from '#start/server/account-mutations'
import { type AccountEmailDestinationsLoaderData } from '#universal/loader-data.ts'
import {
	useMutation,
	useMutationState,
	useQueryClient,
} from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { emailDestinationMutationOptions } from './email-destination-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'

export function useAccountEmailDestinations(
	payload: AccountEmailDestinationsLoaderData,
	actorKey: string | null,
) {
	const client = useQueryClient()
	const [draftEmail, setDraftEmail] = useState('')
	const [message, setMessage] = useState<string | null>(null)
	const [tone, setTone] = useState<'error' | 'info'>('info')
	const pendingWrites = useMutationState({
		filters: {
			mutationKey: ['email-destination-write', actorKey],
			status: 'pending',
		},
		select: (entry) =>
			entry.state.variables as { data: { destinationId?: string } } | undefined,
	})
	const busy = pendingWrites.length > 0
	const capture = useSubmitterScope()
	const options = emailDestinationMutationOptions(client, actorKey)
	const addMutation = useMutation({
		...options,
		mutationFn: addEmailDestination,
	})
	const resendMutation = useMutation({
		...options,
		mutationFn: resendEmailDestination,
	})
	const defaultMutation = useMutation({
		...options,
		mutationFn: setDefaultEmailDestination,
	})
	const removeMutation = useMutation({
		...options,
		mutationFn: removeEmailDestination,
	})
	function updateDraftEmail(event: FormEvent<HTMLInputElement>) {
		setDraftEmail(event.currentTarget.value)
	}
	async function run(
		write: () => Promise<{ message: string }>,
		clearDraft = false,
	) {
		if (busy) return
		const isCurrent = capture()
		setMessage(null)
		try {
			const accepted = await write()
			if (!isCurrent()) return
			if (clearDraft) setDraftEmail('')
			setMessage(accepted.message)
			setTone('info')
		} catch (error) {
			if (!isCurrent()) return
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to update email destinations.',
			)
			setTone('error')
		}
	}
	function handleAddSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		void run(
			() => addMutation.mutateAsync({ data: { email: draftEmail } }),
			true,
		)
	}
	return {
		destinations: payload.destinations,
		additionalLimit: payload.additionalLimit,
		additionalRemaining: payload.additionalRemaining,
		draftEmail,
		status: busy ? ('sending' as const) : ('idle' as const),
		message,
		tone,
		pendingId: pendingWrites[0]?.data.destinationId ?? null,
		updateDraftEmail,
		handleAddSubmit,
		resend: (id: string) =>
			void run(() =>
				resendMutation.mutateAsync({ data: { destinationId: id } }),
			),
		setDefault: (id: string) =>
			void run(() =>
				defaultMutation.mutateAsync({ data: { destinationId: id } }),
			),
		remove: (id: string) =>
			void run(() =>
				removeMutation.mutateAsync({ data: { destinationId: id } }),
			),
	}
}
