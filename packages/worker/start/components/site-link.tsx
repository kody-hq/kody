/** @jsxImportSource @emotion/react */
import { linkNavigation } from '../link-navigation.ts'
import { createLink, useRouter, useRouterState } from '@tanstack/react-router'
import { forwardRef, type ComponentProps } from 'react'

// Router supplies aria-current="page" for exact active URLs. Section and wizard
// links can have a more specific current state, which belongs to their caller.
const RouterAnchor = createLink(
	forwardRef<
		HTMLAnchorElement,
		ComponentProps<'a'> & {
			current?: ComponentProps<'a'>['aria-current']
		}
	>(function RouterAnchor({ current, children, ...props }, ref) {
		return (
			<a {...props} ref={ref} aria-current={current ?? props['aria-current']}>
				{children}
			</a>
		)
	}),
)

/** Protocol handshakes and non-page endpoints use document navigation. */
export function SiteLink({
	href,
	children,
	preload,
	resetScroll,
	...props
}: ComponentProps<'a'> & {
	preload?: false | 'intent' | 'viewport' | 'render'
	resetScroll?: boolean
}) {
	const router = useRouter()
	const location = useRouterState({
		select: (state) => state.resolvedLocation ?? state.location,
	})
	if (
		!href?.startsWith('/') ||
		href.startsWith('//') ||
		(props.download !== undefined && props.download !== false)
	) {
		return (
			<a href={href} {...props}>
				{children}
			</a>
		)
	}
	const destination = new URL(href, 'https://kody.local')
	const navigation = linkNavigation(router, destination.pathname)
	if (navigation.reloadDocument) {
		return (
			<a href={href} {...props}>
				{children}
			</a>
		)
	}
	return (
		<RouterAnchor
			to={destination.pathname}
			search={router.options.parseSearch!(destination.search)}
			hash={destination.hash.slice(1)}
			// Filters, sorting and pagination keep the reader at the current control.
			resetScroll={
				resetScroll ??
				(location.pathname !== destination.pathname ||
					location.hash !== destination.hash.slice(1) ||
					location.searchStr === destination.search)
			}
			current={props['aria-current']}
			// Section navigation supplies its own current state for descendants.
			// Ordinary links should not mark their parent URL as the current page.
			activeOptions={{ exact: true }}
			preload={navigation.preload === false ? false : preload}
			{...props}
		>
			{children}
		</RouterAnchor>
	)
}
