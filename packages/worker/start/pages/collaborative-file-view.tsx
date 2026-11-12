/** @jsxImportSource @emotion/react */
import {
	lazy,
	Suspense,
	useEffect,
	useLayoutEffect,
	type RefObject,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import { FileAnchorContext } from './file-anchor-context.ts'
import * as Y from 'yjs'
import { ContextMenuSurface } from '../components/context-menu-surface.tsx'
import { createPortal } from 'react-dom'
import { useHotkey } from '@tanstack/react-hotkeys'
import { FileComments, CommentIcon } from './file-comments.tsx'
import { DbProvider, useLiveQuery } from '@tanstack/react-db'
import { CollaborativeTextEditor } from './collaborative-text-editor.tsx'
import { FileRoomClient } from './file-room-client.ts'
import { actorColor } from '#universal/collaboration-color.ts'
import { WorkspacePageEditor } from './workspace-page-editor.tsx'
import { collaborativeContent } from '#universal/collaborative-document.ts'
import { workspacePageMediaType } from '#universal/workspace-page.ts'
import {
	participantOpacity,
	type CommentAnchor,
	type FileThread,
	type CommentCommand,
} from '#universal/file-collaboration.ts'
import type { FileMetadata } from '#universal/files.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { fileAssetUrl } from '#universal/file-assets.ts'
import { fileViewerKind } from '#universal/file-viewers.ts'
import { VideoCommentPlayer } from './file-viewers/video-comment-player.tsx'
import { workspaceProse } from './workspace-prose.ts'

const FileStorageSettings = lazy(() => import('./file-storage-settings.tsx'))
const commentsSlideMs = 220

const control = {
	border: 0,
	borderRadius: 5,
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	font: 'inherit',
	lineHeight: 1.5,
	boxShadow: 'none',
	'&:hover': { background: colors.surface, color: colors.text },
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: 2,
	},
	'&:disabled': { opacity: 0.4, cursor: 'default' },
	padding: '4px 7px',
	minHeight: 28,
	fontSize: typography.fontSize.xs,
	display: 'inline-flex',
	alignItems: 'center',
	gap: 6,
}
const time = (value: number) => {
	const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000))
	return minutes < 1
		? 'Just now'
		: minutes < 60
			? `${minutes} min ago`
			: minutes < 1440
				? `${Math.floor(minutes / 60)} hr ago`
				: `${Math.floor(minutes / 1440)} days ago`
}
export default function CollaborativeFileView(props: {
	orgSlug: string
	fileId: string
	name: string
	personId: string
	mediaType: string
	revisionId: string
	onVersionChange?: () => void
	canManageStorage?: boolean
	content: string
	files: FileMetadata[]
	renderFile: (id: string) => ReactNode
	loadLinkTitle?: (url: string) => Promise<string | null>
	toolbarRef: RefObject<HTMLElement | null>
	title?: ReactNode
	children?: ReactNode
	pageChildren?: ReactNode
	renderPreview?: (content: string) => ReactNode
}) {
	const [client, setClient] = useState<FileRoomClient | null>(null)
	useEffect(() => {
		const room = new FileRoomClient(props.orgSlug, props.fileId, props.personId)
		setClient(room)
		void room.start()
		return () => room.dispose()
	}, [props.orgSlug, props.fileId, props.personId])
	if (!client) return <LoadingIndicator label="Connecting to file" />
	return (
		<DbProvider client={client.db}>
			<CollaborationView {...props} client={client} />
		</DbProvider>
	)
}
function CollaborationView({
	client,
	...props
}: Parameters<typeof CollaborativeFileView>[0] & { client: FileRoomClient }) {
	const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null)
	useLayoutEffect(() => {
		setToolbarHost(props.toolbarRef.current)
	}, [props.toolbarRef])
	const state = useSyncExternalStore(
		client.subscribe,
		client.getSnapshot,
		client.getSnapshot,
	)
	const refreshedVersion = useRef(props.revisionId)
	useEffect(() => {
		const revision = state.snapshot?.revisionId
		if (
			revision &&
			revision !== props.revisionId &&
			revision !== refreshedVersion.current &&
			props.onVersionChange
		) {
			refreshedVersion.current = revision
			props.onVersionChange()
		}
	}, [state.snapshot?.revisionId, props.revisionId, props.onVersionChange])
	const { data: threads = [] } = useLiveQuery({
		query: (q) => q.from({ thread: client.threads.options }),
	})
	const { data: comments = [] } = useLiveQuery({
		query: (q) => q.from({ comment: client.comments.options }),
	})
	const { data: participants = [] } = useLiveQuery({
		query: (q) => q.from({ participant: client.participants.options }),
	})
	const { data: recent = [] } = useLiveQuery({
		query: (q) => q.from({ recent: client.recent.options }),
	})
	const [content, setContent] = useState(props.content),
		[open, setOpen] = useState(false),
		[closingComments, setClosingComments] = useState(false),
		[storageOpen, setStorageOpen] = useState(false),
		[people, setPeople] = useState(false),
		[active, setActive] = useState<string | null>(null),
		[anchor, setAnchor] = useState<CommentAnchor>({ kind: 'file' }),
		[composing, setComposing] = useState(false),
		[error, setError] = useState('')
	const video = useRef<HTMLMediaElement>(null)
	const documentRoot = useRef<HTMLDivElement>(null)
	const returnFocus = useRef<HTMLElement | null>(null)
	useEffect(() => {
		if (!closingComments) return
		const timeout = window.setTimeout(
			() => setClosingComments(false),
			commentsSlideMs,
		)
		return () => window.clearTimeout(timeout)
	}, [closingComments, open])
	function closeComments() {
		setClosingComments(
			!window.matchMedia('(prefers-reduced-motion: reduce)').matches,
		)
		setOpen(false)
		setComposing(false)
		setActive(null)
		requestAnimationFrame(() => {
			const target = returnFocus.current?.isConnected
				? returnFocus.current
				: documentRoot.current?.querySelector<HTMLElement>(
						'[aria-label="Page content"], [aria-label="Document text"]',
					)
			target?.focus({ preventScroll: true })
		})
	}
	useHotkey(
		'Escape',
		(event) => {
			if (
				event.target instanceof Element &&
				event.target.closest(
					'[role=menu], [role=listbox], [role=combobox][aria-expanded=true], [popover]:popover-open',
				)
			)
				return
			event.preventDefault()
			event.stopPropagation()
			closeComments()
		},
		{
			target: documentRoot,
			enabled: open,
			ignoreInputs: false,
			ignoreDefaultPrevented: true,
			preventDefault: false,
			meta: { name: 'Close comments and return to document' },
		},
	)
	useHotkey(
		'Escape',
		(event) => {
			if (
				event.target instanceof Element &&
				event.target.closest(
					'[role=menu], [role=listbox], [role=combobox][aria-expanded=true], [popover]:popover-open',
				)
			)
				return
			event.preventDefault()
			event.stopPropagation()
			closeComments()
		},
		{
			target: toolbarHost,
			enabled: open,
			ignoreInputs: false,
			ignoreDefaultPrevented: true,
			preventDefault: false,
		},
	)
	useEffect(() => {
		const update = () => {
			try {
				setContent(collaborativeContent(client.doc, props.mediaType))
			} catch {}
		}
		client.doc.on('update', update)
		update()
		return () => {
			client.doc.off('update', update)
		}
	}, [client, props.mediaType])
	const [tick, setTick] = useState(0)
	useEffect(() => {
		const timer = setInterval(() => setTick((n) => n + 1), 5_000)
		return () => clearInterval(timer)
	}, [])
	void tick
	const access = state.snapshot?.access
	const live = new Map(
		[...participants]
			.filter((person) => person.sessionId !== client.sessionId)
			.sort(
				(a, b) =>
					Number(!!a.selection || !!a.blockId) -
						Number(!!b.selection || !!b.blockId) || a.lastSeen - b.lastSeen,
			)
			.map((p) => [p.actor.id, p]),
	)
	function participantCanJump(id: string) {
		const person = live.get(id)
		return (
			(props.mediaType === workspacePageMediaType ||
				(!props.renderPreview && !props.children)) &&
			!!(person?.selection || person?.blockId)
		)
	}
	function jumpToParticipant(id: string) {
		const person = live.get(id)
		const root = documentRoot.current
		if (!person || !root) return false
		const caret = root.querySelector<HTMLElement>(
			`[data-presence-session="${CSS.escape(person.sessionId)}"]`,
		)
		const block =
			person.blockId &&
			root.querySelector<HTMLElement>(
				`[data-page-block-id="${CSS.escape(person.blockId)}"]`,
			)
		const target = caret ?? block
		if (!target) return false
		const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches
			? 'instant'
			: 'smooth'
		const textInput = caret
			?.closest('pre')
			?.parentElement?.querySelector('textarea')
		if (textInput) {
			const bounds = textInput.getBoundingClientRect()
			textInput.scrollTo({
				top:
					textInput.scrollTop +
					target.getBoundingClientRect().top -
					bounds.top -
					bounds.height / 2,
				behavior,
			})
			textInput.scrollIntoView({ block: 'nearest', behavior })
		} else {
			target.scrollIntoView({ block: 'center', inline: 'nearest', behavior })
		}
		return true
	}
	const isActive = (id: string) =>
		live.has(id) ||
		recent.some(
			(person) => person.id === id && (person.activeUntil ?? 0) > Date.now(),
		)
	const actors = [
		...new Map(
			[
				...recent,
				...participants.map((p) => ({
					id: p.actor.id,
					actor: p.actor,
					lastSeen: p.lastSeen,
					lastAction:
						p.state === 'editing' ? ('edited' as const) : ('viewed' as const),
				})),
			].map((p) => [p.id, p]),
		).values(),
	]
		.filter((p) => p.id !== state.snapshot?.actor.id)
		.sort(
			(a, b) =>
				Number(isActive(b.id)) - Number(isActive(a.id)) ||
				b.lastSeen - a.lastSeen,
		)
	async function command(value: CommentCommand) {
		try {
			setError('')
			await client.comment(value)
			return true
		} catch (e) {
			setError(
				e instanceof Error ? e.message : 'Could not update the discussion.',
			)
			return false
		}
	}
	const unreadActive =
		state.snapshot?.notifications
			.filter(
				(notification) =>
					active && notification.threadId === active && !notification.read,
			)
			.map((notification) => notification.id)
			.sort()
			.join(',') ?? ''
	const lastRead = useRef('')
	useEffect(() => {
		if (!open || !active || !unreadActive) return
		const read = () => {
			if (!document.hasFocus() || document.visibilityState !== 'visible') return
			const key = `${active}:${unreadActive}`
			if (lastRead.current === key) return
			lastRead.current = key
			void client
				.comment({
					kind: 'read',
					operationId: crypto.randomUUID(),
					threadId: active,
					sequence: client.getSnapshot().snapshot?.sequence ?? 0,
				})
				.catch(() => {
					lastRead.current = ''
				})
		}
		read()
		window.addEventListener('focus', read)
		document.addEventListener('visibilitychange', read)
		return () => {
			window.removeEventListener('focus', read)
			document.removeEventListener('visibilitychange', read)
		}
	}, [client, open, active, unreadActive])
	const viewerKind = fileViewerKind(props.name, props.mediaType)
	const isVideo = viewerKind === 'video'
	const isAudio = viewerKind === 'audio'
	const isImage = viewerKind === 'image'
	const videoThreads = threads.filter(
		(thread) =>
			thread.anchor.kind === viewerKind &&
			thread.revisionId === props.revisionId &&
			!thread.outdated,
	)
	const revisionId = state.snapshot?.revisionId ?? props.revisionId
	const commentThreads = threads.map((thread) => {
		const location = thread.anchor
		const anchorRevision =
			location.kind === 'video'
				? thread.revisionId
				: location.kind === 'audio' ||
					  location.kind === 'image' ||
					  location.kind === 'json' ||
					  location.kind === 'csv'
					? location.revisionId
					: undefined
		return anchorRevision && anchorRevision !== revisionId
			? { ...thread, outdated: true }
			: thread
	})
	function contextCommentAnchor(target: Element): CommentAnchor {
		const fileAnchor = { kind: 'file' } as const
		const snapshot = client.getSnapshot().snapshot
		if (!snapshot || props.mediaType === workspacePageMediaType)
			return fileAnchor

		const jsonRow = target.closest<HTMLElement>('[data-json-path]')
		if (viewerKind === 'json' && jsonRow)
			return { kind: 'json', pointer: jsonRow.dataset.jsonPath!, revisionId }
		const cell = target.closest<HTMLElement>('[data-csv-row][data-csv-column]')
		if (cell)
			return {
				kind: 'csv',
				row: Number(cell.dataset.csvRow),
				column: Number(cell.dataset.csvColumn),
				revisionId,
			}
		const text = client.doc.getText('content')
		const source = text.toString()
		let from: number
		let to: number
		if (
			target instanceof HTMLTextAreaElement &&
			target.getAttribute('aria-label') === 'Document text'
		) {
			from = target.selectionStart
			to = target.selectionEnd
		} else {
			const selection = window.getSelection()
			if (
				!selection ||
				selection.isCollapsed ||
				!selection.anchorNode ||
				!selection.focusNode ||
				!documentRoot.current?.contains(selection.anchorNode) ||
				!documentRoot.current.contains(selection.focusNode)
			)
				return fileAnchor
			const quote = selection.toString()
			from = source.indexOf(quote)
			if (!quote || from < 0 || source.indexOf(quote, from + 1) >= 0)
				return fileAnchor
			to = from + quote.length
		}
		const quote = source.slice(from, to).slice(0, 2000)
		if (!quote) return fileAnchor
		return {
			kind: 'text',
			start: JSON.stringify(Y.createRelativePositionFromTypeIndex(text, from)),
			end: JSON.stringify(Y.createRelativePositionFromTypeIndex(text, to)),
			quote,
			revisionId: snapshot.revisionId,
		}
	}

	function startComment(value: CommentAnchor) {
		returnFocus.current =
			(value.kind === 'video' && document.activeElement instanceof HTMLElement
				? document.activeElement
				: documentRoot.current?.querySelector<HTMLElement>(
						'[aria-label="Page content"], [aria-label="Document text"]',
					)) ?? null
		setComposing(true)
		setError('')
		setAnchor(value)
		setActive(null)
		setOpen(true)
	}
	function selectThread(thread: FileThread) {
		setComposing(false)
		void command({
			kind: 'read',
			operationId: crypto.randomUUID(),
			threadId: thread.id,
			sequence: state.snapshot?.sequence ?? 0,
		})
		setActive(thread.id)
		setAnchor(thread.anchor)
		setOpen(true)
		if (thread.anchor.kind === 'video' || thread.anchor.kind === 'audio') {
			const element = video.current
			const seconds = thread.anchor.timeMs / 1000
			if (
				element &&
				!thread.outdated &&
				thread.revisionId === props.revisionId &&
				seconds <= element.duration
			) {
				element.pause()
				element.currentTime = seconds
			}
		} else if (
			thread.anchor.kind === 'block' ||
			thread.anchor.kind === 'text'
		) {
			const id = thread.anchor.blockId
			if (id)
				documentRoot.current
					?.querySelector(`[data-page-block-id="${id}"]`)
					?.scrollIntoView({ block: 'center', behavior: 'smooth' })
		}
	}
	useLayoutEffect(() => {
		if (!open || !active) return
		const thread = commentThreads.find((item) => item.id === active)
		if (
			!thread ||
			thread.outdated ||
			(thread.anchor.kind !== 'image' && thread.anchor.kind !== 'csv')
		)
			return
		documentRoot.current
			?.querySelector(`[data-file-anchor-thread~="${CSS.escape(active)}"]`)
			?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [active, open])

	const toolbar = (
		<div
			data-file-presence=""
			data-portal-mounted={!!toolbarHost}
			css={{
				display: 'flex',
				alignItems: 'center',
				gap: 7,
				position: 'relative',
			}}
		>
			{actors.slice(0, 4).map((p) => {
				const canJump = participantCanJump(p.id)
				const label = `${p.actor.name}, ${isActive(p.id) ? (p.actor.kind === 'agent' ? 'working now' : 'here now') : time(p.lastSeen)}`
				return (
					<button
						key={p.id}
						aria-label={canJump ? `Jump to ${label}` : label}
						title={canJump ? `Jump to ${p.actor.name}` : label}
						css={{ ...control, padding: 0, position: 'relative' }}
						onClick={() => {
							if (canJump && jumpToParticipant(p.id)) setPeople(false)
							else setPeople(!people)
						}}
					>
						<span
							css={{
								width: 26,
								height: 26,
								borderRadius: '50%',
								display: 'grid',
								placeItems: 'center',
								background: colors.borderSubtle,
								border: `1px solid ${isActive(p.id) ? actorColor(p.id) : colors.border}`,
								opacity: isActive(p.id) ? 1 : participantOpacity(p.lastSeen),
							}}
						>
							{p.actor.kind === 'agent'
								? '◇'
								: p.actor.name.slice(0, 1).toUpperCase()}
						</span>
						{isActive(p.id) && (
							<span
								css={{
									position: 'absolute',
									bottom: 0,
									right: 0,
									width: 6,
									height: 6,
									borderRadius: '50%',
									background: colors.primary,
								}}
							/>
						)}
					</button>
				)
			})}
			{actors.length > 0 && (
				<button
					css={control}
					aria-label="People and agents"
					aria-expanded={people}
					title="People and agents"
					onClick={() => setPeople(!people)}
				>
					{actors.length > 4 ? `+${actors.length - 4}` : '⋯'}
				</button>
			)}
			<span
				role="status"
				css={{ fontSize: typography.fontSize.xs, color: colors.textMuted }}
			>
				{state.status === 'saved'
					? 'Saved'
					: state.status === 'offline'
						? state.locallySaved
							? 'Saved on this device'
							: 'Changes pending'
						: state.status === 'pending'
							? 'Saving…'
							: state.status === 'forbidden'
								? 'Access changed'
								: state.status === 'error'
									? 'Sync failed'
									: 'Connecting…'}
			</span>
			<button
				css={control}
				onClick={(event) => {
					if (open) closeComments()
					else {
						returnFocus.current = event.currentTarget
						setComposing(false)
						setActive(null)
						setOpen(true)
					}
				}}
				aria-expanded={open}
				aria-label="Comments"
			>
				<CommentIcon />
				{threads.filter((t) => !t.resolvedAt).length || null}
			</button>
			{people && (
				<div
					css={{
						position: 'absolute',
						top: '100%',
						right: 0,
						zIndex: 40,
						width: 260,
						padding: 12,
						border: `1px solid ${colors.border}`,
						borderRadius: 8,
						background: colors.surface,
						boxShadow: '0 5px 18px #0002',
					}}
				>
					<div
						css={{
							display: 'flex',
							justifyContent: 'space-between',
							alignItems: 'center',
							marginBottom: 8,
						}}
					>
						<strong>People & agents</strong>
						<button
							css={control}
							onClick={() => setPeople(false)}
							aria-label="Close participants"
						>
							×
						</button>
					</div>
					{actors.map((p) => (
						<div
							key={p.id}
							css={{
								display: 'flex',
								justifyContent: 'space-between',
								gap: 8,
								paddingBlock: 5,
							}}
						>
							<span>
								{p.actor.name}
								{p.actor.kind === 'agent' && (
									<small css={{ display: 'block', color: colors.textMuted }}>
										Agent · for{' '}
										{p.actor.personId === state.snapshot?.actor.personId
											? 'you'
											: p.actor.name.replace('’s agent', '')}
									</small>
								)}
							</span>
							<div css={{ display: 'flex', alignItems: 'center', gap: 8 }}>
								<small css={{ color: colors.textMuted }}>
									{isActive(p.id)
										? (live.get(p.id)?.state ?? 'working')
										: time(p.lastSeen)}
								</small>
								{participantCanJump(p.id) && (
									<button
										css={control}
										aria-label={`Jump to ${p.actor.name}`}
										onClick={() => jumpToParticipant(p.id)}
									>
										↗
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	)
	if (!state.ready && ['error', 'forbidden'].includes(state.status))
		return (
			<div role="alert">
				{state.message}
				<button css={control} onClick={() => client.retry()}>
					Reconnect
				</button>
			</div>
		)
	if (!state.ready)
		return (
			<LoadingIndicator
				label={
					state.status === 'offline'
						? 'Reconnecting to file'
						: 'Connecting to file'
				}
			/>
		)
	return (
		<>
			{toolbarHost ? createPortal(toolbar, toolbarHost) : null}
			{storageOpen && (
				<Suspense
					fallback={<LoadingIndicator label="Opening storage settings" />}
				>
					<FileStorageSettings
						orgSlug={props.orgSlug}
						onClose={() => {
							setStorageOpen(false)
							client.retry()
						}}
					/>
				</Suspense>
			)}
			{state.message && (
				<div role="alert" css={{ color: colors.danger, paddingBlock: 8 }}>
					{state.message}
					<button css={control} onClick={() => client.retry()}>
						Retry sync
					</button>
					{props.canManageStorage &&
						/storage|allowance|checkpoint/i.test(state.message) && (
							<button css={control} onClick={() => setStorageOpen(true)}>
								Storage settings
							</button>
						)}
					<button
						css={control}
						onClick={() => {
							const url = URL.createObjectURL(
								new Blob([content], { type: 'text/plain' }),
							)
							const link = document.createElement('a')
							link.href = url
							link.download = `${props.name}.draft`
							link.click()
							setTimeout(() => URL.revokeObjectURL(url), 1000)
						}}
					>
						Download draft
					</button>
				</div>
			)}
			<div
				css={{
					display: 'grid',
					gridTemplateColumns: open
						? 'minmax(0,1fr) minmax(0,300px)'
						: 'minmax(0,1fr) minmax(0,0px)',
					gridTemplateRows: isImage ? 'minmax(0, 1fr)' : undefined,
					columnGap: open ? 24 : 0,
					transition: `grid-template-columns ${commentsSlideMs}ms ease, column-gap ${commentsSlideMs}ms ease`,
					'@media(prefers-reduced-motion:reduce)': { transition: 'none' },
					alignItems: 'stretch',
					minHeight: 0,
					height: '100%',
					'@media(max-width:760px)': { gridTemplateColumns: 'minmax(0,1fr)' },
				}}
			>
				<FileAnchorContext
					value={{
						threads: commentThreads,
						activeId: open ? active : null,
						revisionId,
						onSelect: selectThread,
						onComment: access?.comment ? startComment : undefined,
					}}
				>
					<ContextMenuSurface
						allowTextEditing
						resolve={(target) => {
							if (!access?.comment) return
							const anchor = contextCommentAnchor(target)
							return [
								{
									id: 'comment-file',
									label: 'Comment',
									run: () => startComment(anchor),
								},
							]
						}}
					>
						<div
							ref={documentRoot}
							css={{
								minWidth: 0,
								width: '100%',
								maxWidth:
									props.mediaType === workspacePageMediaType
										? workspaceProse.width
										: undefined,
								marginInline: 'auto',
								position: 'relative',
								...(isImage && {
									minHeight: 0,
									display: 'flex',
									flexDirection: 'column',
								}),
							}}
						>
							{props.title && (
								<div css={{ marginBottom: 24 }}>{props.title}</div>
							)}
							{isVideo || isAudio ? (
								<VideoCommentPlayer
									key={props.revisionId}
									video={video}
									audio={isAudio}
									src={fileAssetUrl(
										props.orgSlug,
										props.fileId,
										props.revisionId,
									)}
									download={fileAssetUrl(
										props.orgSlug,
										props.fileId,
										props.revisionId,
										true,
									)}
									name={props.name}
									threads={videoThreads}
									activeId={open ? active : null}
									onSelect={selectThread}
									onComment={
										access?.comment
											? (timeMs) =>
													startComment(
														isAudio
															? { kind: 'audio', timeMs, revisionId }
															: { kind: 'video', timeMs },
													)
											: undefined
									}
								/>
							) : props.mediaType === workspacePageMediaType ? (
								<WorkspacePageEditor
									content={content}
									collaboration={client}
									threads={threads}
									activeThreadId={open ? active : null}
									draftAnchor={composing ? anchor : undefined}
									onSelectThread={selectThread}
									onChange={
										access?.write &&
										!['forbidden', 'error'].includes(state.status)
											? setContent
											: undefined
									}
									files={props.files}
									renderFile={props.renderFile}
									loadLinkTitle={props.loadLinkTitle}
									onComment={access?.comment ? startComment : undefined}
								/>
							) : (
								(props.renderPreview?.(content) ??
								props.children ?? (
									<CollaborativeTextEditor
										client={client}
										content={content}
										participants={participants}
										activeAnchor={open ? anchor : undefined}
										threads={threads}
										activeThreadId={open ? active : null}
										onSelectThread={selectThread}
										onComment={access?.comment ? startComment : undefined}
										readOnly={
											!access?.write ||
											['forbidden', 'error'].includes(state.status)
										}
									/>
								))
							)}
							{props.mediaType === workspacePageMediaType && props.pageChildren}
							{access?.comment && !isVideo && (
								<button
									css={{
										...control,
										marginTop: 12,
										alignSelf: 'start',
										flexShrink: 0,
									}}
									onClick={() => startComment({ kind: 'file' })}
								>
									<CommentIcon /> Comment
								</button>
							)}
						</div>
					</ContextMenuSurface>
				</FileAnchorContext>
				{(open || closingComments) && state.snapshot && (
					<div
						inert={!open}
						css={{
							minWidth: 0,
							overflowX: 'clip',
							'& > aside': {
								minWidth: 300,
								height: '100%',
								transition: `transform ${commentsSlideMs}ms ease`,
								transform: open ? 'translateX(0)' : 'translateX(100%)',
								'@starting-style': { transform: 'translateX(100%)' },
								'@media(prefers-reduced-motion:reduce)': { transition: 'none' },
								'@media(max-width:760px)': {
									minWidth: 0,
									height: 'auto',
									transform: open ? 'translateY(0)' : 'translateY(100%)',
									'@starting-style': { transform: 'translateY(100%)' },
								},
							},
							'@media(max-width:760px)': { display: 'contents' },
						}}
					>
						<FileComments
							threads={commentThreads}
							comments={comments}
							actor={state.snapshot!.actor}
							actors={[
								state.snapshot!.actor,
								...actors.map((person) => person.actor),
								...comments.map((comment) => comment.author),
							]}
							canComment={!!access?.comment}
							manage={!!access?.manage}
							notifications={state.snapshot?.notifications ?? []}
							activeId={active}
							composing={composing}
							anchor={anchor}
							draftScope={`kody.comment-draft:${props.personId}:${props.orgSlug}:${props.fileId}`}
							onSelect={selectThread}
							onCreated={(id, value) => {
								setActive(id)
								setAnchor(value)
								setComposing(false)
							}}
							onBack={() => {
								setActive(null)
								setComposing(false)
								setAnchor({ kind: 'file' })
								setError('')
							}}
							onClose={closeComments}
							onNew={() => startComment({ kind: 'file' })}
							run={command}
							commandError={error}
							documentRoot={documentRoot}
							moreThreads={!!state.snapshot?.nextCursor}
							moreComments={
								!!(active && state.snapshot?.commentCursors[active])
							}
							loadThreads={() => client.loadMoreThreads()}
							loadComments={() =>
								active ? client.loadMoreComments(active) : Promise.resolve()
							}
							status={state.status}
						/>
					</div>
				)}
			</div>
		</>
	)
}
