import { useEffect } from 'react'
import { hashKey, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { isNotFound, useRouter, useRouterState } from '@tanstack/react-router'

function titleQueryKey(value: unknown): QueryKey | undefined {
	if (
		value &&
		typeof value === 'object' &&
		'pageHeadQueryKey' in value &&
		Array.isArray(value.pageHeadQueryKey)
	)
		return value.pageHeadQueryKey
	return undefined
}

/** Soft changes affect only the tab title. Route head owns every other tag. */
export function SoftPageTitle({ overrideTitle }: { overrideTitle?: string }) {
	const client = useQueryClient()
	const router = useRouter()
	const page = useRouterState({
		select: (state) => ({
			match: state.matches.at(-1),
			location: state.location,
		}),
	})
	useEffect(() => {
		const { match, location } = page
		const isCurrentPage = () =>
			router.state.location === location &&
			router.state.matches.at(-1) === match
		if (overrideTitle) {
			if (isCurrentPage()) document.title = overrideTitle
			return
		}
		if (!match || match.status !== 'success') return
		const key = titleQueryKey(match.context) ?? titleQueryKey(match.loaderData)
		if (!key) return
		const queryHash = hashKey(key)
		const update = () => {
			if (!isCurrentPage()) return
			const state = client.getQueryState<{
				head?: { title: string }
				pages?: Array<{ head?: { title: string } }>
			}>(key)
			const title = isNotFound(state?.error)
				? 'Not found'
				: (state?.data?.head?.title ?? state?.data?.pages?.[0]?.head?.title)
			if (title !== undefined) document.title = title
		}
		update()
		return client.getQueryCache().subscribe((event) => {
			if (event.query.queryHash === queryHash) update()
		})
	}, [client, router, page, overrideTitle])
	return null
}
