import { type PageOrgScope } from '../page-query-scope.ts'
import { type QueryClient } from '@tanstack/react-query'
import { type AccountEmailLoaderData } from '#universal/loader-data.ts'
import {
	emailKeys,
	type EmailListData,
	type EmailDetail,
} from './email-resources.ts'

export type EmailMutationOutcome = {
	ok: true
	messageId: string
	classification?: 'accepted' | 'quarantined'
}

export type EmailAction = {
	orgSlug: string | null
	messageId: string
} & (
	| { action: 'classify'; classification: 'accepted' | 'quarantined' }
	| { action: 'delete' }
)

/** Update known rows only. A newly matching filtered page needs its ordered,
 * paginated server result; guessing an insertion can duplicate or skip rows. */
export function optimisticEmail(
	payload: AccountEmailLoaderData,
	action: EmailAction,
): AccountEmailLoaderData {
	if (action.action === 'delete') return payload
	const patch = {
		classification: action.classification,
		classification_reason:
			action.classification === 'quarantined' ? 'Reclassified by user.' : null,
	}
	const removesRow =
		payload.classification !== null &&
		payload.classification !== action.classification
	const hadRow = payload.messages.some(
		(message) => message.id === action.messageId,
	)
	return {
		...payload,
		messages: payload.messages.flatMap((message) =>
			message.id !== action.messageId
				? [message]
				: removesRow
					? []
					: [{ ...message, ...patch }],
		),
		total:
			removesRow && hadRow ? Math.max(0, payload.total - 1) : payload.total,
		// Selection is independent of list filters on the server too.
		selectedMessage:
			payload.selectedMessage?.id === action.messageId
				? { ...payload.selectedMessage, ...patch }
				: payload.selectedMessage,
	}
}

/** Navigations share these promises with ensureQueryData. Email reads do not
 * wait for mutations, so let their first result settle before confirming it. */
async function finishUncachedEmailReads(
	client: QueryClient,
	actorKey: string | null,
	org: string | null,
) {
	const pending = client
		.getQueryCache()
		.findAll({ queryKey: emailKeys.all(actorKey, org) })
		.filter(
			(query) =>
				query.state.data === undefined &&
				query.state.fetchStatus === 'fetching',
		)
		.map((query) => query.promise)
	await Promise.allSettled(pending)
}

/** Apply the accepted entity change without replacing unrelated cached rows. */
export async function publishEmailResponse(
	client: QueryClient,
	actorKey: string | null,
	accepted: EmailMutationOutcome,
	action: EmailAction,
) {
	if (accepted.messageId !== action.messageId)
		throw new Error('Email mutation returned a different message.')
	const org = action.orgSlug
	await finishUncachedEmailReads(client, actorKey, org)
	await client.cancelQueries({
		queryKey: emailKeys.all(actorKey, org),
		predicate: (query) => query.state.data !== undefined,
	})
	client.setQueriesData<EmailListData>(
		{ queryKey: emailKeys.lists(actorKey, org) },
		(data) => {
			if (!data) return data
			const patched = optimisticEmail(
				{ ...data, selectedMessage: null },
				action,
			)
			const { selectedMessage: _selection, ...list } = patched
			if (action.action !== 'delete') return list
			return {
				...list,
				messages: list.messages.filter(
					(message) => message.id !== action.messageId,
				),
				total: list.messages.some((message) => message.id === action.messageId)
					? Math.max(0, list.total - 1)
					: list.total,
			}
		},
	)
	const key = emailKeys.detail(actorKey, org, action.messageId)
	if (action.action === 'delete') client.setQueryData(key, null)
	else
		client.setQueryData<EmailDetail>(key, (detail) =>
			detail
				? {
						...detail,
						classification: action.classification,
						classification_reason:
							action.classification === 'quarantined'
								? 'Reclassified by user.'
								: null,
					}
				: detail,
		)
}

export function emailMutationOptions<TAction extends EmailAction = EmailAction>(
	client: QueryClient,
	actorKey: string | null,
	send: (action: TAction) => Promise<EmailMutationOutcome>,
	scope: PageOrgScope = { orgSlug: null },
) {
	const org = scope.orgSlug
	return {
		mutationKey: emailKeys.mutations(actorKey, org),
		mutationFn: send,
		onSuccess: (accepted: EmailMutationOutcome, action: TAction) =>
			publishEmailResponse(client, actorKey, accepted, action),
		// Also reconcile a lost response: the server may have committed. Query
		// reads never wait for writes, and the mutation-state overlay remains
		// visible until this confirming read completes, even after unmount.
		onSettled: async (_data: unknown, _error: unknown, action: TAction) => {
			await finishUncachedEmailReads(client, actorKey, action.orgSlug)
			await client.invalidateQueries({
				queryKey: emailKeys.all(actorKey, action.orgSlug),
				refetchType: 'all',
			})
		},
	}
}
