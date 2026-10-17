/** @jsxImportSource @emotion/react */
import {
	useQueryClient,
	hashKey,
	notifyManager,
	type QueryKey,
} from '@tanstack/react-query'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
	Asset,
	useTags,
	useRouter,
	useRouterState,
	isNotFound,
	type RouterManagedTag,
} from '@tanstack/react-router'
import {
	NOT_FOUND_DOCUMENT_TITLE,
	type ResolvedDocumentHead,
} from '#universal/document-head.ts'
import { documentHead } from './document-head.ts'

type PageHeadReference = {
	head?: ResolvedDocumentHead
	pageHeadQueryKey: QueryKey
}

function isPageHeadReference(value: unknown): value is PageHeadReference {
	return (
		typeof value === 'object' &&
		value !== null &&
		'pageHeadQueryKey' in value &&
		Array.isArray(value.pageHeadQueryKey)
	)
}

const unavailableHead = { title: NOT_FOUND_DOCUMENT_TITLE }

const contentNames = new Set([
	'description',
	'og:title',
	'og:description',
	'og:image',
	'og:type',
	'og:url',
	'twitter:card',
	'twitter:title',
	'twitter:description',
	'twitter:image',
])

/** Only route content tags are replaced. Router still owns assets, scripts and CSP. */
export function mergePageHeadTags(
	tags: Array<RouterManagedTag>,
	head: ResolvedDocumentHead,
	previousHead: ResolvedDocumentHead | undefined,
): Array<RouterManagedTag> {
	const previousLinks = previousHead?.links ?? []
	const retained = tags.filter((tag) => {
		if (tag.tag === 'title') return false
		if (
			tag.tag === 'meta' &&
			contentNames.has(String(tag.attrs?.name ?? tag.attrs?.property))
		)
			return false
		if (
			tag.tag === 'link' &&
			(tag.attrs?.rel === 'canonical' ||
				previousLinks.some(
					(link) =>
						link.rel === tag.attrs?.rel && link.href === tag.attrs?.href,
				))
		)
			return false
		return true
	})
	const resolved = documentHead(head)
	const content: Array<RouterManagedTag> = resolved.meta.map((meta) =>
		'title' in meta
			? { tag: 'title', children: meta.title }
			: { tag: 'meta', attrs: meta },
	)
	for (const link of resolved.links ?? []) {
		if (
			![...retained, ...content].some(
				(tag) =>
					tag.tag === 'link' &&
					tag.attrs?.rel === link.rel &&
					tag.attrs?.href === link.href,
			)
		)
			content.push({ tag: 'link', attrs: link })
	}
	return [...retained, ...content]
}

/** Subscribe to the presented page's cache without starting another request. */
export function PageHead({
	overrideHead,
}: { overrideHead?: ResolvedDocumentHead } = {}) {
	const tags = useTags()
	const unmatched = useRouterState({
		select: (state) => state.matches.some((match) => match._notFound),
	})
	const resolvedOverride =
		overrideHead ?? (unmatched ? unavailableHead : undefined)
	const reference = useRouterState({
		select: (state) => {
			const match = state.matches.at(-1)
			if (
				!match ||
				match.status !== 'success' ||
				state.matches.some(
					(item) => item.status === 'error' || item.status === 'notFound',
				)
			)
				return undefined
			return isPageHeadReference(match.loaderData)
				? match.loaderData
				: undefined
		},
	})
	return resolvedOverride ? (
		<HeadTags tags={mergePageHeadTags(tags, resolvedOverride, undefined)} />
	) : reference ? (
		<QueryPageHead reference={reference} tags={tags} />
	) : (
		<HeadTags tags={tags} />
	)
}

function QueryPageHead({
	reference,
	tags,
}: {
	reference: PageHeadReference
	tags: Array<RouterManagedTag>
}) {
	const client = useQueryClient()
	const queryKey = reference.pageHeadQueryKey
	// createPageQuery uses Query's default key hashing.
	const queryHash = hashKey(queryKey)
	const subscribe = useCallback(
		(onChange: () => void) => {
			const notify = notifyManager.batchCalls(onChange)
			return client.getQueryCache().subscribe((event) => {
				if (event.query.queryHash === queryHash) notify()
			})
		},
		[client, queryHash],
	)
	const getSnapshot = useCallback(
		() =>
			client.getQueryState<{
				head?: ResolvedDocumentHead
				pages?: Array<{ head?: ResolvedDocumentHead }>
			}>(queryKey),
		[client, queryKey],
	)
	// Reading the existing cache cannot change query options, retain an otherwise
	// unused query, or trigger transport. Start hydrates Query before rendering
	// route components, so successful SSR and hydration already have this state.
	// An absent state fails closed: GC after a denied read must not restore the
	// old loader head after the body observer has unmounted.
	const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
	const head =
		!snapshot || isNotFound(snapshot.error)
			? unavailableHead
			: (snapshot?.data?.head ?? snapshot?.data?.pages?.[0]?.head)
	const currentTags = useMemo(
		() => (head ? mergePageHeadTags(tags, head, reference.head) : tags),
		[tags, head, reference.head],
	)
	return <HeadTags tags={currentTags} />
}

function HeadTags({ tags }: { tags: Array<RouterManagedTag> }) {
	const nonce = useRouter().options.ssr?.nonce
	return (
		<>
			{tags.map((tag) => (
				<Asset
					{...tag}
					attrs={{ ...tag.attrs, nonce }}
					key={`tsr-meta-${JSON.stringify(tag)}`}
					nonce={nonce}
				/>
			))}
		</>
	)
}
