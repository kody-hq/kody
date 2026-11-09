/** @jsxImportSource @emotion/react */
import { Global } from '@emotion/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { type FileMetadata } from '#universal/files.ts'
import { colors } from '#universal/styles/tokens.ts'

type BreadcrumbEntry = Pick<FileMetadata, 'id' | 'name' | 'parentId'>

const separator = (
	<svg
		aria-hidden="true"
		width="14"
		height="14"
		viewBox="0 0 16 16"
		fill="none"
		css={{
			display: 'block',
			alignSelf: 'center',
			flexShrink: 0,
			color: colors.textMuted,
		}}
	>
		<path
			d="m6 3.5 4.5 4.5L6 12.5"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
)

export function WorkspaceBreadcrumbs({
	files,
	directory,
	orgSlug,
	itemHref,
	collection,
	rootHref = `/@${orgSlug}/-/files`,
}: {
	files: BreadcrumbEntry[]
	directory?: BreadcrumbEntry
	orgSlug: string
	rootHref?: string
	itemHref?: (id: string) => string
	collection?: { name: string; href: string }
}) {
	const ancestors: BreadcrumbEntry[] = []
	const seen = new Set<string>()
	let current = directory
	while (current && !seen.has(current.id)) {
		seen.add(current.id)
		ancestors.unshift(current)
		current = files.find((file) => file.id === current?.parentId)
	}
	const crumbs = [
		{ id: 'root', name: 'Files', href: rootHref },
		...(collection ? [{ id: 'collection', ...collection }] : []),
		...ancestors.map((file) => ({
			id: file.id,
			name: file.name,
			href: itemHref?.(file.id) ?? `/@${orgSlug}/-/files?file=${file.id}`,
		})),
	]
	const host = useRef<HTMLElement>(null)
	const measure = useRef<HTMLSpanElement>(null)
	const [start, setStart] = useState(1)
	const key = crumbs.map((crumb) => `${crumb.id}:${crumb.name}`).join('|')
	useLayoutEffect(() => {
		const element = host.current
		const sizing = measure.current
		if (!element?.parentElement || !sizing) return
		const update = () => {
			const widths = Array.from(
				sizing.children,
				(child) => child.getBoundingClientRect().width,
			)
			const budget = element.parentElement!.clientWidth * 0.5
			let first = widths.length - 1
			let used = (widths[0] ?? 0) + (widths[first] ?? 0) + 22
			while (
				first > 1 &&
				used + widths[first - 1]! + 22 + (first > 2 ? 44 : 0) <= budget
			) {
				used += widths[--first]! + 22
			}
			setStart(Math.max(1, first))
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(element.parentElement)
		observer.observe(sizing)
		return () => observer.disconnect()
	}, [key])
	const visible = [crumbs[0]!, ...crumbs.slice(start)]
	return (
		<nav
			ref={host}
			aria-label="Folder path"
			css={{
				position: 'relative',
				maxWidth: '50%',
				minWidth: 0,
				flexShrink: 1,
				fontSize: 16,
				fontWeight: 650,
				lineHeight: 1.25,
			}}
		>
			<Global
				styles={{
					'::view-transition-group(*)': {
						animationDuration: '240ms',
						animationTimingFunction: 'cubic-bezier(.2,.8,.2,1)',
					},
					'@media (prefers-reduced-motion: reduce)': {
						'::view-transition-group(*)': { animationDuration: '0s' },
					},
				}}
			/>
			<span
				ref={measure}
				aria-hidden
				css={{
					position: 'absolute',
					visibility: 'hidden',
					pointerEvents: 'none',
					whiteSpace: 'nowrap',
					display: 'flex',
				}}
			>
				{crumbs.map((crumb) => (
					<span key={crumb.id}>{crumb.name}</span>
				))}
			</span>
			<h1
				css={{
					margin: 0,
					font: 'inherit',
					display: 'flex',
					alignItems: 'baseline',
					minWidth: 0,
					gap: 8,
				}}
			>
				{visible.map((crumb, index) => (
					<span
						key={crumb.id}
						css={{
							display: 'flex',
							alignItems: 'baseline',
							gap: 8,
							minWidth: 0,
							flexShrink: index === visible.length - 1 ? 1 : 0,
						}}
					>
						{index > 0 && separator}
						{index === 1 && start > 1 && (
							<>
								<span
									title={crumbs
										.slice(1, start)
										.map((item) => item.name)
										.join(' / ')}
									css={{ color: colors.textMuted }}
								>
									…
								</span>
								{separator}
							</>
						)}
						<span
							css={{
								minWidth: 0,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
								viewTransitionName: `folder-crumb-${crumb.id}`,
							}}
						>
							{crumb.id ===
							(directory?.id ?? (collection ? 'collection' : 'root')) ? (
								<span aria-current="page" title={crumb.name}>
									{crumb.name}
								</span>
							) : crumb.href === '#' ? (
								<span>{crumb.name}</span>
							) : (
								<SiteLink
									href={crumb.href}
									css={{
										color: colors.text,
										textDecoration: 'underline',
										textUnderlineOffset: 3,
										textDecorationColor: colors.textMuted,
										'&:hover': { textDecorationColor: 'currentColor' },
									}}
								>
									{crumb.name}
								</SiteLink>
							)}
						</span>
					</span>
				))}
			</h1>
		</nav>
	)
}
