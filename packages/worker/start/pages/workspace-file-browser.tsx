/** @jsxImportSource @emotion/react */
import { VirtualCollection } from '../components/virtual-collection.tsx'
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from 'react'
import { useRouter } from '@tanstack/react-router'
import { SiteLink } from '../components/site-link.tsx'
import { colors } from '#universal/styles/tokens.ts'
import {
	workspaceDirectoryMediaType,
	workspacePageMediaType,
	isWorkspaceContainer,
} from '#universal/workspace-page.ts'
import { fileAssetUrl } from '#universal/file-assets.ts'
import type { FileMetadata } from '#universal/files.ts'
import { WorkspaceEmptyFolder } from './workspace-empty-folder.tsx'

export type BrowserFile = FileMetadata
export const packagesFolder: BrowserFile = {
	id: 'system:packages',
	name: 'Apps & Packages',
	mediaType: workspaceDirectoryMediaType,
	revisionId: null,
	createdAt: '',
	updatedAt: '',
	revisions: [],
}
type BrowserEntry = Pick<BrowserFile, 'id' | 'parentId' | 'name' | 'mediaType'>

export function WorkspaceFileBrowser<T extends BrowserEntry>({
	files: workspaceFiles,
	rootId,
	rootLabel = 'Workspace root',
	systemFolder,
	loadingFolderId,
	focusHandoff,
	selectionKey,
	onSelectionChange,
	orgSlug,
	itemHref,
	openHref,
	onOpen,
	renderIcon,
	renderPreview,
	onDestinationChange,
	filter = 'all',
	fullPreview = false,
	pointerHover = true,
	renamingId,
	onRenameDone,
	onCommitRename,
}: {
	files: T[]
	renamingId?: string | null
	onRenameDone?: () => void
	onCommitRename?: (id: string, name: string) => Promise<boolean | undefined>
	rootId?: string
	rootLabel?: string
	systemFolder?: T
	loadingFolderId?: string
	focusHandoff?: RefObject<string | null>
	selectionKey?: string
	onSelectionChange?: (id: string | undefined) => void
	pointerHover?: boolean
	fullPreview?: boolean
	filter?: 'all' | 'pages' | 'folders' | 'files'
	orgSlug: string
	onOpen?: (file: T) => void
	openHref?: (id: string) => string
	itemHref?: (id: string) => string
	renderIcon: (file: T) => ReactNode
	renderPreview?: (file: T) => ReactNode
	onDestinationChange?: (id: string | undefined) => void
}) {
	const files =
		systemFolder && (filter === 'all' || filter === 'folders')
			? [systemFolder, ...workspaceFiles]
			: workspaceFiles
	const href = (id: string) =>
		itemHref?.(id) ??
		(id === packagesFolder.id
			? `/@${orgSlug}/-/files?collection=packages`
			: `/@${orgSlug}/-/files?file=${id}`)
	const [selection, setSelection] = useState<string[] | null>(null)
	const requested = useRef(selectionKey)
	useLayoutEffect(() => {
		if (requested.current !== selectionKey) setSelection(null)
		requested.current = selectionKey
	}, [selectionKey])
	function select(next: string[]) {
		setSelection(next)
		const id = next.at(-1)
		if (requested.current !== (id ?? 'root')) {
			requested.current = id ?? 'root'
			if (id === packagesFolder.id && systemFolder) {
				if (focusHandoff) focusHandoff.current = id
				void router.navigate({ href: href(id), resetScroll: false })
			} else onSelectionChange?.(id)
		}
	}

	const [activeColumn, setActiveColumn] = useState<number | null>(null)
	const scroller = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const id = focusHandoff?.current
		if (!focusHandoff || !id || id !== rootId) return
		const frame = requestAnimationFrame(() => {
			const item = scroller.current?.querySelector<HTMLElement>(
				`[data-browser-item="${CSS.escape(id)}"]`,
			)
			if (!item) return
			focusHandoff.current = null
			item.focus({ preventScroll: true })
		})
		return () => cancelAnimationFrame(frame)
	}, [focusHandoff, rootId])

	const router = useRouter()
	const byId = new Map(files.map((file) => [file.id, file]))
	const rootPath: T[] = []
	let ancestor = rootId ? byId.get(rootId) : undefined
	const visited = new Set<string>()
	while (ancestor && !visited.has(ancestor.id)) {
		visited.add(ancestor.id)
		rootPath.unshift(ancestor)
		ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined
	}
	const path =
		selection === null
			? rootPath
			: selection.map((id) => byId.get(id)).filter((file): file is T => !!file)

	const selected = path.at(-1)
	const pendingFolderId =
		selected &&
		(selected.id === packagesFolder.id ||
			selected.parentId === packagesFolder.id) &&
		!rootPath.some((file) => file.id === selected.id) &&
		!files.some((file) => file.parentId === selected.id)
			? selected.id
			: loadingFolderId
	const columns: Array<T | undefined> = [
		undefined,
		...path.filter(
			(file) =>
				isWorkspaceContainer(file.mediaType) &&
				(file.id === pendingFolderId ||
					files.some((child) => child.parentId === file.id)),
		),
	]
	useEffect(() => {
		onDestinationChange?.(
			selected && isWorkspaceContainer(selected.mediaType)
				? selected.id
				: selected?.parentId,
		)
	}, [selected, onDestinationChange])
	useEffect(() => {
		scroller.current?.lastElementChild?.scrollIntoView({
			block: 'nearest',
			inline: 'nearest',
			behavior: 'auto',
		})
	}, [selection])
	const choose = (column: number, file: T) => {
		const before = columns.slice(1, column + 1).map((item) => item!.id)
		const next = [...before, file.id]
		if (
			path.length !== next.length ||
			path.some((file, i) => file.id !== next[i])
		)
			select(next)
	}
	return (
		<div
			ref={scroller}
			aria-label="Browse workspace columns"
			data-file-column-browser
			onClick={(event) => {
				if (event.target !== event.currentTarget) return
				select([])
				setActiveColumn(0)
				scroller.current
					?.querySelector<HTMLElement>('nav')
					?.focus({ preventScroll: true })
			}}
			css={{
				marginInline: 'calc(-1 * var(--workspace-panel-gutter, 0px))',
				backgroundColor: `light-dark(${colors.surface}, color-mix(in srgb, ${colors.surface} 40%, ${colors.background}))`,
				display: 'flex',
				overflowX: 'auto',
				minHeight: 0,
				flex: 1,
				minWidth: 0,
				borderTop: `1px solid ${colors.border}`,
				borderBottom: `1px solid ${colors.border}`,
				scrollSnapType: 'x proximity',
				scrollBehavior: 'smooth',
				'@media(prefers-reduced-motion:reduce)': { scrollBehavior: 'auto' },
			}}
		>
			{columns.map((parent, index) => {
				const children = files
					.filter((file) =>
						parent
							? file.parentId === parent.id
							: !file.parentId || !byId.has(file.parentId),
					)
					.filter(
						(file) =>
							isWorkspaceContainer(file.mediaType) ||
							filter === 'all' ||
							filter === 'files' ||
							(filter === 'pages' && file.mediaType === workspacePageMediaType),
					)
				return (
					<nav
						key={parent?.id ?? 'root'}
						aria-label={parent?.name ?? rootLabel}
						data-upload-directory={parent?.id ?? ''}
						tabIndex={-1}
						onKeyDown={(event) => {
							if (
								event.target !== event.currentTarget ||
								event.altKey ||
								event.ctrlKey ||
								event.metaKey
							)
								return
							if (
								!['ArrowDown', 'ArrowUp', 'ArrowRight', 'Home', 'End'].includes(
									event.key,
								)
							)
								return
							event.preventDefault()
							const items = event.currentTarget.querySelectorAll<HTMLElement>(
								'[data-browser-item]',
							)
							items
								.item(
									event.key === 'ArrowUp' || event.key === 'End'
										? items.length - 1
										: 0,
								)
								?.focus()
						}}
						onClick={(event) => {
							if ((event.target as Element).closest('a,button,input,select'))
								return
							select(path.slice(0, index).map((file) => file.id))
							setActiveColumn(Math.max(0, index - 1))
							if (index === 0) {
								event.currentTarget.focus({ preventScroll: true })
								return
							}
							event.currentTarget.parentElement
								?.querySelectorAll('nav')
								.item(index - 1)
								?.querySelector<HTMLElement>('[aria-current]')
								?.focus({ preventScroll: true })
						}}
						css={{
							display: 'flex',
							flexDirection: 'column',
							flex: '0 0 220px',
							minWidth: 180,
							overflowY: 'auto',
							padding: '7px 5px',
							paddingInlineStart:
								index === 0
									? 'calc(var(--workspace-panel-gutter, 18px) - 8px)'
									: 5,
							boxSizing: 'border-box',
							borderRight: `1px solid ${colors.border}`,
							scrollSnapAlign: 'start',
						}}
					>
						<VirtualCollection
							activeKey={path[index]?.id}
							keys={children.map((file) => file.id)}
							renderItem={(itemIndex) => {
								const file = children[itemIndex]!
								return (
									<div key={file.id} css={{ position: 'relative' }}>
										<SiteLink
											key={file.id}
											data-workspace-item={file.id}
											data-system-directory={
												file.id === packagesFolder.id ? 'packages' : undefined
											}
											href={href(file.id)}
											aria-current={
												path[index]?.id === file.id ? 'true' : undefined
											}
											title={file.name}
											data-browser-item={file.id}
											onFocus={() => {
												setActiveColumn(index)
												choose(index, file)
											}}
											tabIndex={
												path[index]?.id === file.id ||
												(!path[index] && children[0]?.id === file.id)
													? 0
													: -1
											}
											onClick={(event) => {
												if (
													event.metaKey ||
													event.ctrlKey ||
													event.shiftKey ||
													event.altKey
												)
													return
												event.preventDefault()
												choose(index, file)
												setActiveColumn(index)
												event.currentTarget.focus({ preventScroll: true })
											}}
											onDoubleClick={
												onOpen
													? () => onOpen(file)
													: itemHref && !openHref
														? undefined
														: () =>
																void router.navigate({
																	href: openHref?.(file.id) ?? href(file.id),
																})
											}
											onKeyDown={(event) => {
												if (
													event.altKey ||
													event.ctrlKey ||
													event.metaKey ||
													event.shiftKey
												)
													return
												const nav = event.currentTarget.closest('nav')!
												const siblings = Array.from(
													nav.querySelectorAll<HTMLAnchorElement>(
														'[data-browser-item]',
													),
												)
												const row = siblings.indexOf(
													event.currentTarget as HTMLAnchorElement,
												)
												if (
													['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(
														event.key,
													)
												) {
													event.preventDefault()
													const next =
														event.key === 'Home'
															? 0
															: event.key === 'End'
																? siblings.length - 1
																: row + (event.key === 'ArrowDown' ? 1 : -1)
													const target =
														siblings[
															Math.max(0, Math.min(siblings.length - 1, next))
														]
													target?.click()
													target?.focus()
													return
												}
												if (
													event.key === 'ArrowRight' &&
													isWorkspaceContainer(file.mediaType)
												) {
													event.preventDefault()
													choose(index, file)
													requestAnimationFrame(() =>
														scroller.current
															?.querySelectorAll('nav')
															.item(index + 1)
															?.querySelector<HTMLElement>(
																'[data-browser-item]',
															)
															?.focus(),
													)
												}
												if (
													(event.key === 'ArrowLeft' ||
														event.key === 'Escape') &&
													index > 0
												) {
													event.preventDefault()
													select(path.slice(0, index).map((file) => file.id))
													scroller.current
														?.querySelectorAll('nav')
														.item(index - 1)
														?.querySelector<HTMLElement>('[aria-current]')
														?.focus()
												}
											}}

											css={{
												display: 'flex',
												alignItems: 'center',
												gap: 8,
												minHeight: 32,
												boxSizing: 'border-box',
												padding: '5px 8px',
												borderRadius: 5,
												color: colors.text,
												textDecoration: 'none',
												background:
													path[index]?.id === file.id
														? index === (activeColumn ?? path.length - 1)
															? colors.primarySoft
															: colors.borderSubtle
														: 'transparent',
												'&:focus, &:focus-visible': {
													outline: 'none',
													boxShadow: 'none',
												},
												'&:hover': pointerHover
													? {
															background:
																path[index]?.id === file.id
																	? index === (activeColumn ?? path.length - 1)
																		? colors.primarySoft
																		: colors.borderSubtle
																	: colors.borderSubtle,
														}
													: {},
											}}
										>
											{renderIcon(file)}
											<span
												css={{
													flex: 1,
													overflow: 'hidden',
													textOverflow: 'ellipsis',
													whiteSpace: 'nowrap',
												}}
											>
												{file.name}
											</span>
											{(file.mediaType === workspaceDirectoryMediaType ||
												(file.mediaType === workspacePageMediaType &&
													files.some(
														(child) => child.parentId === file.id,
													))) && (
												<span aria-hidden css={{ color: colors.textMuted }}>
													›
												</span>
											)}
										</SiteLink>
										{renamingId === file.id &&
											onCommitRename &&
											onRenameDone && (
												<InlineFileRename
													key={file.id}
													name={file.name}
													onSave={(name) => onCommitRename(file.id, name)}
													onDone={onRenameDone}
												/>
											)}
									</div>
								)
							}}
						/>
						{parent && parent.id === pendingFolderId && (
							<p
								role="status"
								css={{
									color: colors.textMuted,
									padding: '8px 10px',
									fontSize: 12,
								}}
							>
								Loading…
							</p>
						)}
						{!children.length && !parent && <WorkspaceEmptyFolder />}
					</nav>
				)
			})}
			{renderPreview &&
				selected &&
				selected.id !== pendingFolderId &&
				(selected.mediaType !== workspaceDirectoryMediaType ||
					!files.some((file) => file.parentId === selected.id)) && (
					<section
						aria-label={`Preview ${selected.name}`}
						data-workspace-item={selected.id}
						css={{
							flex: '1 0 440px',
							display: 'flex',
							flexDirection: 'column',
							minHeight: 0,
							minWidth: 320,
							padding: fullPreview ? 0 : 16,
							overflow: 'auto',
							scrollSnapAlign: 'start',
						}}
					>
						{!fullPreview && (
							<div
								css={{
									display: 'flex',
									alignItems: 'center',
									gap: 8,
									marginBottom: 14,
									flexShrink: 0,
								}}
							>
								{!fullPreview && (
									<>
										{renderIcon(selected)}
										<strong
											css={{
												flex: 1,
												overflow: 'hidden',
												textOverflow: 'ellipsis',
											}}
										>
											{selected.name}
										</strong>
									</>
								)}
								<SiteLink
									href={href(selected.id)}
									css={{
										color: colors.textMuted,
										textDecoration: 'none',
										fontSize: 12,
									}}
								>
									Open ↗
								</SiteLink>
							</div>
						)}
						{selected.mediaType === workspaceDirectoryMediaType ? (
							<WorkspaceEmptyFolder />
						) : (
							renderPreview(selected)
						)}
					</section>
				)}
		</div>
	)
}
export function WorkspaceIconGrid({
	files,
	orgSlug,
	itemHref,
	renderIcon,
	includePackages = false,
	pointerHover = true,
	thumbnailSize = 130,
}: {
	pointerHover?: boolean
	thumbnailSize?: number
	includePackages?: boolean
	files: BrowserFile[]
	orgSlug: string
	itemHref?: (id: string) => string
	renderIcon: (file: BrowserFile) => ReactNode
}) {
	const [focusId, setFocusId] = useState<string | null>(null)
	const active =
		(focusId === 'system:packages' && includePackages) ||
		files.some((file) => file.id === focusId)
			? focusId
			: includePackages
				? 'system:packages'
				: files[0]?.id
	if (!files.length && !includePackages) return <WorkspaceEmptyFolder />
	return (
		<VirtualCollection
			label="Workspace icons"
			grid
			itemWidth={thumbnailSize}
			rowHeight={thumbnailSize + 30}
			keys={[
				...(includePackages ? ['system:packages'] : []),
				...files.map((file) => file.id),
			]}
			renderItem={(index) => {
				if (includePackages && index === 0)
					return (
						<SiteLink
							data-system-directory="packages"
							data-browser-item="system:packages"
							tabIndex={active === 'system:packages' ? 0 : -1}
							onFocus={() => setFocusId('system:packages')}
							href={`/@${orgSlug}/-/files?collection=packages`}
							css={{
								display: 'flex',
								flexDirection: 'column',
								alignItems: 'center',
								gap: 8,
								padding: 10,
								color: colors.text,
								textDecoration: 'none',
								fontSize: 12,
								borderRadius: 8,
								'&:hover': pointerHover
									? { background: colors.borderSubtle }
									: {},
							}}
						>
							<div
								css={{
									height: thumbnailSize - 40,
									width: '100%',
									display: 'grid',
									placeItems: 'center',
								}}
							>
								<svg
									width="40"
									height="40"
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
								>
									<path d="M1.5 4h5l1-1.5h7V14h-13z" />
								</svg>
							</div>
							Apps &amp; Packages
						</SiteLink>
					)
				const file = files[index - Number(includePackages)]!
				return (
					<SiteLink
						key={file.id}
						title={file.name}
						data-workspace-item={file.id}
						data-browser-item={file.id}
						tabIndex={active === file.id ? 0 : -1}
						onFocus={() => setFocusId(file.id)}
						href={itemHref?.(file.id) ?? `/@${orgSlug}/-/files?file=${file.id}`}
						css={{
							display: 'flex',
							flexDirection: 'column',
							gap: 8,
							padding: 10,
							alignItems: 'center',
							borderRadius: 8,
							textDecoration: 'none',
							color: colors.text,
							'&:focus-visible': {
								outline: `2px solid ${colors.primary}`,
								outlineOffset: 2,
							},
							'&:hover': pointerHover
								? { background: colors.borderSubtle }
								: {},
						}}
					>
						<div
							css={{
								height: thumbnailSize - 40,
								width: '100%',
								display: 'grid',
								placeItems: 'center',
								'& > svg': {
									width: Math.max(28, thumbnailSize * 0.3),
									height: Math.max(28, thumbnailSize * 0.3),
								},
							}}
						>
							{!itemHref && file.mediaType.startsWith('image/') ? (
								<img
									loading="lazy"
									src={fileAssetUrl(orgSlug, file.id, file.revisionId)}
									alt=""
									css={{
										maxWidth: '100%',
										maxHeight: thumbnailSize - 40,
										objectFit: 'contain',
									}}
								/>
							) : (
								renderIcon(file)
							)}
						</div>
						<span
							css={{
								fontSize: 12,
								textAlign: 'center',
								overflowWrap: 'anywhere',
								lineHeight: 1.4,
								display: '-webkit-box',
								WebkitLineClamp: 2,
								WebkitBoxOrient: 'vertical',
								overflow: 'hidden',
							}}
						>
							{file.name}
						</span>
					</SiteLink>
				)
			}}
		/>
	)
}

function InlineFileRename({
	name,
	onSave,
	onDone,
}: {
	name: string
	onSave: (name: string) => Promise<boolean | undefined>
	onDone: () => void
}) {
	const [value, setValue] = useState(name)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState('')
	const lock = useRef(false)
	async function save() {
		if (lock.current) return
		const next = value.trim()
		if (!next) {
			setError('Enter a name')
			return
		}
		if (next === name) {
			onDone()
			return
		}
		lock.current = true
		setSaving(true)
		try {
			if (await onSave(next)) onDone()
			else setError('Could not rename. Try again.')
		} catch {
			setError('Could not rename. Try again.')
		} finally {
			lock.current = false
			setSaving(false)
		}
	}
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault()
				void save()
			}}
			css={{ position: 'absolute', left: 31, right: 7, top: 3, zIndex: 2 }}
		>
			<input
				aria-label="Rename file"
				autoFocus
				maxLength={200}
				value={value}
				disabled={saving}
				aria-invalid={!!error}
				title={error || undefined}
				onChange={(event) => {
					setValue(event.target.value)
					setError('')
				}}
				onFocus={(event) => {
					const dot = name.lastIndexOf('.')
					event.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length)
				}}
				onBlur={() => {
					if (!saving) void save()
				}}
				onKeyDown={(event) => {
					event.stopPropagation()
					if (event.key === 'Escape') {
						event.preventDefault()
						lock.current = true
						onDone()
					}
				}}
				css={{
					boxSizing: 'border-box',
					width: '100%',
					minWidth: 0,
					height: 26,
					padding: '2px 4px',
					font: 'inherit',
					fontSize: 13,
					color: colors.text,
					background: colors.surface,
					border: `1px solid ${colors.primary}`,
					borderRadius: 3,
					outline: 'none',
				}}
			/>
			{error && (
				<span
					role="alert"
					css={{
						display: 'block',
						padding: 4,
						background: colors.surface,
						color: colors.danger,
						fontSize: 11,
					}}
				>
					{error}
				</span>
			)}
		</form>
	)
}
