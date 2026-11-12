/** @jsxImportSource @emotion/react */
import { FileGlyph } from '../components/file-glyph.tsx'
import { WorkspaceFileStatus } from './workspace-file-status.tsx'
import { workspaceProse, workspaceMarkdownCss } from './workspace-prose.ts'
import {
	RecordTable,
	RecordTableSearch,
	type RecordTableRow,
} from './record-table.tsx'
import type { RecordTableOptions } from './record-table-model.ts'
import { useFileItemHotkeys } from '../components/use-file-item-hotkeys.ts'
import { workspaceUploadTarget } from '../components/workspace-upload-target.ts'
import { useHotkey } from '@tanstack/react-hotkeys'
import {
	WorkspaceViewControls,
	ThumbnailSizeControl,
} from './workspace-view-controls.tsx'
import { useFileBrowserPreferences } from '../components/use-file-browser-preferences.ts'
import { WorkspaceEmptyFolder } from './workspace-empty-folder.tsx'
import { WorkspaceHeader } from './workspace-header.tsx'
import { WorkspaceBreadcrumbs } from './workspace-breadcrumbs.tsx'
import { WorkspaceGallery } from './workspace-gallery.tsx'
import {
	WorkspaceFileBrowser,
	packagesFolder,
	WorkspaceIconGrid,
} from './workspace-file-browser.tsx'
import {
	WorkspacePackages,
	useWorkspacePackages,
	packagesDirectoryHref,
	repoWorkspaceHref,
} from './workspace-packages.tsx'
import { Combobox } from '../components/combobox.tsx'
import { WorkspaceCreateMenu } from '../components/workspace-create-menu.tsx'
import { useWorkspaceUploads } from '../components/workspace-uploads.tsx'
import { WorkspaceExplorerLayout } from '../components/workspace-explorer-layout.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { detectFileMediaType, fileViewerKind } from '#universal/file-viewers.ts'
import {
	lazy,
	Suspense,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from 'react'
import { isNotFound, useBlocker, useRouter } from '@tanstack/react-router'
import { loadWorkspaceRepoFiles } from '#start/server/package-files'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
	type loadFilesPage,
	saveFile,
	manageWorkspaceFile,
	readFileRevision,
	readFileHistory,
	readFilePreview,
	readPageLinkTitle,
} from '#start/server/files'
import { buildPackageAppOpenPath } from '@kody-internal/shared/public-urls.ts'
import { routes } from '#universal/routes.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import {
	fileByteLimit,
	fileContentSchema,
	type FileMetadata,
} from '#universal/files.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getSelectCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	workspaceDirectoryMediaType,
	isWorkspaceContainer,
	workspacePageMediaType,
	workspacePageMarkdown,
	writeWorkspacePage,
	readWorkspacePage,
} from '#universal/workspace-page.ts'
import {
	ContextMenuSurface,
	type ContextAction,
} from '../components/context-menu-surface.tsx'
import { FileActionDialog } from './file-action-dialog.tsx'
const FilePermissionsPanel = lazy(() => import('./file-permissions-panel.tsx'))
import { HtmlPreview } from './file-viewers/html-file-viewer.tsx'
import { CsvPreview } from './file-viewers/csv-file-viewer.tsx'
import { FileViewer } from './file-viewers/file-viewer.tsx'
import { fileAssetUrl } from '#universal/file-assets.ts'
const CollaborativeFileView = lazy(
	() => import('./collaborative-file-view.tsx'),
)
const WorkspacePageEditor = lazy(() =>
	import('./workspace-page-editor.tsx').then((module) => ({
		default: module.WorkspacePageEditor,
	})),
)
const MarkdownPreview = lazy(
	() => import('./file-viewers/markdown-file-viewer.tsx'),
)
import { SiteLink } from '../components/site-link.tsx'
import { accountInputCss } from './account-management-components.tsx'

const loadLinkTitle = (url: string) => readPageLinkTitle({ data: { url } })

type PageData = Awaited<ReturnType<typeof loadFilesPage>>
const fileDate = new Intl.DateTimeFormat('en-US', {
	month: 'short',
	day: 'numeric',
	timeZone: 'UTC',
})

const compactControl = {
	minHeight: 28,
	padding: '3px 9px',
	borderRadius: 5,
	fontSize: typography.fontSize.xs,
}
const button = {
	...getGhostButtonCss(),
	...compactControl,
	boxShadow: 'none',
	'@media (hover: hover)': {
		'&:not(:disabled):hover': {
			background: 'color-mix(in srgb, currentColor 7%, transparent)',
		},
	},
}
const primary = { ...getPillButtonCss(), ...compactControl }
const hover = `color-mix(in srgb, ${colors.text} 7%, transparent)`

const iconPaths = {
	search: 'M10.5 10.5 14 14M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
	back: 'm9.5 3.5-4.5 4.5 4.5 4.5M5 8h8',
	add: 'M8 3v10M3 8h10',
	upload: 'M8 11V2.5m-3 3 3-3 3 3M3 10v3.5h10V10',
	more: 'M3 8h.1M8 8h.1M13 8h.1',
	right: 'm6 4 4 4-4 4',
	down: 'm4 6 4 4 4-4',
	open: 'M9 3h4v4m0-4L7 9m5 0v4H3V4h4',
}

function WorkspaceIcon({ name }: { name: keyof typeof iconPaths }) {
	return (
		<svg
			aria-hidden="true"
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={name === 'more' ? 2 : 1.35}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d={iconPaths[name]} />
		</svg>
	)
}

const iconButton = {
	...button,
	display: 'inline-grid',
	placeItems: 'center',
	width: 28,
	minHeight: 28,
	padding: 0,
}

const menuCss = {
	position: 'absolute' as const,
	insetInlineEnd: 0,
	top: 'calc(100% + 5px)',
	zIndex: 3,
	minWidth: 156,
	background: colors.surface,
	border: `1px solid ${colors.border}`,
	borderRadius: 7,
	padding: 4,
	boxShadow: '0 8px 24px #0002',
	display: 'grid',
	'& > button, & > a': {
		textAlign: 'start' as const,
		justifyContent: 'start',
		textDecoration: 'none',
	},
}

const row = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'center',
	flexWrap: 'wrap' as const,
}
const panel = {
	border: `1px solid ${colors.border}`,
	borderRadius: 12,
	padding: spacing.lg,
	minWidth: 0,
}
const sourceCss = {
	width: '100%',
	minHeight: '55vh',
	resize: 'vertical' as const,
	padding: '12px 16px',
	border: 0,
	borderRadius: 5,
	background: colors.surface,
	color: colors.text,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.65,
	boxSizing: 'border-box' as const,
}

export function FilesPage({
	data,
	initialCreating = false,
	initialPage = false,
	initialDirectory = false,
	showTrash = false,
	showPackages = false,
	repo,
	repoPath,
	repoOpen,
	parentId,
	collapsed,
	onToggleBranch,
	embedded = false,
	finderActive,
	onFinderSelectionChange,
}: {
	data: PageData
	embedded?: boolean
	finderActive?: string
	onFinderSelectionChange?: (id: string | undefined) => void
	initialCreating?: boolean
	initialPage?: boolean
	initialDirectory?: boolean
	showTrash?: boolean
	showPackages?: boolean
	repo?: string
	repoPath?: string
	repoOpen?: boolean
	parentId?: string
	collapsed: ReadonlySet<string>
	onToggleBranch: (id: string) => void
}) {
	const uploads = useWorkspaceUploads()
	const columnFocusHandoff = useRef<string | null>(null)
	const finderHover = useState(true)
	const fileSurface = useRef<HTMLElement>(null)
	const [browseDestination, setBrowseDestination] = useState<
		string | undefined | null
	>(null)
	const [dropTarget, setDropTarget] = useState<string | null>(null)
	const dragDepth = useRef(0)
	const [explorerVisible, setExplorerVisible] = useState(true)
	const selected = data.selected
	const canCreateIn = (id?: string) =>
		id
			? !!data.files.find((file) => file.id === id)?.access.write
			: data.can_create
	const explorerCreationParent =
		selected && isWorkspaceContainer(selected.file.mediaType)
			? selected.file.id
			: selected?.file.parentId

	const packagesExpanded = !collapsed.has('system:packages')
	const setPackagesExpanded = (expanded: boolean) => {
		if (expanded !== packagesExpanded) onToggleBranch('system:packages')
	}
	const packageDirectory = useWorkspacePackages(
		data.orgSlug,
		!embedded && ((packagesExpanded && explorerVisible) || showPackages),
	)
	const explorer = useRef<HTMLElement>(null)
	useLayoutEffect(() => {
		explorer.current
			?.querySelector<HTMLElement>('[aria-current="page"]')
			?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [selected?.file.id, selected?.file.parentId, selected?.file.name])
	const binary = selected?.file.encoding === 'base64'
	const router = useRouter()
	const queryClient = useQueryClient()
	const [name, setName] = useState(
		initialPage || initialDirectory ? '' : 'Untitled.md',
	)
	const [creating, setCreating] = useState(initialCreating)
	const [mediaType, setMediaType] = useState<FileMetadata['mediaType']>(
		initialDirectory
			? workspaceDirectoryMediaType
			: initialPage
				? workspacePageMediaType
				: 'text/markdown',
	)
	const [draft, setDraft] = useState(
		() =>
			selected?.file.content ??
			(initialPage
				? writeWorkspacePage([
						{ id: crypto.randomUUID(), kind: 'paragraph', text: '' },
					])
				: ''),
	)
	const [initialDraft] = useState(draft)
	const [saved, setSaved] = useState(selected?.file.content ?? '')
	const [base, setBase] = useState(
		selected?.file.headVersion ?? selected?.file.revisionId ?? null,
	)
	const [fileId] = useState(() => selected?.file.id ?? crypto.randomUUID())
	const [pendingWrite, setPendingWrite] = useState<{
		id: string
		content: string
		sourceRevision?: string
	} | null>(null)
	const [busy, setBusy] = useState(false)
	const [saving, setSaving] = useState(false)
	const savingLock = useRef(false)
	const uploadInput = useRef<HTMLInputElement>(null)
	const replacementInput = useRef<HTMLInputElement>(null)
	const [message, setMessage] = useState('')
	const [preview, setPreview] = useState(
		fileViewerKind(
			selected?.file.name ?? '',
			selected?.file.mediaType ?? '',
		) === 'json' ||
			['text/markdown', 'text/html', 'text/csv', 'image/svg+xml'].includes(
				selected?.file.mediaType ?? '',
			),
	)
	const isPage =
		(selected?.file.mediaType ?? mediaType) === workspacePageMediaType
	const embeddedFileIds = new Set(
		readWorkspacePage(draft)?.blocks.flatMap((block) =>
			block.kind === 'file' ? [block.fileId] : [],
		) ?? [],
	)
	const isDirectory =
		(selected?.file.mediaType ?? mediaType) === workspaceDirectoryMediaType
	const [historyOpen, setHistoryOpen] = useState(false)
	const [historical, setHistorical] = useState<{
		content: string
		id: string
	} | null>(null)
	const [conflict, setConflict] = useState<{
		content: string
		revisionId: string | null
	} | null>(null)
	const [search, setSearch] = useState('')
	const explorerRows = treeRows(data.files, search.trim(), collapsed)
	const explorerSearch = useRef<HTMLInputElement>(null)
	const [actionsOpen, setActionsOpen] = useState(false)
	const [contextAction, setContextAction] = useState<{
		item: PageData['files'][number]
		action: 'rename' | 'move' | 'trash' | 'details'
	} | null>(null)
	const [newName, setNewName] = useState(selected?.file.name ?? '')
	const [pendingTitle, setPendingTitle] = useState<string | null>(null)
	const pendingManage = useRef<{ key: string; id: string } | null>(null)
	const [olderHistory, setOlderHistory] = useState<
		Record<
			string,
			{ revisions: FileMetadata['revisions']; cursor: string | null }
		>
	>({})
	const historyRows = selected
		? [
				...new Map(
					[
						...selected.file.revisions,
						...(olderHistory[selected.file.id]?.revisions ?? []),
					].map((revision) => [revision.id, revision]),
				).values(),
			].sort(
				(a, b) =>
					a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
			)
		: []
	const historyCursor = selected
		? (olderHistory[selected.file.id]?.cursor ??
			(olderHistory[selected.file.id] ? null : selected.file.historyCursor))
		: null
	const collaborationToolbar = useRef<HTMLDivElement | null>(null)
	const collaboration =
		!!selected &&
		!historical &&
		!creating &&
		!isDirectory &&
		data.collaborationEnabled

	const dirty =
		creating && isPage
			? Boolean(name.trim()) || draft !== initialDraft
			: draft !== saved || creating
	const editable =
		data.writes_enabled &&
		!(selected?.file.collaboration && !data.collaborationEnabled) &&
		(creating ? canCreateIn(parentId) : selected?.access.write)
	const latestDraft = useRef(draft)
	useLayoutEffect(() => {
		latestDraft.current = draft
	}, [draft])
	useBlocker({
		shouldBlockFn: async () => {
			if (!dirty) return false
			if (isPage && !creating && !historical && !busy && !conflict) {
				const content = draft
				if ((await save()) && latestDraft.current === content) return false
			}
			return !window.confirm('Discard your unsaved changes?')
		},
		enableBeforeUnload: dirty,
	})

	async function refresh() {
		await queryClient.invalidateQueries({
			predicate: (query) =>
				query.queryKey[0] === 'page' && query.queryKey[2] === 'loadFilesPage',
		})
		await router.invalidate()
	}
	async function save(content = draft, revisionId = base) {
		if (busy || savingLock.current || !editable) return
		if (!binary && !fileContentSchema.safeParse(content).success) {
			setMessage('Text files can contain at most 64 KiB.')
			return
		}
		if (creating && ((!isPage && !name.trim()) || name.trim().length > 200)) {
			setMessage('Enter a file name, up to 200 characters.')
			return
		}
		if (binary && !historical) setDraft(content)
		savingLock.current = true
		setSaving(true)
		setBusy(true)
		setMessage('')
		const write =
			pendingWrite?.content === content &&
			pendingWrite.sourceRevision === (binary ? historical?.id : undefined)
				? pendingWrite
				: {
						id: crypto.randomUUID(),
						content,
						sourceRevision: binary ? historical?.id : undefined,
					}
		setPendingWrite(write)
		try {
			const result = await saveFile({
				data: {
					orgSlug: data.orgSlug,
					input: creating
						? {
								file_id: fileId,
								write_id: write.id,
								name: isPage ? name.trim() || 'Untitled' : name,
								media_type: mediaType,
								parent_id: parentId,
								content,
							}
						: {
								file_id: fileId,
								write_id: write.id,
								base_revision_id: revisionId!,
								...(binary && historical
									? { restore_revision_id: historical.id }
									: {}),
								content,
							},
				},
			})
			if (result.ok) {
				setSaved(binary ? '' : content)
				setDraft((current) =>
					binary ? '' : current === draft ? content : current,
				)
				setBase(result.file.headVersion ?? result.file.revisionId)
				setConflict(null)
				setHistorical(null)
				setPendingWrite(null)
				setMessage('')
				if (creating) {
					setNewName(result.file.name)
					setCreating(false)
					await router.navigate({
						href: `/@${data.orgSlug}/-/files?file=${fileId}`,
						ignoreBlocker: true,
					})
				}
				await refresh()
				return true
			} else if (result.code === 'revision_conflict') {
				setConflict({
					content: result.current,
					revisionId: result.current_revision_id,
				})
				setPendingWrite(null)
			} else setMessage(result.message)
		} catch {
			setMessage('Could not save. Your draft is still here, try again.')
		} finally {
			setBusy(false)
			savingLock.current = false
			setSaving(false)
		}
	}
	const autoSave =
		!collaboration &&
		isPage &&
		editable &&
		!historical &&
		!conflict &&
		(!creating || !!name.trim() || draft !== initialDraft)
	const saveLatest = useEffectEvent(() => {
		void save()
	})
	useEffect(() => {
		if (!autoSave || !dirty || busy || message) return
		const timer = window.setTimeout(saveLatest, 900)
		return () => window.clearTimeout(timer)
	}, [autoSave, dirty, draft, name, busy, message, base])

	useEffect(() => {
		if (!pendingTitle || busy || !selected) return
		setPendingTitle(null)
		void manage(selected.file, 'rename', { name: pendingTitle })
	}, [pendingTitle, busy])

	async function manage(
		item: FileMetadata,
		action: 'rename' | 'move' | 'trash' | 'restore',
		changes: { name?: string; parent_id?: string | null } = {},
	) {
		if (busy) return
		setBusy(true)
		setMessage('')
		const key = JSON.stringify([
			item.id,
			action,
			item.metadataVersion ?? 0,
			changes,
		])
		if (pendingManage.current?.key !== key)
			pendingManage.current = { key, id: crypto.randomUUID() }
		try {
			const result = await manageWorkspaceFile({
				data: {
					orgSlug: data.orgSlug,
					input: {
						file_id: item.id,
						operation_id: pendingManage.current.id,
						expected_version: item.metadataVersion ?? 0,
						action,
						...changes,
					},
				},
			})
			if (!result.ok) {
				setMessage(result.message)
				return
			}
			pendingManage.current = null
			setContextAction(null)
			if (action === 'trash')
				await router.navigate({
					href: `/@${data.orgSlug}/-/files?trash=1`,
					ignoreBlocker: true,
				})
			await refresh()
			return true
		} catch {
			setMessage('Could not update this item. Try again.')
		} finally {
			setBusy(false)
		}
	}

	function enqueueUploads(
		files: File[],
		target?: FileMetadata,
		explicit?: { id: string | undefined },
	) {
		const destinationId = explicit
			? explicit.id
			: target
				? isWorkspaceContainer(target.mediaType)
					? target.id
					: target.parentId
				: browseDestination !== null
					? browseDestination
					: selected && isWorkspaceContainer(selected.file.mediaType)
						? selected.file.id
						: (parentId ?? selected?.file.parentId)
		const container = destinationId
			? data.files.find((file) => file.id === destinationId)
			: undefined

		if (!data.writes_enabled || !canCreateIn(destinationId)) {
			setMessage('You do not have permission to upload here.')
			return
		}
		if (creating) {
			setMessage('Create this page or folder before adding files.')
			return
		}
		uploads.enqueue(files, {
			org: data.orgSlug,
			parentId: destinationId,
			destination:
				container?.name ??
				data.files.find((file) => file.id === destinationId)?.name ??
				'Workspace',
			embed: container?.mediaType === workspacePageMediaType,
		})
	}
	function resolveDrop(target: Element) {
		return workspaceUploadTarget(
			target,
			data.files,
			browseDestination !== null
				? browseDestination
				: selected && isWorkspaceContainer(selected.file.mediaType)
					? selected.file.id
					: (parentId ?? selected?.file.parentId),
		)
	}
	const activeDropZone = useRef<HTMLElement | null>(null)
	function markDropZone(zone: HTMLElement | null) {
		if (activeDropZone.current === zone) return
		activeDropZone.current?.removeAttribute('data-upload-over')
		zone?.setAttribute('data-upload-over', '')
		activeDropZone.current = zone
	}
	useEffect(
		() => () => activeDropZone.current?.removeAttribute('data-upload-over'),
		[],
	)

	async function upload(file: File, replace = false) {
		if (!replace) {
			enqueueUploads([file])
			return
		}
		if (file.size > fileByteLimit) {
			setMessage('Files can contain at most 16 MiB.')
			return
		}
		setBusy(true)
		try {
			await save(bytesToBase64(new Uint8Array(await file.arrayBuffer())))
		} catch {
			setMessage('Could not replace file. Try again.')
		} finally {
			setBusy(false)
			if (replacementInput.current) replacementInput.current.value = ''
		}
	}
	useEffect(() => {
		if (!selected || !isPage || !editable || historical) return
		const completed = uploads.jobs.filter(
			(job) =>
				job.org === data.orgSlug &&
				job.parentId === selected.file.id &&
				job.embed &&
				job.status === 'complete' &&
				data.files.some((file) => file.id === job.id),
		)
		if (!completed.length) return
		setDraft((value) => {
			const blocks = readWorkspacePage(value)?.blocks
			if (!blocks) return value
			const missing = completed.filter(
				(job) =>
					!blocks.some(
						(block) => block.kind === 'file' && block.fileId === job.id,
					),
			)
			if (blocks.length + missing.length > 250) return value
			return writeWorkspacePage([
				...blocks,
				...missing.map((job) => ({
					id: crypto.randomUUID(),
					kind: 'file' as const,
					fileId: job.id,
				})),
			])
		})
		uploads.consumeEmbeds(completed.map((job) => job.id))
	}, [
		uploads.jobs,
		data.files,
		selected?.file.id,
		isPage,
		editable,
		historical,
	])

	function exportMarkdown(file: { name: string; content: string }) {
		try {
			const markdown = workspacePageMarkdown(
				file.name,
				file.content,
				data.files.map((item) => ({
					id: item.id,
					name: item.name,
					href: new URL(fileHref(item.id), window.location.origin).href,
				})),
			)
			const url = URL.createObjectURL(
				new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
			)
			const link = document.createElement('a')
			link.href = url
			link.download = file.name.replace(/\.md$/i, '') + '.md'
			link.click()
			URL.revokeObjectURL(url)
		} catch {
			setMessage('Could not export this page. Try again.')
		}
	}

	function download() {
		if (binary) {
			const anchor = document.createElement('a')
			anchor.href = fileAssetUrl(
				data.orgSlug,
				fileId,
				historical?.id ?? base,
				true,
			)
			anchor.click()
			return
		}

		const url = URL.createObjectURL(
			new Blob([historical?.content ?? draft], {
				type: selected?.file.mediaType ?? mediaType,
			}),
		)
		const anchor = document.createElement('a')
		anchor.href = url
		anchor.download = isPage
			? `${selected?.file.name ?? name}.json`
			: (selected?.file.name ?? name)
		anchor.click()
		URL.revokeObjectURL(url)
	}
	const currentType = selected?.file.mediaType ?? mediaType
	const fullHtmlPreview =
		currentType === 'text/html' && !binary && Boolean(preview || historical)
	const nativeKind = fileViewerKind(selected?.file.name ?? name, currentType)
	const showFileViewer =
		!!nativeKind &&
		((currentType !== 'image/svg+xml' && nativeKind !== 'json') ||
			preview ||
			!!historical)
	const fullMediaPreview = fullHtmlPreview || binary || showFileViewer
	const fileHref = (id: string) => `/@${data.orgSlug}/-/files?file=${id}`
	const assetFiles = data.files.filter(
		(file) => !isWorkspaceContainer(file.mediaType),
	)
	function renderEmbed(id: string) {
		const metadata = assetFiles.find((file) => file.id === id)
		if (!metadata)
			return <span css={{ color: colors.textMuted }}>File unavailable</span>
		return (
			<FileEmbed
				orgSlug={data.orgSlug}
				metadata={metadata}
				initial={data.embeds.find((file) => file.id === id)}
				href={fileHref(id)}
			/>
		)
	}
	function contextActions(target: Element): ContextAction[] | undefined {
		if (target.closest('[data-package-item]')) return
		if (target.closest('[data-system-directory]'))
			return [
				{
					id: 'details',
					label: 'Details',
					run: () => {
						void router.navigate({ href: packagesDirectoryHref(data.orgSlug) })
					},
				},
				{
					id: 'copy-link',
					label: 'Copy link',
					run: async () => {
						try {
							await navigator.clipboard.writeText(
								new URL(
									packagesDirectoryHref(data.orgSlug),
									window.location.origin,
								).href,
							)
						} catch {
							setMessage('Could not copy the link. Try again.')
						}
					},
				},
			]
		if (showPackages) return
		const id = target.closest<HTMLElement>('[data-workspace-item]')?.dataset
			.workspaceItem
		const item = [...data.files, ...data.trashed].find((file) => file.id === id)
		const locked = busy || dirty
		if (!item) {
			if (
				!target.closest('[data-workspace-background]') ||
				!canCreateIn(explorerCreationParent) ||
				!data.writes_enabled
			)
				return
			const parent = explorerCreationParent
				? `&parent=${explorerCreationParent}`
				: ''
			return [
				{
					id: 'new-page',
					label: 'New page',
					run: () => {
						void router.navigate({
							href: `/@${data.orgSlug}/-/files?new=page${parent}`,
						})
					},
				},
				{
					id: 'new-folder',
					label: 'New folder',
					run: () => {
						void router.navigate({
							href: `/@${data.orgSlug}/-/files?new=folder${parent}`,
						})
					},
				},
				{
					id: 'upload',
					label: 'Upload file',
					disabled: locked,
					run: () => uploadInput.current?.click(),
				},
			]
		}
		if (item.trashedAt)
			return item.access.delete
				? [
						{
							id: 'restore',
							label: 'Restore',
							disabled: locked,
							run: async () => {
								await manage(item, 'restore')
							},
						},
					]
				: undefined
		const actions: ContextAction[] = [
			{
				id: 'open',
				label:
					item.mediaType === workspaceDirectoryMediaType ? 'Details' : 'Open',
				run: () => {
					void router.navigate({ href: fileHref(item.id) })
				},
			},
			{
				id: 'copy-link',
				label: 'Copy link',
				run: async () => {
					try {
						await navigator.clipboard.writeText(
							new URL(fileHref(item.id), window.location.origin).href,
						)
					} catch {
						setMessage(
							'Could not copy the link. Open the item to copy its address.',
						)
					}
				},
			},
		]
		if (item.mediaType === workspacePageMediaType)
			actions.push({
				id: 'export-markdown',
				label: 'Export Markdown',
				disabled: busy,
				run: async () => {
					try {
						const { file } = await readFileRevision({
							data: { orgSlug: data.orgSlug, fileId: item.id },
						})
						exportMarkdown(file)
					} catch {
						setMessage('Could not export this page. Try again.')
					}
				},
			})
		if (item.access.write && data.writes_enabled)
			actions.push(
				{
					id: 'rename',
					label: 'Rename',
					disabled: locked,
					run: () => setContextAction({ item, action: 'rename' }),
				},
				{
					id: 'move',
					label: 'Move to…',
					disabled: locked,
					run: () => setContextAction({ item, action: 'move' }),
				},
			)
		actions.push({
			id: 'details',
			label: 'Details & permissions',
			disabled: busy,
			run: () => setContextAction({ item, action: 'details' }),
		})
		if (
			isWorkspaceContainer(item.mediaType) &&
			item.access.write &&
			data.writes_enabled
		)
			actions.push(
				{
					id: 'new-page',
					label: 'New page inside',
					run: () => {
						void router.navigate({
							href: `/@${data.orgSlug}/-/files?new=page&parent=${item.id}`,
						})
					},
				},
				{
					id: 'new-folder',
					label: 'New folder inside',
					run: () => {
						void router.navigate({
							href: `/@${data.orgSlug}/-/files?new=folder&parent=${item.id}`,
						})
					},
				},
			)
		if (!isWorkspaceContainer(item.mediaType))
			actions.push({
				id: 'download',
				label: 'Download',
				disabled: busy,
				run: () => {
					const link = document.createElement('a')
					link.href = fileAssetUrl(data.orgSlug, item.id, item.revisionId, true)
					link.click()
				},
			})
		if (item.access.delete)
			actions.push({
				id: 'trash',
				label: 'Move to trash',
				danger: true,
				disabled: locked,
				run: () => setContextAction({ item, action: 'trash' }),
			})
		return actions
	}

	useHotkey(
		'Mod+S',
		() => {
			if (dirty) void save()
		},
		{
			target: fileSurface,
			enabled: isPage && !!editable,
			ignoreInputs: false,
			meta: { name: 'Save page' },
		},
	)
	useHotkey(
		'Escape',
		(event) => {
			if (
				event.defaultPrevented ||
				(event.target as Element).closest(
					'[role=menu], [role=dialog], [role=listbox], [role=combobox][aria-expanded=true], [popover]:popover-open',
				)
			)
				return
			event.preventDefault()
			void router.navigate({
				href: `/@${data.orgSlug}/-/files?active=${selected!.file.id}`,
				resetScroll: false,
			})
		},
		{
			target: fileSurface,
			enabled:
				!embedded &&
				!!selected &&
				!isDirectory &&
				!creating &&
				!actionsOpen &&
				!contextAction,
			ignoreInputs: true,
			ignoreDefaultPrevented: true,
			preventDefault: false,
		},
	)

	const documentTitle =
		fullMediaPreview ||
		(embedded && !isPage) ||
		((currentType === 'text/markdown' || currentType === 'text/csv') &&
			(preview || historical)) ? null : (
			<h2
				css={{
					margin:
						isPage || currentType === 'text/markdown'
							? '20px auto 0'
							: '20px 0 0',
					maxWidth:
						isPage || currentType === 'text/markdown'
							? workspaceProse.width
							: undefined,
					overflowWrap: 'anywhere',
					flexBasis: '100%',
					fontSize: 'clamp(1.5rem, 3.3vw, 2.3rem)',
					lineHeight: 1.12,
					letterSpacing: '-0.04em',
					fontWeight: 720,
				}}
			>
				{isDirectory && (
					<span
						css={{
							display: 'inline-flex',
							marginInlineEnd: 10,
							verticalAlign: 'middle',
							'& svg': { width: 25, height: 25 },
						}}
					>
						<FileGlyph mediaType={workspaceDirectoryMediaType} />
					</span>
				)}
				{isPage && editable && !historical ? (
					<input
						aria-label="Page title"
						data-field-ring
						placeholder="Untitled"
						value={creating ? name : newName}
						maxLength={200}
						autoFocus={creating}
						onChange={(event) =>
							creating
								? setName(event.target.value)
								: setNewName(event.target.value)
						}
						onBlur={() => {
							if (
								!creating &&
								selected &&
								newName.trim() &&
								newName.trim() !== selected.file.name
							)
								setPendingTitle(newName.trim())
						}}
						onKeyDown={(event) => {
							if (event.key === 'Enter') event.currentTarget.blur()
							if (event.key === 'Escape' && !creating) {
								setNewName(selected?.file.name ?? '')
								event.preventDefault()
							}
						}}
						css={{
							width: '100%',
							padding: 0,
							margin: 0,
							border: 0,
							borderRadius: 0,
							outline: 'none',
							background: 'transparent',
							color: 'inherit',
							font: 'inherit',
							letterSpacing: 'inherit',
							lineHeight: 'inherit',
							'&::placeholder': { color: colors.textMuted },
						}}
					/>
				) : (
					selected?.file.name
				)}
			</h2>
		)

	return (
		<ContextMenuSurface resolve={contextActions}>
			<section
				ref={fileSurface}
				onDragEnterCapture={(event) => {
					if (event.dataTransfer.types.includes('Files')) {
						event.preventDefault()
						dragDepth.current++
						setDropTarget('Workspace')
					}
				}}
				onDragOverCapture={(event) => {
					if (!event.dataTransfer.types.includes('Files')) return
					event.preventDefault()
					event.stopPropagation()
					const destination = resolveDrop(event.target as Element)
					const allowed =
						destination &&
						canCreateIn(destination.id) &&
						data.writes_enabled &&
						!creating &&
						!showPackages &&
						destination.writable
					event.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
					markDropZone(allowed ? destination.zone : null)
					setDropTarget(allowed ? destination.name : '')
				}}
				onDragLeaveCapture={(event) => {
					if (
						event.dataTransfer.types.includes('Files') &&
						--dragDepth.current <= 0
					) {
						dragDepth.current = 0
						setDropTarget(null)
						markDropZone(null)
					}
				}}
				onDropCapture={(event) => {
					if (!event.dataTransfer.types.includes('Files')) return
					event.preventDefault()
					event.stopPropagation()
					dragDepth.current = 0
					setDropTarget(null)
					markDropZone(null)
					const destination = resolveDrop(event.target as Element)
					if (!destination || showPackages) return
					enqueueUploads(
						Array.from(event.dataTransfer.files),
						undefined,
						destination,
					)
				}}
				css={{
					'& [data-upload-over]': {
						outline: `2px solid ${colors.primary}`,
						outlineOffset: -2,
						backgroundColor: colors.primarySoftest,
					},
					width: '100%',
					minWidth: 0,
					minHeight: embedded ? 0 : '100dvh',
					height: embedded ? '100%' : undefined,
					flex: embedded ? 1 : undefined,
					'@media (min-width: 961px)': { height: embedded ? '100%' : '100dvh' },
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				{dropTarget !== null && (
					<div
						role="status"
						css={{
							position: 'fixed',
							bottom: 'max(24px, env(safe-area-inset-bottom))',
							left: '50%',
							transform: 'translateX(-50%)',
							zIndex: 70,
							pointerEvents: 'none',
							maxWidth: 'calc(100vw - 32px)',
							boxSizing: 'border-box',
							border: `1px solid ${dropTarget ? colors.primary : colors.border}`,
							borderRadius: 8,
							padding: '10px 14px',
							display: 'flex',
							alignItems: 'center',
							gap: 8,
							background: colors.surface,
							color: dropTarget ? colors.text : colors.textMuted,
							boxShadow: '0 4px 16px #0002',
							fontSize: 13,
							fontWeight: 600,
							'& > svg': { flexShrink: 0 },
						}}
					>
						{dropTarget && <WorkspaceIcon name="upload" />}
						<span css={{ minWidth: 0, overflowWrap: 'anywhere' }}>
							{dropTarget ? `Upload to ${dropTarget}` : 'Cannot upload here'}
						</span>
					</div>
				)}
				<input
					ref={uploadInput}
					type="file"
					multiple
					aria-label="Upload file"
					hidden
					onChange={(event) => {
						const files = Array.from(event.target.files ?? [])
						if (files.length) enqueueUploads(files)
						event.target.value = ''
					}}
				/>
				{message && !selected && !creating && <p role="status">{message}</p>}
				{!data.writes_enabled && (
					<p role="status">
						File storage is not enabled for this workspace yet.
					</p>
				)}
				<WorkspaceExplorerLayout
					browsing={
						embedded ||
						(!creating && ((!selected && !showTrash) || isDirectory))
					}
					onVisibilityChange={setExplorerVisible}
					sidebar={
						<>
							<div
								css={{
									...row,
									justifyContent: 'space-between',
									marginBottom: 9,
									padding: '2px 1px',
								}}
							>
								<SiteLink
									href={`/@${data.orgSlug}/-/files`}
									aria-label="Files"
									title="Open root finder"
									css={{
										...iconButton,
										display: 'inline-flex',
										alignItems: 'center',
										whiteSpace: 'nowrap',
										width: 'auto',
										gap: 6,
										paddingInline: 6,
										fontSize: 13,
										textDecoration: 'none',
									}}
								>
									<FileGlyph mediaType={workspaceDirectoryMediaType} />
									Files
								</SiteLink>
								<WorkspaceCreateMenu
									canManageStorage={
										data.canManageStorage && data.collaborationEnabled
									}
									orgSlug={data.orgSlug}
									parentId={explorerCreationParent}
									canCreate={
										data.writes_enabled &&
										!busy &&
										canCreateIn(explorerCreationParent)
									}
									onUpload={() => uploadInput.current?.click()}
								/>
							</div>
							<div
								css={{
									position: 'relative',
									color: colors.textMuted,
									'& > svg': {
										position: 'absolute',
										left: 7,
										top: 6,
										pointerEvents: 'none',
										width: 14,
										height: 14,
									},
								}}
							>
								<WorkspaceIcon name="search" />
								<input
									ref={explorerSearch}
									role="searchbox"
									inputMode="search"
									css={{
										...accountInputCss,
										minHeight: 28,
										fontSize: typography.fontSize.xs,
										padding: '4px 30px 4px 26px',
										borderColor: 'transparent',
										background: hover,
									}}
									aria-label="Find pages and files"
									placeholder="Search"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
								/>
								{search && (
									<button
										type="button"
										aria-label="Clear file search"
										title="Clear file search"
										css={{
											...button,
											position: 'absolute',
											insetInlineEnd: 3,
											top: 2,
											padding: 0,
											minHeight: 24,
											width: 24,
											display: 'grid',
											placeItems: 'center',
										}}
										onClick={() => {
											setSearch('')
											explorerSearch.current?.focus()
										}}
									>
										<svg
											aria-hidden="true"
											width="14"
											height="14"
											viewBox="0 0 16 16"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.5"
											strokeLinecap="round"
										>
											<path d="m4 4 8 8m0-8-8 8" />
										</svg>
									</button>
								)}
							</div>
							<div css={{ minHeight: 0, flex: 1, overflowY: 'auto' }}>
								<nav
									aria-label="Pages and files"
									data-upload-directory=""
									ref={explorer}
									css={{ display: 'grid', gap: 2, marginTop: spacing.sm }}
								>
									<div
										data-system-directory="packages"
										css={{
											display: 'flex',
											alignItems: 'center',
											borderRadius: 5,
											background: showPackages ? hover : 'transparent',
											'&:hover': { background: hover },
										}}
									>
										<button
											css={{ ...iconButton, width: 20, flexShrink: 0 }}
											aria-label={`${packagesExpanded ? 'Collapse' : 'Expand'} Apps & Packages`}
											aria-expanded={packagesExpanded}
											onClick={() => setPackagesExpanded(!packagesExpanded)}
										>
											<WorkspaceIcon
												name={packagesExpanded ? 'down' : 'right'}
											/>
										</button>
										<SiteLink
											href={packagesDirectoryHref(data.orgSlug)}
											aria-current={showPackages ? 'page' : undefined}
											aria-expanded={packagesExpanded}
											title="Permanent directory"
											onClick={(event) => {
												if (
													event.detail === 0 ||
													event.metaKey ||
													event.ctrlKey ||
													event.shiftKey ||
													event.altKey
												)
													return
												event.preventDefault()
												if (event.detail === 1)
													setPackagesExpanded(!packagesExpanded)
											}}
											onKeyDown={(event) => {
												if (event.key === ' ') {
													event.preventDefault()
													setPackagesExpanded(!packagesExpanded)
												}
											}}
											css={{
												display: 'flex',
												alignItems: 'center',
												gap: 7,
												flex: 1,
												padding: '4px 4px 4px 0',
												fontSize: 12,
												color: colors.text,
												textDecoration: 'none',
												fontWeight: showPackages ? 650 : 450,
											}}
										>
											<FileGlyph mediaType={workspaceDirectoryMediaType} />
											Apps &amp; Packages
										</SiteLink>
									</div>
									{packagesExpanded && (
										<WorkspacePackages
											orgSlug={data.orgSlug}
											query={packageDirectory}
											search={search}
											activeRepo={repo}
										/>
									)}
									{explorerRows.map(({ file, depth, hasChildren }) => (
										<div
											key={file.id}
											data-workspace-item={file.id}
											css={{
												display: 'flex',
												height: 28,
												minHeight: 28,
												boxSizing: 'border-box',
												alignItems: 'center',
												minWidth: 0,
												paddingInlineStart: depth * 12,
												borderRadius: 5,
												background:
													file.id === selected?.file.id ? hover : 'transparent',
												'&:hover': { background: hover },
											}}
										>
											{hasChildren ||
											file.mediaType === workspaceDirectoryMediaType ? (
												<button
													css={{ ...iconButton, width: 20, flexShrink: 0 }}
													aria-label={`${collapsed.has(file.id) ? 'Expand' : 'Collapse'} ${file.name}`}
													aria-expanded={!collapsed.has(file.id)}
													onClick={() => onToggleBranch(file.id)}
												>
													<WorkspaceIcon
														name={collapsed.has(file.id) ? 'right' : 'down'}
													/>
												</button>
											) : (
												<span css={{ width: 20, flexShrink: 0 }} />
											)}
											<SiteLink
												href={fileHref(file.id)}
												aria-expanded={
													file.mediaType === workspaceDirectoryMediaType
														? !collapsed.has(file.id)
														: undefined
												}
												onClick={(event) => {
													if (
														file.mediaType !== workspaceDirectoryMediaType ||
														event.detail === 0 ||
														event.metaKey ||
														event.ctrlKey ||
														event.shiftKey ||
														event.altKey
													)
														return
													event.preventDefault()
													if (event.detail === 1) onToggleBranch(file.id)
												}}
												onKeyDown={(event) => {
													if (
														file.mediaType === workspaceDirectoryMediaType &&
														event.key === ' '
													) {
														event.preventDefault()
														onToggleBranch(file.id)
													}
												}}
												aria-current={
													file.id === selected?.file.id ? 'page' : undefined
												}
												css={{
													display: 'flex',
													alignItems: 'center',
													gap: 7,
													minWidth: 0,
													padding: '4px 4px 4px 0',
													flex: 1,
													borderRadius: 5,
													fontSize: typography.fontSize.xs,
													lineHeight: 1.4,
													color: colors.text,

													fontWeight: file.id === selected?.file.id ? 650 : 450,
													textDecoration: 'none',
													'& svg': { flexShrink: 0, color: colors.textMuted },
												}}
											>
												<FileGlyph
													mediaType={file.mediaType}
													name={file.name}
												/>
												<span
													title={file.name}
													css={{
														overflow: 'hidden',
														textOverflow: 'ellipsis',
														whiteSpace: 'nowrap',
													}}
												>
													{file.name}
												</span>
											</SiteLink>
											{isWorkspaceContainer(file.mediaType) &&
												data.can_create &&
												data.writes_enabled &&
												file.access.write && (
													<SiteLink
														css={{
															...iconButton,
															flexShrink: 0,
															opacity: 0,
															'div:hover > &, &:focus-visible': { opacity: 1 },
														}}
														aria-label={`New subpage in ${file.name}`}
														title="New subpage"
														href={`/@${data.orgSlug}/-/files?new=page&parent=${file.id}`}
													>
														<WorkspaceIcon name="add" />
													</SiteLink>
												)}
										</div>
									))}
									{explorerRows.length === 0 && !packagesExpanded && (
										<WorkspaceFileStatus
											message={
												search.trim() ? 'No matching files.' : 'No files yet.'
											}
										/>
									)}
								</nav>
								<SiteLink
									href={`/@${data.orgSlug}/-/files?trash=1`}
									aria-current={showTrash ? 'page' : undefined}
									css={{
										...button,
										display: 'flex',
										alignItems: 'center',
										gap: 7,
										textDecoration: 'none',
										marginTop: 16,
										background: showTrash ? hover : 'transparent',
									}}
								>
									<svg
										aria-hidden="true"
										width="15"
										height="15"
										viewBox="0 0 16 16"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.2"
									>
										<path d="M2 4h12M6 2h4M4 4l.5 10h7L12 4M6.5 6v5.5M9.5 6v5.5" />
									</svg>
									Trash
								</SiteLink>
							</div>
						</>
					}
				>
					{(explorerToggle) => (
						<section
							aria-label={
								embedded
									? `${selected?.file.name ?? 'File'} content`
									: 'Document'
							}
							data-workspace-item={
								selected && !isDirectory ? selected.file.id : undefined
							}
							data-workspace-background=""
							data-workspace-media={fullMediaPreview || undefined}
							css={{
								minWidth: 0,
								minHeight: 0,
								display:
									!creating && (!selected || isDirectory) ? 'flex' : undefined,
								flexDirection: 'column',
								overflow: 'auto',
								background: embedded ? colors.background : undefined,
								'--workspace-panel-gutter': fullMediaPreview
									? '12px'
									: 'clamp(18px, 3vw, 32px)',
								padding: fullMediaPreview
									? 0
									: '10px clamp(18px, 3vw, 32px) 24px',
								...(fullMediaPreview
									? {
											display: 'flex',
											flexDirection: 'column' as const,
											minHeight: 0,
											overflow: 'hidden',
											'@media (max-width: 760px)': { minHeight: '70dvh' },
										}
									: {}),
							}}
						>
							{(!selected || isDirectory) && !creating ? (
								showPackages ? (
									<WorkspaceRepoBrowser
										focusHandoff={columnFocusHandoff}
										finderHover={finderHover}
										pageData={data}
										orgSlug={data.orgSlug}
										query={packageDirectory}
										repo={repo}
										path={repoPath ?? ''}
										open={repoOpen}
										search={search}
									/>
								) : showTrash ? (
									<TrashView
										orgSlug={data.orgSlug}
										files={data.trashed}
										search={search}
										busy={busy}
										onRestore={(file) => void manage(file, 'restore')}
									/>
								) : (
									<WorkspaceHome
										focusHandoff={columnFocusHandoff}
										finderHover={finderHover}
										files={data.files}
										directory={isDirectory ? selected?.file : undefined}
										pageData={data}
										finderActive={finderActive}
										onSelectionChange={onFinderSelectionChange}
										onCommitRename={(item, name) =>
											manage(item, 'rename', { name })
										}
										onRename={(item) =>
											setContextAction({ item, action: 'rename' })
										}
										search={search}
										orgSlug={data.orgSlug}
										canCreate={(id) => data.writes_enabled && canCreateIn(id)}
										onDestinationChange={setBrowseDestination}
										onUpload={() => uploadInput.current?.click()}
									/>
								)
							) : (
								<>
									<div
										css={{
											...row,
											justifyContent: 'space-between',
											marginBottom: fullMediaPreview ? 0 : spacing.md,
											...(fullMediaPreview
												? { padding: '10px 12px 0', flexShrink: 0 }
												: {}),
										}}
									>
										{creating && !isPage ? (
											<div
												css={{
													display: 'flex',
													flexWrap: 'wrap',
													alignItems: 'end',
													gap: 12,
													width: '100%',
													minWidth: 0,
												}}
											>
												<label
													css={{
														display: 'grid',
														gap: 5,
														flex: '1 1 220px',
														minWidth: 0,
														fontSize: 12,
														color: colors.textMuted,
													}}
												>
													{isDirectory ? 'Folder name' : 'File name'}
													<input
														css={accountInputCss}
														placeholder={
															isDirectory ? 'Untitled folder' : 'Untitled file'
														}
														value={name}
														maxLength={200}
														onChange={(event) => setName(event.target.value)}
													/>
												</label>
												{!isDirectory && (
													<label
														css={{
															display: 'grid',
															gap: 5,
															flex: '0 1 160px',
															minWidth: 0,
															fontSize: 12,
															color: colors.textMuted,
														}}
													>
														File type
														<select
															data-field-ring
															css={getSelectCss()}
															value={mediaType}
															onChange={(event) =>
																setMediaType(
																	event.target
																		.value as FileMetadata['mediaType'],
																)
															}
														>
															<option value="text/markdown">Markdown</option>
															<option value="text/plain">Text</option>
															<option value="text/html">HTML</option>
															<option value="text/csv">CSV</option>
														</select>
													</label>
												)}
											</div>
										) : collaboration ? null : (
											documentTitle
										)}
										<WorkspaceHeader document>
											{explorerToggle}
											{embedded && selected ? (
												<WorkspaceOpenFile href={fileHref(selected.file.id)} />
											) : (
												<>
													<WorkspaceBreadcrumbs
														files={data.files}
														directory={
															selected?.file ??
															data.files.find((file) => file.id === parentId)
														}
														orgSlug={data.orgSlug}
													/>
													<WorkspaceCreateMenu
														canManageStorage={
															data.canManageStorage && data.collaborationEnabled
														}
														canCreate={
															data.writes_enabled &&
															canCreateIn(selected?.file.parentId ?? parentId)
														}
														orgSlug={data.orgSlug}
														parentId={selected?.file.parentId ?? parentId}
														onUpload={() => uploadInput.current?.click()}
													/>
												</>
											)}
											<span css={{ flex: 1 }} />
											{collaboration && (
												<div
													data-collaboration-toolbar=""
													ref={collaborationToolbar}
												/>
											)}

											{!binary &&
												!isPage &&
												!isDirectory &&
												(!nativeKind ||
													nativeKind === 'json' ||
													currentType === 'image/svg+xml') && (
													<button
														css={button}
														aria-pressed={preview}
														onClick={() => setPreview(!preview)}
													>
														{preview
															? editable
																? 'Edit'
																: 'Source'
															: 'Preview'}
													</button>
												)}

											{!collaboration &&
												isPage &&
												!historical &&
												(!creating || dirty) && (
													<span
														role="status"
														css={{
															color: colors.textMuted,
															fontSize: typography.fontSize.xs,
														}}
													>
														{conflict || message
															? 'Not saved'
															: saving
																? 'Saving…'
																: dirty
																	? 'Unsaved'
																	: 'Saved'}
													</span>
												)}
											{selected && (
												<div
													css={{ position: 'relative' }}
													onKeyDown={(event) => {
														if (event.key === 'Escape') setActionsOpen(false)
													}}
												>
													<button
														css={iconButton}
														aria-label="More actions"
														title="More actions"
														aria-expanded={actionsOpen}
														onClick={() => setActionsOpen(!actionsOpen)}
													>
														<WorkspaceIcon name="more" />
													</button>
													{actionsOpen && (
														<div css={menuCss}>
															{binary && editable && !historical && (
																<button
																	css={button}
																	disabled={busy}
																	onClick={() => {
																		setActionsOpen(false)
																		replacementInput.current?.click()
																	}}
																>
																	Replace file
																</button>
															)}
															{selected.access.write && (
																<>
																	<button
																		css={button}
																		disabled={busy || dirty}
																		onClick={() => {
																			setActionsOpen(false)
																			setContextAction({
																				item: {
																					...selected.file,
																					access: selected.access,
																				},
																				action: 'rename',
																			})
																		}}
																	>
																		Rename
																	</button>
																	<button
																		css={button}
																		disabled={busy || dirty}
																		onClick={() => {
																			setActionsOpen(false)
																			setContextAction({
																				item: {
																					...selected.file,
																					access: selected.access,
																				},
																				action: 'move',
																			})
																		}}
																	>
																		Move to…
																	</button>
																</>
															)}
															<button
																css={button}
																onClick={() => {
																	setActionsOpen(false)
																	setHistoryOpen(!historyOpen)
																}}
															>
																Version history
															</button>
															<button
																css={button}
																onClick={() => {
																	setActionsOpen(false)
																	setContextAction({
																		item: {
																			...selected.file,
																			access: selected.access,
																		},
																		action: 'details',
																	})
																}}
															>
																Details &amp; permissions
															</button>
															{isPage && (
																<button
																	css={button}
																	onClick={() => {
																		setActionsOpen(false)
																		exportMarkdown({
																			name: selected.file.name,
																			content: historical?.content ?? draft,
																		})
																	}}
																>
																	Export Markdown
																</button>
															)}
															<button
																css={button}
																onClick={() => {
																	setActionsOpen(false)
																	download()
																}}
															>
																{isPage ? 'Download JSON' : 'Download'}
															</button>
															{selected.access.delete && (
																<button
																	css={{ ...button, color: colors.danger }}
																	disabled={busy || dirty}
																	onClick={() => {
																		setActionsOpen(false)
																		setContextAction({
																			item: {
																				...selected.file,
																				access: selected.access,
																			},
																			action: 'trash',
																		})
																	}}
																>
																	Move to trash
																</button>
															)}
														</div>
													)}
												</div>
											)}
											{binary && editable && !historical && (
												<>
													<input
														ref={replacementInput}
														type="file"
														hidden
														onChange={(event) => {
															const file = event.currentTarget.files?.[0]
															event.currentTarget.value = ''
															if (file) void upload(file, true)
														}}
													/>
												</>
											)}
											{editable &&
												(!isPage || !!message || !!conflict || historical) &&
												(creating || dirty || historical) && (
													<button
														css={primary}
														disabled={busy || (!dirty && !historical)}
														onClick={() =>
															void save(historical?.content ?? draft)
														}
													>
														{saving
															? 'Saving…'
															: historical
																? 'Restore version'
																: 'Save'}
													</button>
												)}
										</WorkspaceHeader>
									</div>
									{message && <p role="status">{message}</p>}
									{historyOpen && selected && (
										<section
											aria-label="Version history"
											css={{
												...panel,
												marginBottom: spacing.md,
												display: 'flex',
												flexWrap: 'wrap',
												alignItems: 'end',
												gap: 8,
											}}
										>
											<label
												css={{
													display: 'grid',
													gap: 4,
													flex: '1 1 230px',
													minWidth: 0,
													maxWidth: 440,
													fontSize: 12,
													color: colors.textMuted,
												}}
											>
												Version
												<select
													data-field-ring
													css={{
														...getSelectCss(),
														minWidth: 0,
														textOverflow: 'ellipsis',
													}}
													aria-label="Version"
													disabled={busy}
													value={historical?.id ?? ''}
													onChange={async (event) => {
														const id = event.target.value
														if (!id) {
															setHistorical(null)
															return
														}
														setBusy(true)
														try {
															const result = await readFilePreview({
																data: {
																	orgSlug: data.orgSlug,
																	fileId,
																	revisionId: id,
																},
															})
															setHistorical({
																content: result.file.content,
																id,
															})
															setPreview(true)
														} catch {
															setMessage('Could not load this version.')
														} finally {
															setBusy(false)
														}
													}}
												>
													<option value="">
														{dirty ? 'Current draft' : 'Current version'}
													</option>
													{[...historyRows].reverse().map((revision) => (
														<option key={revision.id} value={revision.id}>
															{new Date(revision.createdAt).toLocaleString()} ·{' '}
															{revision.author}
														</option>
													))}
												</select>
											</label>
											{historyCursor && (
												<button
													css={button}
													disabled={busy}
													onClick={async () => {
														if (!selected) return
														setBusy(true)
														try {
															const page = await readFileHistory({
																data: {
																	orgSlug: data.orgSlug,
																	fileId: selected.file.id,
																	cursor: historyCursor,
																},
															})
															setOlderHistory((current) => ({
																...current,
																[selected.file.id]: {
																	revisions: [
																		...(current[selected.file.id]?.revisions ??
																			[]),
																		...page.revisions,
																	],
																	cursor: page.nextCursor,
																},
															}))
														} catch {
															setMessage('Could not load older versions.')
														} finally {
															setBusy(false)
														}
													}}
												>
													Load older versions
												</button>
											)}
										</section>
									)}
									{conflict && (
										<section
											aria-label="Save conflict"
											css={{
												...panel,
												display: 'grid',
												gap: 10,
												marginBottom: spacing.md,
												background: colors.surface,
											}}
										>
											<h3 css={{ margin: 0, fontSize: 15 }}>
												Someone saved a newer version
											</h3>
											<p
												role="status"
												css={{
													margin: 0,
													color: colors.textMuted,
													fontSize: 13,
												}}
											>
												Your draft is still here. Choose which version to keep.
											</p>
											{binary ? (
												<a
													css={{
														...button,
														justifySelf: 'start',
														textDecoration: 'none',
													}}
													href={fileAssetUrl(
														data.orgSlug,
														fileId,
														conflict.revisionId,
														true,
													)}
												>
													Download latest version
												</a>
											) : (
												<pre
													role="region"
													aria-label="Latest version"
													// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to scroll long revisions.
													tabIndex={0}
													css={{
														margin: 0,
														padding: '10px 12px',
														background: colors.background,
														border: `1px solid ${colors.borderSubtle}`,
														borderRadius: 6,
														whiteSpace: 'pre-wrap',
														overflowWrap: 'anywhere',
														maxHeight: '25vh',
														overflow: 'auto',
													}}
												>
													{conflict.content}
												</pre>
											)}
											<div css={row}>
												<button
													css={button}
													onClick={() => {
														setDraft(binary ? '' : conflict.content)
														setSaved(binary ? '' : conflict.content)
														setBase(conflict.revisionId)
														setHistorical(null)
														setConflict(null)
														setPendingWrite(null)
													}}
												>
													Load latest
												</button>
												<button
													css={primary}
													disabled={busy}
													onClick={() =>
														void save(
															historical?.content ?? draft,
															conflict.revisionId,
														)
													}
												>
													Save my version
												</button>
											</div>
										</section>
									)}
									{historical && (
										<p
											role="status"
											css={{
												color: colors.textMuted,
												fontSize: 12,
												margin: '0 0 12px',
											}}
										>
											Viewing a saved version. Restoring creates a new revision.
										</p>
									)}
									{isDirectory ? (
										selected ? (
											<WorkspaceHome
												files={data.files}
												search={search}
												orgSlug={data.orgSlug}
												canCreate={(id) =>
													data.writes_enabled && canCreateIn(id)
												}
												directory={selected.file}
												canManageStorage={
													data.canManageStorage && data.collaborationEnabled
												}
												onDestinationChange={setBrowseDestination}
												onUpload={() => uploadInput.current?.click()}
											/>
										) : null
									) : collaboration && selected ? (
										<Suspense
											fallback={<LoadingIndicator label="Connecting to file" />}
										>
											<CollaborativeFileView
												key={selected.file.id}
												orgSlug={data.orgSlug}
												fileId={selected.file.id}
												personId={data.personId}
												name={selected.file.name}
												mediaType={currentType}
												content={draft}
												files={assetFiles}
												renderFile={renderEmbed}
												loadLinkTitle={loadLinkTitle}
												toolbarRef={collaborationToolbar}
												canManageStorage={data.canManageStorage}
												revisionId={selected.file.revisionId!}
												onVersionChange={
													binary
														? () => {
																void refresh()
															}
														: undefined
												}
												title={documentTitle}
												pageChildren={data.files
													.filter(
														(file) =>
															file.parentId === selected.file.id &&
															!embeddedFileIds.has(file.id),
													)
													.map((file) => (
														<SiteLink
															key={file.id}
															data-workspace-item={file.id}
															href={fileHref(file.id)}
															css={{
																display: 'flex',
																gap: 8,
																alignItems: 'center',
																padding: '5px 0',
															}}
														>
															<FileGlyph
																mediaType={file.mediaType}
																name={file.name}
															/>
															{file.name}
														</SiteLink>
													))}
												renderPreview={
													binary || showFileViewer
														? (content) => (
																<FileViewer
																	orgSlug={data.orgSlug}
																	fileId={selected.file.id}
																	revisionId={null}
																	name={selected.file.name}
																	mediaType={currentType}
																	content={binary ? undefined : content}
																/>
															)
														: preview && !isPage
															? (content) => (
																	<FilePreview
																		orgSlug={data.orgSlug}
																		content={content}
																		mediaType={currentType}
																		fill={fullHtmlPreview}
																	/>
																)
															: undefined
												}
											/>
										</Suspense>
									) : isPage ? (
										<div
											css={{
												maxWidth: workspaceProse.width,
												margin: '0 auto',
												padding: '0 0 38px',
											}}
										>
											<Suspense
												fallback={<LoadingIndicator label="Loading page" />}
											>
												<WorkspacePageEditor
													content={historical?.content ?? draft}
													onChange={
														editable &&
														!historical &&
														(!busy || (saving && !creating))
															? setDraft
															: undefined
													}
													files={assetFiles}
													renderFile={renderEmbed}
													loadLinkTitle={loadLinkTitle}
												/>
											</Suspense>
											{selected &&
												data.files
													.filter(
														(file) =>
															file.parentId === selected.file.id &&
															!embeddedFileIds.has(file.id),
													)
													.map((file) => (
														<SiteLink
															key={file.id}
															data-workspace-item={file.id}
															href={fileHref(file.id)}
															css={{
																display: 'flex',
																gap: 8,
																alignItems: 'center',
																padding: '5px 0',
															}}
														>
															<FileGlyph
																mediaType={file.mediaType}
																name={file.name}
															/>
															{file.name}
														</SiteLink>
													))}
										</div>
									) : binary || showFileViewer ? (
										<FileViewer
											orgSlug={data.orgSlug}
											fileId={fileId}
											revisionId={historical?.id ?? base}
											name={selected?.file.name ?? name}
											mediaType={currentType}
											content={
												binary ? undefined : (historical?.content ?? draft)
											}
										/>
									) : preview || historical ? (
										<FilePreview
											orgSlug={data.orgSlug}
											content={historical?.content ?? draft}
											mediaType={currentType}
											fill={fullHtmlPreview}
										/>
									) : (
										<textarea
											css={sourceCss}
											aria-label="Document text"
											spellCheck={false}
											readOnly={!editable || busy}
											value={draft}
											onChange={(event) => {
												setDraft(event.target.value)
												setMessage('')
											}}
											onKeyDown={(event) => {
												if (
													(event.metaKey || event.ctrlKey) &&
													event.key === 's'
												) {
													event.preventDefault()
													void save()
												}
											}}
										/>
									)}
									<div
										css={{
											...row,
											justifyContent: 'space-between',
											marginTop: fullMediaPreview ? 0 : spacing.sm,
											display: fullMediaPreview && !dirty ? 'none' : 'flex',
											flexShrink: 0,
											color: colors.textMuted,
											fontSize: typography.fontSize.xs,
										}}
									>
										<span>{dirty && !isPage && 'Unsaved changes'}</span>
									</div>
								</>
							)}
						</section>
					)}
				</WorkspaceExplorerLayout>
			</section>
			{contextAction?.action === 'details' && (
				<Suspense fallback={<LoadingIndicator label="Loading permissions" />}>
					<FilePermissionsPanel
						key={contextAction.item.id}
						item={contextAction.item}
						orgSlug={data.orgSlug}
						onClose={() => setContextAction(null)}
						onAccessChange={() => {
							void router.invalidate()
						}}
					/>
				</Suspense>
			)}
			{contextAction && contextAction.action !== 'details' && (
				<FileActionDialog
					collaborationEnabled={data.collaborationEnabled}
					key={contextAction.item.id + contextAction.action}
					item={contextAction.item}
					action={contextAction.action}
					destinations={data.files
						.filter(
							(file) =>
								isWorkspaceContainer(file.mediaType) &&
								file.access.write &&
								!isDescendant(data.files, file.id, contextAction.item.id),
						)
						.map((file) => ({
							id: file.id,
							name: itemPath(data.files, file.id),
						}))}
					canCreate={data.can_create}
					busy={busy}
					orgSlug={data.orgSlug}
					onClose={() => setContextAction(null)}
					onSubmit={(changes) => {
						if (contextAction.action === 'details')
							return Promise.resolve(false)
						return manage(contextAction.item, contextAction.action, changes)
					}}
				/>
			)}
		</ContextMenuSurface>
	)
}
function isDescendant(files: FileMetadata[], id: string, ancestorId: string) {
	const visited = new Set<string>()
	let current: string | undefined = id
	while (current && !visited.has(current)) {
		if (current === ancestorId) return true
		visited.add(current)
		current = files.find((file) => file.id === current)?.parentId
	}
	return false
}

function itemPath(files: FileMetadata[], id: string) {
	const path: string[] = []
	const visited = new Set<string>()
	let current: string | undefined = id
	while (current && !visited.has(current)) {
		visited.add(current)
		const file = files.find((file) => file.id === current)
		if (!file) break
		path.unshift(file.name)
		current = file.parentId
	}
	return path.join(' / ')
}

function TrashView({
	orgSlug,
	files,
	search,
	busy,
	onRestore,
}: {
	orgSlug: string
	files: PageData['trashed']
	search: string
	busy: boolean
	onRestore: (file: FileMetadata) => void
}) {
	const ids = new Set(files.map((file) => file.id))
	const visible = files.filter(
		(file) =>
			(search || !file.parentId || !ids.has(file.parentId)) &&
			file.name.toLowerCase().includes(search.toLowerCase()),
	)
	return (
		<div css={{ width: '100%', margin: '8px auto 0' }}>
			<WorkspaceHeader>
				<WorkspaceBreadcrumbs
					files={[]}
					orgSlug={orgSlug}
					collection={{ name: 'Trash', href: `/@${orgSlug}/-/files?trash=1` }}
				/>
			</WorkspaceHeader>
			<ul css={{ listStyle: 'none', margin: 0, padding: 0 }}>
				{visible.map((file) => (
					<li
						key={file.id}
						data-workspace-item={file.id}
						css={{
							...row,
							padding: '8px 10px',
							minHeight: 36,
							borderBottom: `1px solid ${colors.borderSubtle}`,
						}}
					>
						<FileGlyph mediaType={file.mediaType} name={file.name} />
						<span
							title={file.name}
							css={{
								flex: 1,
								minWidth: 0,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{file.name}
						</span>
						{file.access.delete && (
							<button
								css={button}
								aria-label={`Restore ${file.name}`}
								disabled={busy}
								onClick={() => onRestore(file)}
							>
								Restore
							</button>
						)}
					</li>
				))}
			</ul>
			{!visible.length && (
				<WorkspaceFileStatus
					message={search ? 'No matches.' : 'Trash is empty.'}
				/>
			)}
		</div>
	)
}

function WorkspaceRepoBrowser({
	focusHandoff,
	finderHover,
	pageData,
	orgSlug,
	query,
	repo,
	path,
	open,
	search,
}: {
	focusHandoff: RefObject<string | null>
	finderHover: [boolean, (value: boolean) => void]
	pageData: PageData
	orgSlug: string
	query: ReturnType<typeof useWorkspacePackages>
	repo?: string
	path: string
	open?: boolean
	search: string
}) {
	const router = useRouter()
	const { actorKey } = useMatchedPageScope()
	const owner = query.data?.profile.username ?? orgSlug
	const repos = (query.data?.packages ?? []).filter(
		(item) => item.canOpenDetail !== false,
	)
	const selectedRepo = repos.find((item) => item.kodyId === repo)
	const tree = useQuery({
		queryKey: ['workspace-repo-tree', actorKey, owner, repo],
		enabled: !!selectedRepo,
		queryFn: () =>
			loadWorkspaceRepoFiles({
				data: { username: owner, kodyId: selectedRepo!.kodyId, path: '' },
			}),
	})
	const entries = new Map<
		string,
		{ repo: string; path: string; file: PageData['files'][number] }
	>()
	function add(
		item: (typeof repos)[number],
		path: string,
		folder: boolean,
		parentId?: string,
	) {
		const id = encodeURIComponent(JSON.stringify([item.kodyId, path]))
		if (!entries.has(id)) {
			const name = path.split('/').at(-1) || item.name
			entries.set(id, {
				repo: item.kodyId,
				path,
				file: {
					id,
					name,
					parentId,
					mediaType: folder
						? workspaceDirectoryMediaType
						: detectFileMediaType(name, ''),
					revisionId: null,
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
					revisions: [],
					access: {
						write: false,
						delete: false,
						manage_access: false,
						comment: false,
					},
				},
			})
		}
		return id
	}
	for (const item of repos) {
		const id = add(item, '', true, packagesFolder.id)
		if (item.kodyId !== selectedRepo?.kodyId) continue
		for (const filePath of tree.data?.paths ?? []) {
			const parts = filePath.split('/')
			let parentId = id
			for (let index = 0; index < parts.length; index++)
				parentId = add(
					item,
					parts.slice(0, index + 1).join('/'),
					index < parts.length - 1,
					parentId,
				)
		}
	}
	const root = packagesDirectoryHref(orgSlug)
	const href = (id: string) => {
		const entry = entries.get(id)
		return entry
			? repoWorkspaceHref(orgSlug, entry.repo, entry.path)
			: id === packagesFolder.id
				? root
				: `/@${orgSlug}/-/files?file=${id}`
	}
	const active = entries.get(
		encodeURIComponent(JSON.stringify([repo, path])),
	)?.file
	const loadingRepoId =
		selectedRepo && tree.isPending
			? encodeURIComponent(JSON.stringify([selectedRepo.kodyId, '']))
			: undefined

	const folder = active && isWorkspaceContainer(active.mediaType)
	const directory = folder
		? active
		: active?.parentId
			? entries.get(active.parentId)?.file
			: undefined

	const openHref = (id: string) => {
		const entry = entries.get(id)
		return entry && !isWorkspaceContainer(entry.file.mediaType)
			? repoWorkspaceHref(orgSlug, entry.repo, entry.path, true)
			: href(id)
	}
	const fullFile = open && active && !folder && selectedRepo
	useHotkey(
		'Escape',
		(event) => {
			if (!fullFile || !active) return
			event.preventDefault()
			focusHandoff.current = active.id
			void router.navigate({ href: href(active.id), resetScroll: false })
		},
		{ enabled: Boolean(fullFile), preventDefault: false },
	)
	if (fullFile && active)
		return (
			<WorkspaceRepoPreview
				owner={owner}
				repo={selectedRepo.kodyId}
				path={path}
				refName={tree.data?.commit}
				file={active}
				orgSlug={orgSlug}
				header={
					<WorkspaceBreadcrumbs
						files={[...entries.values()].map(({ file }) => file)}
						directory={active}
						orgSlug={orgSlug}
						itemHref={href}
						collection={{ name: 'Apps & Packages', href: root }}
					/>
				}
			/>
		)

	if (isNotFound(query.error))
		return (
			<WorkspaceFileStatus message="You don’t have access to repositories in this workspace." />
		)
	if (query.isError)
		return (
			<WorkspaceFileStatus
				message="Could not load repositories."
				action={{ label: 'Try again', run: () => void query.refetch() }}
			/>
		)
	return (
		<>
			{repo && !query.isPending && !selectedRepo && (
				<WorkspaceFileStatus message="Repository unavailable." />
			)}
			{selectedRepo && tree.isSuccess && path && !active && (
				<WorkspaceFileStatus message="File or folder unavailable." />
			)}
			{tree.isError && (
				<WorkspaceFileStatus
					message="Could not load repository files."
					action={{ label: 'Try again', run: () => void tree.refetch() }}
				/>
			)}
			<WorkspaceHome
				focusHandoff={focusHandoff}
				finderHover={finderHover}
				files={Array.from(entries.values(), (entry) => entry.file)}
				directory={directory}
				finderActive={active?.id ?? loadingRepoId}
				onSelectionChange={(id) => {
					const inRepositories =
						id && (entries.has(id) || id === packagesFolder.id)
					if (id && !inRepositories) focusHandoff.current = id
					void router.navigate({
						href: inRepositories
							? href(id)
							: `/@${orgSlug}/-/files${id ? `?active=${id}` : ''}`,
						resetScroll: false,
					})
				}}
				search={search}
				orgSlug={orgSlug}
				canCreate={() => false}
				repoBrowser={{
					loadingFolderId: query.isPending ? packagesFolder.id : loadingRepoId,
					columnFiles: [
						packagesFolder,
						...pageData.files,
						...Array.from(entries.values(), (entry) => entry.file),
					],
					href,
					openHref,
					opened: folder ? undefined : active,
					actions: selectedRepo && (
						<>
							{selectedRepo.hasApp && (
								<SiteLink
									css={button}
									reloadDocument
									href={buildPackageAppOpenPath({
										username: owner,
										kodyId: selectedRepo.kodyId,
									})}
								>
									Open app
								</SiteLink>
							)}
							<SiteLink
								css={button}
								href={routes.communityPackage.href({
									username: owner,
									kodyId: selectedRepo.kodyId,
								})}
							>
								{selectedRepo.hasPackage
									? 'Package details'
									: 'Repository details'}
							</SiteLink>
						</>
					),
					renderPreview: (file) => {
						const entry = entries.get(file.id)
						return entry && !isWorkspaceContainer(file.mediaType) ? (
							<WorkspaceRepoPreview
								owner={owner}
								repo={entry.repo}
								path={entry.path}
								refName={tree.data?.commit}
								file={file}
								orgSlug={orgSlug}
								inline
								header={<WorkspaceOpenFile href={openHref(file.id)} />}
							/>
						) : pageData.files.some((item) => item.id === file.id) ? (
							<WorkspaceDocumentPanel data={pageData} metadata={file} />
						) : null
					},
				}}
			/>
		</>
	)
}

function WorkspaceOpenFile({ href }: { href: string }) {
	return (
		<SiteLink
			href={href}
			css={{
				...button,
				display: 'inline-flex',
				alignItems: 'center',
				gap: 6,
				textDecoration: 'none',
			}}
		>
			<WorkspaceIcon name="open" />
			Open
		</SiteLink>
	)
}

function WorkspaceRepoPreview(
	props: Parameters<typeof WorkspaceRepoPreviewContent>[0] & {
		header: ReactNode
		inline?: boolean
	},
) {
	const { header, inline, ...preview } = props
	return (
		<div
			css={{
				display: 'flex',
				flexDirection: 'column',
				flex: 1,
				minHeight: 0,
				'& > [data-workspace-toolbar]': {
					'--workspace-panel-gutter': inline ? '0px' : undefined,
					paddingBlock: inline ? 7 : undefined,
				},
			}}
		>
			<WorkspaceHeader document>{header}</WorkspaceHeader>
			<WorkspaceRepoPreviewContent {...preview} />
		</div>
	)
}

function WorkspaceRepoPreviewContent({
	owner,
	repo,
	path,
	refName,
	file,
	orgSlug,
}: {
	owner: string
	repo: string
	path: string
	refName?: string
	file: FileMetadata
	orgSlug: string
}) {
	const { actorKey } = useMatchedPageScope()
	const query = useQuery({
		queryKey: ['workspace-repo-preview', actorKey, owner, repo, path, refName],
		queryFn: () =>
			loadWorkspaceRepoFiles({
				data: { username: owner, kodyId: repo, path, ref: refName },
			}),
	})
	if (query.isPending) return <LoadingIndicator label="Loading file" />
	if (query.isError)
		return (
			<WorkspaceFileStatus
				message="Could not load this file."
				action={{ label: 'Try again', run: () => void query.refetch() }}
			/>
		)
	const { content, mediaHref, rawHref } = query.data
	const assetUrl = mediaHref ?? rawHref
	if (fileViewerKind(file.name, file.mediaType) && assetUrl)
		return (
			<FileViewer
				orgSlug={orgSlug}
				fileId={file.id}
				revisionId={null}
				name={file.name}
				mediaType={file.mediaType}
				content={content ?? undefined}
				assetUrl={assetUrl}
			/>
		)
	if (content != null)
		return (
			<FilePreview
				orgSlug={orgSlug}
				content={content}
				mediaType={file.mediaType}
			/>
		)
	return (
		<WorkspaceFileStatus
			message="Preview unavailable."
			action={rawHref ? { label: 'Open raw file', href: rawHref } : undefined}
		/>
	)
}

function WorkspaceHome({
	files,
	focusHandoff,
	finderHover,
	repoBrowser,
	search,
	orgSlug,
	canCreate,
	directory,
	onDestinationChange,
	onUpload,
	pageData,
	canManageStorage = pageData?.canManageStorage &&
		pageData.collaborationEnabled,
	finderActive,
	onSelectionChange,
	onRename,
	onCommitRename,
}: {
	repoBrowser?: {
		columnFiles: FileMetadata[]
		loadingFolderId?: string
		href: (id: string) => string
		openHref: (id: string) => string
		renderPreview: (file: FileMetadata) => ReactNode
		opened?: FileMetadata
		actions?: ReactNode
	}
	focusHandoff?: RefObject<string | null>
	finderHover?: [boolean, (value: boolean) => void]
	pageData?: PageData
	canManageStorage?: boolean
	finderActive?: string
	onSelectionChange?: (id: string | undefined) => void
	onCommitRename?: (
		item: PageData['files'][number],
		name: string,
	) => Promise<boolean | undefined>
	onRename?: (item: PageData['files'][number]) => void
	files: PageData['files']
	search: string
	orgSlug: string
	canCreate: (id?: string) => boolean
	onUpload?: () => void
	directory?: FileMetadata
	onDestinationChange?: (id: string | undefined) => void
}) {
	const filter = 'all' as 'all' | 'pages' | 'folders' | 'files'
	const localHover = useState(true)
	const [pointerHover, setPointerHover] = finderHover ?? localHover
	const [columnParent, setColumnParent] = useState<string | undefined>(
		directory?.id,
	)
	const creationParent = columnParent ?? directory?.id
	const { ready, view, thumbnailSize, changeView, resizeThumbnails } =
		useFileBrowserPreferences()
	const browserRoot = useRef<HTMLDivElement>(null)
	const [renamingId, setRenamingId] = useState<string | null>(null)
	const router = useRouter()
	useFileItemHotkeys({
		target: browserRoot,
		onOpen: (id) => {
			void router.navigate({
				href:
					id === 'system:packages'
						? packagesDirectoryHref(orgSlug)
						: (repoBrowser?.openHref(id) ?? `/@${orgSlug}/-/files?file=${id}`),
			})
		},
		onRename: (id) => {
			const item = files.find((file) => file.id === id)
			if (item?.access.write) {
				if (view === 'columns' && !search) setRenamingId(id)
				else onRename?.(item)
			}
		},
	})

	useHotkey(
		'Escape',
		(event) => {
			if (event.defaultPrevented || !onSelectionChange) return
			const item = (event.target as Element).closest<HTMLElement>(
				'[data-browser-item]',
			)
			const file = files.find((file) => file.id === item?.dataset.browserItem)
			if (!file) return
			event.preventDefault()
			onSelectionChange(file.parentId)
			const parent = file.parentId
				? browserRoot.current?.querySelector<HTMLElement>(
						`[data-browser-item="${file.parentId}"]`,
					)
				: browserRoot.current?.querySelector<HTMLElement>(
						'nav[aria-label="Workspace root"]',
					)
			parent?.focus({ preventScroll: true })
		},
		{
			target: browserRoot,
			ignoreInputs: true,
			ignoreDefaultPrevented: true,
			preventDefault: false,
		},
	)

	const flat = !!search
	useEffect(() => {
		if (view !== 'columns' || flat) {
			const active =
				view === 'gallery'
					? files.find((file) => file.id === finderActive)
					: undefined
			const id = active
				? isWorkspaceContainer(active.mediaType)
					? active.id
					: active.parentId
				: directory?.id
			setColumnParent(id)
			onDestinationChange?.(id)
		}
	}, [view, flat, directory?.id, onDestinationChange, finderActive, files])

	const [sort, setSort] = useState<'updated' | 'name'>('name')
	const byId = new Map(files.map((file) => [file.id, file]))
	const visible = files
		.filter(
			(file) =>
				(directory
					? file.parentId === directory.id
					: flat || !file.parentId || !byId.has(file.parentId)) &&
				file.name.toLowerCase().includes(search.toLowerCase()) &&
				(filter === 'all' ||
					(filter === 'pages' && file.mediaType === workspacePageMediaType) ||
					(filter === 'folders' &&
						file.mediaType === workspaceDirectoryMediaType) ||
					(filter === 'files' && !isWorkspaceContainer(file.mediaType))),
		)
		.sort((a, b) =>
			sort === 'name'
				? a.name.localeCompare(b.name)
				: b.updatedAt.localeCompare(a.updatedAt) ||
					a.name.localeCompare(b.name),
		)
	const galleryActive = files.find((file) => file.id === finderActive)
	const galleryFiles =
		!flat &&
		galleryActive &&
		!visible.some((file) => file.id === galleryActive.id)
			? files
					.filter((file) => file.parentId === galleryActive.parentId)
					.sort((a, b) =>
						sort === 'name'
							? a.name.localeCompare(b.name)
							: b.updatedAt.localeCompare(a.updatedAt),
					)
			: visible

	const href =
		repoBrowser?.href ?? ((id: string) => `/@${orgSlug}/-/files?file=${id}`)
	const [tableToolbar, setTableToolbar] = useState<HTMLDivElement | null>(null)
	const [tableState, setTableState] = useState<RecordTableOptions['state']>({
		sorting: [{ id: 'name', desc: false }],
		columnFilters: [],
		globalFilter: '',
		pagination: { pageIndex: 0, pageSize: 50 },
	})

	const typeName = (file: FileMetadata) =>
		file.mediaType === workspaceDirectoryMediaType
			? 'Folder'
			: file.mediaType === workspacePageMediaType
				? 'Page'
				: file.mediaType === 'text/markdown'
					? 'Markdown'
					: file.mediaType === 'text/csv'
						? 'CSV'
						: file.mediaType === 'text/html'
							? 'HTML'
							: file.mediaType.startsWith('image/')
								? 'Image'
								: 'File'
	if (!ready) return <LoadingIndicator label="Loading files" />

	return (
		<div
			ref={browserRoot}
			data-upload-directory={directory?.id ?? ''}
			onKeyDownCapture={(event) => {
				if (
					[
						'ArrowDown',
						'ArrowUp',
						'ArrowLeft',
						'ArrowRight',
						'Home',
						'End',
					].includes(event.key)
				)
					setPointerHover(false)
			}}
			onPointerMoveCapture={(event) => {
				if (event.pointerType === 'mouse') setPointerHover(true)
			}}
			css={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}
		>
			<div
				css={{
					margin: '8px auto 0',
					display: 'flex',
					flexDirection: 'column',
					minHeight: 0,
					flex: 1,
					width: '100%',
					maxWidth: undefined,
				}}
			>
				<WorkspaceHeader>
					{view === 'columns' ? (
						<h1 css={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Files</h1>
					) : (
						<WorkspaceBreadcrumbs
							files={files}
							directory={repoBrowser?.opened ?? directory}
							orgSlug={orgSlug}
							itemHref={repoBrowser?.href}
							collection={
								repoBrowser
									? {
											name: 'Apps & Packages',
											href: packagesDirectoryHref(orgSlug),
										}
									: undefined
							}
						/>
					)}
					{repoBrowser?.actions}
					<WorkspaceCreateMenu
						canManageStorage={canManageStorage}
						canCreate={canCreate(creationParent)}
						orgSlug={orgSlug}
						parentId={creationParent}
						onUpload={() => onUpload?.()}
					/>

					{view === 'list' ? (
						<div
							ref={setTableToolbar}
							css={{ display: 'flex', flex: 1, minWidth: 160, marginLeft: 8 }}
						/>
					) : (
						<span css={{ flex: 1 }} />
					)}
					{view !== 'list' && (
						<Combobox
							id="workspace-sort"
							compact
							label="Sort workspace"
							hideLabel
							selectOnly
							value={sort}
							options={[
								{ id: 'updated', label: 'Recently edited' },
								{ id: 'name', label: 'Name' },
							]}
							onChange={(value) =>
								setSort(value === 'name' ? 'name' : 'updated')
							}
						/>
					)}
					{view === 'icons' && (
						<ThumbnailSizeControl
							size={thumbnailSize}
							onChange={resizeThumbnails}
						/>
					)}
					<WorkspaceViewControls
						view={view}
						changeView={changeView}
						browserRoot={browserRoot}
					/>
				</WorkspaceHeader>

				{repoBrowser?.loadingFolderId && (view !== 'columns' || flat) ? (
					<LoadingIndicator label="Loading repository files" />
				) : repoBrowser?.opened && (view === 'icons' || view === 'list') ? (
					repoBrowser.renderPreview(repoBrowser.opened)
				) : view === 'columns' && !flat ? (
					<WorkspaceFileBrowser
						focusHandoff={focusHandoff}
						renamingId={renamingId}
						onRenameDone={() => {
							const id = renamingId
							setRenamingId(null)
							if (id)
								browserRoot.current
									?.querySelector<HTMLElement>(`[data-browser-item="${id}"]`)
									?.focus({ preventScroll: true })
						}}
						onCommitRename={(id, name) => {
							const item = files.find((file) => file.id === id)
							return item && onCommitRename
								? onCommitRename(item, name)
								: Promise.resolve(false)
						}}
						pointerHover={pointerHover}
						fullPreview={!!pageData || !!repoBrowser}
						systemFolder={repoBrowser ? undefined : packagesFolder}
						loadingFolderId={repoBrowser?.loadingFolderId}
						itemHref={repoBrowser?.href}
						openHref={repoBrowser?.openHref}
						filter={filter}
						files={[...(repoBrowser?.columnFiles ?? files)].sort((a, b) =>
							sort === 'name'
								? a.name.localeCompare(b.name)
								: b.updatedAt.localeCompare(a.updatedAt) ||
									a.name.localeCompare(b.name),
						)}
						rootId={
							finderActive === 'root'
								? undefined
								: (finderActive ??
									directory?.id ??
									(repoBrowser ? packagesFolder.id : undefined))
						}
						selectionKey={
							finderActive ?? (repoBrowser ? packagesFolder.id : undefined)
						}
						onSelectionChange={onSelectionChange}
						orgSlug={orgSlug}
						onDestinationChange={(id) => {
							if (id === packagesFolder.id) return
							setColumnParent(id)
							onDestinationChange?.(id)
						}}
						renderIcon={(file) => (
							<FileGlyph mediaType={file.mediaType} name={file.name} />
						)}
						renderPreview={(file) =>
							repoBrowser ? (
								repoBrowser.renderPreview(file)
							) : pageData ? (
								<WorkspaceDocumentPanel data={pageData} metadata={file} />
							) : (
								<FileEmbed
									chrome={false}
									metadata={file}
									orgSlug={orgSlug}
									href={href(file.id)}
								/>
							)
						}
					/>
				) : view === 'gallery' && flat && !galleryFiles.length ? (
					<WorkspaceFileStatus message="No matching files." />
				) : view === 'gallery' ? (
					<WorkspaceGallery
						itemHref={repoBrowser?.href}
						files={galleryFiles}
						orgSlug={orgSlug}
						activeId={finderActive}
						onSelect={onSelectionChange}
						pointerHover={pointerHover}
						renderIcon={(file) => (
							<FileGlyph mediaType={file.mediaType} name={file.name} />
						)}
						renderPreview={(file) =>
							repoBrowser ? (
								repoBrowser.renderPreview(file)
							) : pageData ? (
								<WorkspaceDocumentPanel data={pageData} metadata={file} />
							) : (
								<FileEmbed
									chrome={false}
									metadata={file}
									orgSlug={orgSlug}
									href={href(file.id)}
								/>
							)
						}
					/>
				) : view === 'icons' &&
				  flat &&
				  !visible.length &&
				  (repoBrowser ||
						directory ||
						!'apps & packages'.includes(search.toLowerCase())) ? (
					<WorkspaceFileStatus message="No matching files." />
				) : view === 'icons' ? (
					<WorkspaceIconGrid
						itemHref={repoBrowser?.href}
						thumbnailSize={thumbnailSize}
						pointerHover={pointerHover}
						includePackages={
							!repoBrowser &&
							!directory &&
							(filter === 'all' || filter === 'folders') &&
							'apps & packages'.includes(search.toLowerCase())
						}
						files={visible}
						orgSlug={orgSlug}
						renderIcon={(file) => (
							<FileGlyph mediaType={file.mediaType} name={file.name} />
						)}
					/>
				) : (
					<RecordTable
						surface="plain"
						toolbarContainer={tableToolbar}
						compactToolbar
						mode="none"
						dense
						ariaLabel="Workspace items"
						scrollHeight="100%"
						pointerHover={pointerHover}
						toolbar={
							<RecordTableSearch
								variant="plain"
								label="Search files"
								placeholder="Search files"
								value={tableState.globalFilter}
								onInput={(value) =>
									setTableState((current) => ({
										...current,
										globalFilter: value,
									}))
								}
							/>
						}
						columns={[
							{ key: 'name', label: 'Name', primary: true },
							{ key: 'type', label: 'Type' },
							{ key: 'location', label: 'Location' },
							{ key: 'size', label: 'Size', align: 'end', sortType: 'number' },
							{ key: 'updated', label: 'Modified', sortType: 'number' },
							{ key: 'created', label: 'Created', sortType: 'number' },
							{ key: 'author', label: 'Last edited by' },
							{ key: 'mediaType', label: 'Media type' },
							{
								key: 'versions',
								label: 'Versions',
								align: 'end',
								sortType: 'number',
							},
						]}
						rows={[
							...(!repoBrowser &&
							!directory &&
							'apps & packages'.includes(search.toLowerCase())
								? [
										{
											id: 'system:packages',
											href: packagesDirectoryHref(orgSlug),
											attributes: { 'data-system-directory': 'packages' },
											values: {
												name: 'Apps & Packages',
												type: 'System folder',
												location: 'Workspace',
											},
											cells: {
												name: (
													<span
														css={{
															display: 'flex',
															alignItems: 'center',
															gap: 8,
														}}
													>
														<FileGlyph
															mediaType={workspaceDirectoryMediaType}
														/>
														Apps &amp; Packages
													</span>
												),
												type: 'System folder',
												location: 'Workspace',
											},
										} satisfies RecordTableRow,
									]
								: []),
							...visible.map((file): RecordTableRow => {
								const revision = file.revisions.find(
									(revision) => revision.id === file.revisionId,
								)
								const bytes =
									file.mediaType === workspaceDirectoryMediaType
										? undefined
										: revision?.bytes
								const location = file.parentId
									? (byId.get(file.parentId)?.name ?? 'Workspace')
									: 'Workspace'
								return {
									id: file.id,
									href: href(file.id),
									attributes: { 'data-workspace-item': file.id },
									values: {
										name: file.name,
										type: typeName(file),
										location,
										size: bytes ?? 0,
										updated: Date.parse(file.updatedAt),
										created: Date.parse(file.createdAt),
										author: revision?.author ?? '',
										mediaType: file.mediaType,
										versions: file.revisionCount ?? file.revisions.length,
									},
									cells: {
										name: (
											<span
												css={{
													display: 'flex',
													alignItems: 'center',
													gap: 8,
													minWidth: 0,
												}}
											>
												<FileGlyph
													mediaType={file.mediaType}
													name={file.name}
												/>
												<span
													css={{
														overflow: 'hidden',
														textOverflow: 'ellipsis',
														whiteSpace: 'nowrap',
													}}
												>
													{file.name}
												</span>
											</span>
										),
										type: typeName(file),
										location,
										size:
											bytes === undefined
												? ''
												: bytes < 1024
													? `${bytes} B`
													: bytes < 1048576
														? `${(bytes / 1024).toFixed(1)} KB`
														: `${(bytes / 1048576).toFixed(1)} MB`,
										updated: (
											<time dateTime={file.updatedAt} title={file.updatedAt}>
												{fileDate.format(new Date(file.updatedAt))}
											</time>
										),
										created: (
											<time dateTime={file.createdAt} title={file.createdAt}>
												{fileDate.format(new Date(file.createdAt))}
											</time>
										),
										author: revision?.author ?? '',
										mediaType: file.mediaType,
										versions: file.revisionCount ?? file.revisions.length,
									},
								}
							}),
						]}
						dataControls={{
							scrollMode: 'virtual',
							state: tableState,
							onStateChange: (patch) =>
								setTableState((current) => ({ ...current, ...patch })),
							visibilityKey: 'workspace-files',
							defaultHidden: ['created', 'author', 'mediaType', 'versions'],
						}}
						emptyContent={
							search || tableState.globalFilter ? (
								<WorkspaceFileStatus message="No matching files." />
							) : (
								<WorkspaceEmptyFolder />
							)
						}
					/>
				)}
			</div>
		</div>
	)
}

function WorkspaceDocumentPanel({
	data,
	metadata,
}: {
	data: PageData
	metadata: FileMetadata
}) {
	const query = useQuery({
		queryKey: [
			'workspace-document',
			data.orgSlug,
			metadata.id,
			metadata.revisionId,
		],
		queryFn: () =>
			readFilePreview({ data: { orgSlug: data.orgSlug, fileId: metadata.id } }),
		retry: false,
	})
	if (query.isPending) return <LoadingIndicator label="Loading file" />
	if (query.isError || !query.data)
		return (
			<WorkspaceFileStatus
				message="Could not load file."
				action={{ label: 'Try again', run: () => void query.refetch() }}
			/>
		)
	return (
		<FilesPage
			key={metadata.id}
			embedded
			data={{ ...data, selected: query.data }}
			collapsed={new Set()}
			onToggleBranch={() => {}}
		/>
	)
}

function FileEmbed({
	orgSlug,
	metadata,
	initial,
	href,
	chrome = true,
}: {
	orgSlug: string
	metadata: FileMetadata
	initial?: PageData['embeds'][number]
	href: string
	chrome?: boolean
}) {
	const element = useRef<HTMLElement>(null)
	const [active, setActive] = useState(false)
	useEffect(() => {
		if (!element.current) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setActive(true)
					observer.disconnect()
				}
			},
			{ rootMargin: '240px' },
		)
		observer.observe(element.current)
		return () => observer.disconnect()
	}, [])

	const {
		data: file,
		isError,
		isPending,
		refetch,
	} = useQuery({
		enabled: active,
		queryKey: ['workspace-embed', orgSlug, metadata.id, metadata.revisionId],
		queryFn: async () =>
			(await readFilePreview({ data: { orgSlug, fileId: metadata.id } })).file,
		initialData: initial,
		staleTime: 0,
		retry: false,
	})
	const visible = isError ? undefined : file
	return (
		<figure
			ref={element}
			data-workspace-item={metadata.id}
			css={{
				margin: chrome ? '2px 0 8px' : 0,
				border: chrome ? `1px solid ${colors.border}` : 0,
				borderRadius: 7,
				overflow: chrome ? 'hidden' : 'auto',
				display: chrome ? undefined : 'flex',
				flexDirection: 'column',
				flex: chrome ? undefined : 1,
				minHeight: 0,
			}}
		>
			{chrome && (
				<figcaption
					css={{
						padding: '6px 10px',
						background: colors.background,
						borderBottom: `1px solid ${colors.borderSubtle}`,
					}}
				>
					<SiteLink
						href={href}
						css={{
							display: 'inline-flex',
							alignItems: 'center',
							gap: 6,
							maxWidth: '100%',
							'& > svg': { flexShrink: 0 },
							fontWeight: 600,
							color: colors.text,
							textDecoration: 'none',
						}}
					>
						<FileGlyph mediaType={metadata.mediaType} name={metadata.name} />
						<span
							title={metadata.name}
							css={{
								minWidth: 0,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{metadata.name}
						</span>
						<WorkspaceIcon name="open" />
					</SiteLink>
				</figcaption>
			)}
			{!visible && !isError && isPending && (
				<LoadingIndicator label="Loading preview" />
			)}
			{isError && (
				<WorkspaceFileStatus
					message="Could not load preview."
					action={{ label: 'Try again', run: () => void refetch() }}
				/>
			)}
			{visible &&
			(visible.encoding === 'base64' ||
				fileViewerKind(visible.name, visible.mediaType) === 'json' ||
				visible.mediaType === 'image/svg+xml') ? (
				<FileViewer
					orgSlug={orgSlug}
					fileId={visible.id}
					revisionId={visible.revisionId}
					name={visible.name}
					mediaType={visible.mediaType}
					content={visible.encoding === 'base64' ? undefined : visible.content}
					inline={chrome}
				/>
			) : visible && visible.encoding !== 'base64' ? (
				<FilePreview
					orgSlug={orgSlug}
					content={visible.content}
					mediaType={visible.mediaType}
					inline={chrome}
					fill={!chrome}
				/>
			) : null}
		</figure>
	)
}

function treeRows(
	files: PageData['files'],
	search: string,
	collapsed: ReadonlySet<string>,
) {
	const ids = new Set(files.map((file) => file.id))
	const children = new Map<string | undefined, PageData['files']>()
	for (const file of files) {
		const parent =
			file.parentId && ids.has(file.parentId) ? file.parentId : undefined
		const siblings = children.get(parent) ?? []
		siblings.push(file)
		children.set(parent, siblings)
	}
	const rows: Array<{
		file: PageData['files'][number]
		depth: number
		hasChildren: boolean
	}> = []
	function visit(parent: string | undefined, depth: number) {
		const siblings = children.get(parent) ?? []
		for (const file of [...siblings].sort(
			(a, b) =>
				Number(isWorkspaceContainer(b.mediaType)) -
					Number(isWorkspaceContainer(a.mediaType)) ||
				a.name.localeCompare(b.name),
		)) {
			if (file.name.toLowerCase().includes(search.toLowerCase()))
				rows.push({ file, depth, hasChildren: children.has(file.id) })
			if (search || !collapsed.has(file.id)) visit(file.id, depth + 1)
		}
	}
	visit(undefined, 0)
	return rows
}

function FilePreview({
	orgSlug,
	content,
	mediaType,
	inline = false,
	fill = false,
}: {
	content: string
	mediaType: FileMetadata['mediaType']
	orgSlug: string
	inline?: boolean
	fill?: boolean
}) {
	if (mediaType === workspacePageMediaType)
		return (
			<Suspense fallback={<LoadingIndicator label="Loading page" />}>
				<WorkspacePageEditor
					content={content}
					files={[]}
					renderFile={(id) => (
						<SiteLink href={`/@${orgSlug}/-/files?file=${id}`}>
							Open file ↗
						</SiteLink>
					)}
				/>
			</Suspense>
		)
	if (mediaType === 'text/csv') return <CsvPreview content={content} />
	if (
		(mediaType === 'text/markdown' || mediaType === 'text/plain') &&
		!content.trim()
	)
		return <WorkspaceFileStatus message="This file is empty." />
	if (mediaType === 'text/html')
		return (
			<HtmlPreview
				content={content}
				orgSlug={orgSlug}
				inline={inline}
				fill={fill}
			/>
		)
	return (
		<article
			css={{
				minHeight: inline ? undefined : '38vh',
				padding:
					mediaType === 'text/markdown'
						? '20px clamp(16px, 4vw, 32px)'
						: inline
							? '10px 14px'
							: '16px 20px',
				maxWidth: workspaceProse.width,
				marginInline: 'auto',
				width: '100%',
				boxSizing: 'border-box',
				fontSize: typography.fontSize.sm,
				lineHeight: 1.65,
				'& h1, & h2, & h3': { lineHeight: 1.25, letterSpacing: '-0.02em' },
				overflowWrap: 'anywhere',
				'& pre': { whiteSpace: 'pre-wrap' },
				...(mediaType === 'text/markdown' ? workspaceMarkdownCss : {}),
			}}
		>
			{mediaType === 'text/markdown' ? (
				<Suspense fallback={<LoadingIndicator label="Loading preview…" />}>
					<MarkdownPreview content={content} />
				</Suspense>
			) : (
				<pre
					css={{
						margin: 0,
						whiteSpace: 'pre-wrap',
						fontFamily: typography.fontFamilyMono,
					}}
				>
					{content}
				</pre>
			)}
		</article>
	)
}
