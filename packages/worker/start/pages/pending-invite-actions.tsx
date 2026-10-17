/** @jsxImportSource @emotion/react */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter, useRouteContext } from '@tanstack/react-router'
import {
	acceptPendingInvite,
	declinePendingInvite,
	acceptPendingInviteLink,
	declinePendingInviteLink,
} from '#start/server/account-invites'
import { type AccountPendingInvite } from '#universal/loader-data.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { spacing } from '#universal/styles/tokens.ts'
import { permissionsMutationOptions } from '../permissions-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'

type PendingInviteRef = Pick<AccountPendingInvite, 'source' | 'id'>
export function usePendingInviteActions() {
	const client = useQueryClient()
	const router = useRouter()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const options = (send: typeof acceptPendingInvite) => ({
		mutationFn: ({
			invite,
		}: {
			invite: PendingInviteRef
			action: 'accept' | 'decline'
			actorKey: string | null
		}) => send({ data: { id: invite.id } }),
		...permissionsMutationOptions(client, actorKey),
	})
	const acceptInvite = useMutation(options(acceptPendingInvite))
	const declineInvite = useMutation(options(declinePendingInvite))
	const acceptLink = useMutation(options(acceptPendingInviteLink))
	const declineLink = useMutation(options(declinePendingInviteLink))
	const mutations = [acceptInvite, declineInvite, acceptLink, declineLink]
	const mutation = [...mutations].sort(
		(a, b) => b.submittedAt - a.submittedAt,
	)[0]!
	function run(invite: PendingInviteRef, action: 'accept' | 'decline') {
		if (mutations.some((operation) => operation.isPending)) return
		const active = capture()
		for (const previous of mutations) previous.reset()
		const operation =
			action === 'accept'
				? invite.source === 'link'
					? acceptLink
					: acceptInvite
				: invite.source === 'link'
					? declineLink
					: declineInvite
		operation.mutate(
			{ invite, action, actorKey },
			{
				onSuccess: (result) => {
					if (active() && action === 'accept' && result.redirectTo)
						void router.navigate({ href: result.redirectTo })
				},
			},
		)
	}
	return {
		busyKey: mutation.isPending
			? `${mutation.variables.invite.source}:${mutation.variables.invite.id}`
			: null,
		message:
			mutation.error?.message ??
			(mutation.isSuccess
				? mutation.variables.action === 'accept'
					? 'Invite accepted.'
					: 'Invite declined.'
				: null),
		tone: mutation.isError ? ('error' as const) : ('info' as const),
		accept: (invite: PendingInviteRef) => run(invite, 'accept'),
		decline: (invite: PendingInviteRef) => run(invite, 'decline'),
	}
}
export type PendingInviteActions = ReturnType<typeof usePendingInviteActions>
export function renderPendingInviteActions(
	invite: PendingInviteRef,
	actions: PendingInviteActions,
) {
	const busy = actions.busyKey === `${invite.source}:${invite.id}`
	return (
		<span
			css={{
				display: 'flex',
				flexWrap: 'wrap',
				gap: spacing.sm,
				flexShrink: 0,
			}}
		>
			<button
				type="button"
				disabled={actions.busyKey !== null}
				data-testid="pending-invite-accept"
				css={getPillButtonCss({ size: 'sm' })}
				onClick={() => actions.accept(invite)}
			>
				{busy ? 'Working…' : 'Accept'}
			</button>
			<button
				type="button"
				disabled={actions.busyKey !== null}
				data-testid="pending-invite-decline"
				css={getGhostButtonCss({ size: 'sm' })}
				onClick={() => actions.decline(invite)}
			>
				Decline
			</button>
		</span>
	)
}
