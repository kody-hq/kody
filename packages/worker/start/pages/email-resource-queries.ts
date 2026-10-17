import {
	queryOptions,
	useSuspenseQueries,
	type QueryClient,
} from '@tanstack/react-query'
import { isNotFound } from '@tanstack/react-router'
import {
	loadEmailList,
	loadEmailDetail,
	loadEmailDestinations,
} from '#start/server/email'
import {
	emailKeys,
	type EmailResourceInput,
	type EmailListInput,
} from './email-resources.ts'

function emailListQuery(actor: string | null, input: EmailListInput) {
	return queryOptions({
		queryKey: emailKeys.list(actor, input),
		queryFn: ({ signal }) => loadEmailList({ data: input, signal }),
		staleTime: 10_000,
		meta: { actorKey: actor },
	})
}
function emailDetailQuery(
	actor: string | null,
	org: string | null,
	messageId: string | null,
) {
	return queryOptions({
		queryKey: emailKeys.detail(actor, org, messageId),
		queryFn: ({ signal }) =>
			messageId === null
				? Promise.resolve(null)
				: loadEmailDetail({ data: { org, messageId }, signal }),
		staleTime: 10_000,
		meta: { actorKey: actor },
	})
}
function emailDestinationsQuery(actor: string | null) {
	return queryOptions({
		queryKey: emailKeys.destinations(actor),
		queryFn: ({ signal }) => loadEmailDestinations({ signal }),
		staleTime: 30_000,
		meta: { actorKey: actor },
	})
}
function queries(actor: string | null, input: EmailResourceInput) {
	const { list, messageId } = input
	return [
		emailListQuery(actor, list),
		emailDetailQuery(actor, list.org, messageId),
		emailDestinationsQuery(actor),
	] as const
}
export async function loadEmailResources(
	client: QueryClient,
	actor: string | null,
	input: EmailResourceInput,
) {
	const [list, detail, destinations] = queries(actor, input)
	// Start every independent read before awaiting, including on the server.
	await Promise.all([
		client.ensureQueryData({ ...list, revalidateIfStale: true }),
		client.ensureQueryData({ ...detail, revalidateIfStale: true }),
		client.ensureQueryData({ ...destinations, revalidateIfStale: true }),
	])
}
export function useEmailResources(
	actor: string | null,
	input: EmailResourceInput,
) {
	const [list, detail, destinations] = useSuspenseQueries({
		queries: queries(actor, input),
	})
	for (const result of [list, detail, destinations])
		if (isNotFound(result.error)) throw result.error
	return {
		payload: { ...list.data, selectedMessage: detail.data },
		destinations: destinations.data,
	}
}
