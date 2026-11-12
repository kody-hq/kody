/** @jsxImportSource @emotion/react */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import type { FileMetadata } from '#universal/files.ts'
import { workspaceDirectoryMediaType } from '#universal/workspace-page.ts'
import { fileAssetUrl } from '#universal/file-assets.ts'
import { colors } from '#universal/styles/tokens.ts'
import { SiteLink } from '../components/site-link.tsx'

import { WorkspaceEmptyFolder } from './workspace-empty-folder.tsx'

export function WorkspaceGallery({
	files,
	orgSlug,
	itemHref,
	activeId,
	onSelect,
	renderIcon,
	renderPreview,
	pointerHover = true,
}: {
	files: FileMetadata[]
	orgSlug: string
	itemHref?: (id: string) => string
	activeId?: string
	onSelect?: (id: string) => void
	renderIcon: (file: FileMetadata) => ReactNode
	renderPreview: (file: FileMetadata) => ReactNode
	pointerHover?: boolean
}) {
	const [selectedId, setSelectedId] = useState(activeId)
	const [previousActive, setPreviousActive] = useState(activeId)
	const requestedSelection = useRef(activeId)
	if (previousActive !== activeId) {
		setPreviousActive(activeId)
		requestedSelection.current = activeId
		setSelectedId(activeId)
	}
	const strip = useRef<HTMLDivElement>(null)
	const pendingFocus = useRef<string | null>(null)
	const selectedIndex = files.findIndex((file) => file.id === selectedId)
	const selected = selectedIndex >= 0 ? files[selectedIndex] : undefined
	const virtual = useVirtualizer({
		count: files.length,
		horizontal: true,
		getScrollElement: () => strip.current,
		estimateSize: () => 104,
		getItemKey: (index) => files[index]!.id,
		overscan: 5,
		initialRect: { width: 1000, height: 120 },
		rangeExtractor: (range) =>
			[
				...new Set([
					...defaultRangeExtractor(range),
					...(selectedIndex >= 0 ? [selectedIndex] : []),
				]),
			].sort((a, b) => a - b),
	})
	useLayoutEffect(() => {
		if (selectedIndex >= 0)
			virtual.scrollToIndex(selectedIndex, { align: 'auto' })
	}, [selectedIndex, virtual])
	useLayoutEffect(() => {
		if (!strip.current || selectedIndex < 0) return
		const observer = new ResizeObserver(() =>
			virtual.scrollToIndex(selectedIndex, { align: 'auto' }),
		)
		observer.observe(strip.current)
		return () => observer.disconnect()
	}, [selectedIndex, virtual])

	useLayoutEffect(() => {
		if (!pendingFocus.current) return
		const item = strip.current?.querySelector<HTMLElement>(
			`[data-browser-item="${CSS.escape(pendingFocus.current)}"]`,
		)
		if (item) {
			pendingFocus.current = null
			item.focus({ preventScroll: true })
		}
	})
	function select(file: FileMetadata) {
		if (requestedSelection.current === file.id) return
		requestedSelection.current = file.id
		setSelectedId(file.id)
		onSelect?.(file.id)
	}
	if (!files.length) return <WorkspaceEmptyFolder />
	return (
		<section
			aria-label="Workspace gallery"
			css={{
				display: 'flex',
				flexDirection: 'column',
				minHeight: 0,
				minWidth: 0,
				flex: 1,
				marginInline: 'calc(-1 * var(--workspace-panel-gutter, 0px))',
			}}
		>
			<div
				aria-label={
					selected ? `Gallery preview ${selected.name}` : 'Gallery preview'
				}
				data-workspace-item={selected?.id}
				css={{
					display: 'flex',
					flexDirection: 'column',
					flex: 1,
					minHeight: 0,
					overflow: 'hidden',
					background: colors.background,
				}}
			>
				{selected &&
					(selected.mediaType === workspaceDirectoryMediaType ? (
						<SiteLink
							href={
								itemHref?.(selected.id) ??
								`/@${orgSlug}/-/files?file=${selected.id}`
							}
							css={{
								display: 'flex',
								flex: 1,
								flexDirection: 'column',
								alignItems: 'center',
								justifyContent: 'center',
								gap: 16,
								color: colors.text,
								textDecoration: 'none',
								'& svg': { width: 72, height: 72 },
							}}
						>
							{renderIcon(selected)}
							<span>{selected.name}</span>
						</SiteLink>
					) : (
						renderPreview(selected)
					))}
			</div>
			<div
				ref={strip}
				role="group"
				aria-label="Gallery filmstrip"
				css={{
					height: 120,
					flexShrink: 0,
					minWidth: 0,
					overflowX: 'auto',
					overflowY: 'hidden',
					borderTop: `1px solid ${colors.border}`,
					background: colors.surface,
				}}
				onKeyDownCapture={(event) => {
					if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
						return
					const item = (event.target as Element).closest<HTMLElement>(
						'[data-browser-item]',
					)
					if (
						!item ||
						!files.length ||
						!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
					)
						return
					event.preventDefault()
					event.stopPropagation()
					const index = files.findIndex(
						(file) => file.id === item.dataset.browserItem,
					)
					const next =
						event.key === 'Home'
							? 0
							: event.key === 'End'
								? files.length - 1
								: Math.max(
										0,
										Math.min(
											files.length - 1,
											index + (event.key === 'ArrowRight' ? 1 : -1),
										),
									)
					const file = files[next]!
					pendingFocus.current = file.id
					select(file)
					virtual.scrollToIndex(next, { align: 'auto' })
					const element = strip.current?.querySelector<HTMLElement>(
						`[data-browser-item="${CSS.escape(file.id)}"]`,
					)
					if (element) {
						pendingFocus.current = null
						element.focus({ preventScroll: true })
					}
				}}
			>
				<div
					css={{
						height: 104,
						width: virtual.getTotalSize(),
						minWidth: '100%',
						position: 'relative',
					}}
				>
					{virtual.getVirtualItems().map((item) => {
						const file = files[item.index]!
						const active = selectedId === file.id
						return (
							<button
								key={item.key}
								type="button"
								data-browser-item={file.id}
								data-workspace-item={file.id}
								aria-label={file.name}
								aria-pressed={active}
								title={file.name}
								tabIndex={active || (!selected && item.index === 0) ? 0 : -1}
								onFocus={() => select(file)}
								onClick={() => select(file)}
								css={{
									position: 'absolute',
									left: '50%',
									top: 8,
									transform: `translateX(${item.start + 6 - virtual.getTotalSize() / 2}px)`,
									width: 92,
									height: 96,
									padding: 5,
									display: 'flex',
									flexDirection: 'column',
									alignItems: 'center',
									gap: 5,
									font: 'inherit',
									color: colors.text,
									background: active ? colors.primarySoft : 'transparent',
									border: `1px solid ${active ? colors.primary : 'transparent'}`,
									borderRadius: 5,
									cursor: 'pointer',
									outline: 'none',
									'&:hover': pointerHover
										? {
												background: active
													? colors.primarySoft
													: colors.borderSubtle,
											}
										: {},
								}}
							>
								<span
									aria-hidden
									css={{
										height: 56,
										flexShrink: 0,
										display: 'grid',
										placeItems: 'center',
										width: '100%',
										'& svg': { width: 28, height: 28 },
									}}
								>
									{!itemHref && file.mediaType.startsWith('image/') ? (
										<img
											loading="lazy"
											src={fileAssetUrl(orgSlug, file.id, file.revisionId)}
											alt=""
											css={{
												maxWidth: '100%',
												maxHeight: 56,
												objectFit: 'contain',
											}}
										/>
									) : (
										renderIcon(file)
									)}
								</span>
								<span
									css={{
										width: '100%',
										fontSize: 10,
										lineHeight: 1.3,
										display: '-webkit-box',
										WebkitLineClamp: 2,
										WebkitBoxOrient: 'vertical',
										overflow: 'hidden',
										overflowWrap: 'anywhere',
									}}
								>
									{file.name}
								</span>
							</button>
						)
					})}
				</div>
			</div>
		</section>
	)
}
