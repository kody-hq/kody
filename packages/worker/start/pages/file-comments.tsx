/** @jsxImportSource @emotion/react */
import { commentAnchorLabel } from '#universal/comment-anchor-label.ts'
import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type RefObject,
} from 'react'
import {
	useHotkey,
	useHotkeys,
	formatForDisplay,
} from '@tanstack/react-hotkeys'
import { colors } from '#universal/styles/tokens.ts'
import { Combobox } from '../components/combobox.tsx'
import {
	type CollaborationActor,
	videoTime,
	type CommentAnchor,
	type CommentCommand,
	type FileComment,
	type FileNotification,
	type FileThread,
} from '#universal/file-collaboration.ts'
import { UserAvatar } from '../components/user-avatar.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import {
	ContextMenuSurface,
	ContextMenuButton,
	type ContextAction,
} from '../components/context-menu-surface.tsx'

const commentButtonCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: 6,
	minHeight: 28,
	padding: '4px 7px',
	border: 0,
	borderRadius: 5,
	background: 'transparent',
	color: colors.textMuted,
	font: 'inherit',
	fontSize: 12,
	cursor: 'pointer',
	boxShadow: 'none',
	'&:hover': { background: colors.borderSubtle, color: colors.text },
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: 2,
	},
	'&:disabled': { opacity: 0.4, cursor: 'default' },
	'@media(pointer:coarse)': { minHeight: 36, minWidth: 36 },
} as const
export function CommentIcon({
	kind = 'comment',
}: {
	kind?:
		| 'comment'
		| 'check'
		| 'close'
		| 'back'
		| 'more'
		| 'send'
		| 'up'
		| 'down'
}) {
	const paths = {
		comment: 'M21 15a3 3 0 0 1-3 3H7l-5 4V5a3 3 0 0 1 3-3h13a3 3 0 0 1 3 3Z',
		check: 'm5 12 4 4L19 6',
		close: 'm6 6 12 12M6 18 18 6',
		back: 'm14 5-7 7 7 7',
		more: 'M5 12h.01M12 12h.01M19 12h.01',
		send: 'm5 12 7-7 7 7M12 5v14',
		up: 'm6 15 6-6 6 6',
		down: 'm6 9 6 6 6-6',
	}
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={kind === 'more' ? 3 : 1.7}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[kind]} />
		</svg>
	)
}
function commentTime(value: string) {
	const minutes = Math.max(
		0,
		Math.floor((Date.now() - Date.parse(value)) / 60000),
	)
	return minutes < 1
		? 'Now'
		: minutes < 60
			? `${minutes}m`
			: minutes < 1440
				? `${Math.floor(minutes / 60)}h`
				: minutes < 10080
					? `${Math.floor(minutes / 1440)}d`
					: new Date(value).toLocaleDateString(undefined, {
							month: 'short',
							day: 'numeric',
						})
}
function Avatar({ actor }: { actor: CollaborationActor }) {
	return (
		<span
			title={actor.kind === 'agent' ? `${actor.name} · Agent` : actor.name}
			css={{ flexShrink: 0 }}
		>
			<UserAvatar displayName={actor.name} avatarUrl={null} size={26} />
		</span>
	)
}
function CommentBody({ body }: { body: string }) {
	return (
		<div
			css={{
				whiteSpace: 'pre-wrap',
				overflowWrap: 'anywhere',
				lineHeight: 1.55,
				fontSize: 13,
			}}
		>
			{body.split(/(@[a-zA-Z0-9_-]+|https?:\/\/[^\s]+)/g).map((part, index) =>
				part.startsWith('@') ? (
					<span
						key={index}
						css={{
							color: colors.primaryText,
							background: colors.primarySoft,
							borderRadius: 3,
							paddingInline: 2,
						}}
					>
						{part}
					</span>
				) : /^https?:\/\//.test(part) ? (
					<a
						key={index}
						href={part}
						target="_blank"
						rel="noopener noreferrer"
						css={{ color: colors.primaryText, textDecoration: 'underline' }}
					>
						{part}
					</a>
				) : (
					part
				),
			)}
		</div>
	)
}

function CommentComposer({
	actor,
	actors,
	draftKey,
	label,
	submitLabel,
	onSubmit,
	onCancel,
	initial = '',
	focus = false,
}: {
	actor: CollaborationActor
	actors: CollaborationActor[]
	draftKey: string
	label: string
	submitLabel: string
	onSubmit: (body: string) => Promise<boolean>
	onCancel?: () => void
	initial?: string
	focus?: boolean
}) {
	const input = useRef<HTMLTextAreaElement>(null)
	const mentionId = useId()
	const [value, setValue] = useState(() => {
		try {
			return localStorage.getItem(draftKey) ?? initial
		} catch {
			return initial
		}
	})
	const [sending, setSending] = useState(false)
	const lock = useRef(false)
	const pendingCaret = useRef<number | null>(null)
	const [mention, setMention] = useState<{
		start: number
		end: number
		query: string
	} | null>(null)
	const [choice, setChoice] = useState(0)
	const candidates = [
		...new Map(
			actors.map((person) => [
				person.personId,
				person.name.replace(/’s agent$/, ''),
			]),
		).values(),
	]
		.filter(
			(name) =>
				/^[a-zA-Z0-9_-]+$/.test(name) &&
				name.toLowerCase().includes(mention?.query.toLowerCase() ?? ''),
		)
		.slice(0, 6)
	function updateMention(next: string, caret: number) {
		const match = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(next.slice(0, caret))
		setMention(
			match
				? { start: caret - match[1]!.length - 1, end: caret, query: match[1]! }
				: null,
		)
		setChoice(0)
	}
	function change(next: string, caret = next.length) {
		setValue(next)
		try {
			localStorage.setItem(draftKey, next)
		} catch {}
		updateMention(next, caret)
	}
	function selectMention(index: number) {
		if (!mention || !candidates[index]) return
		const insertion = `@${candidates[index]} `
		const end = mention.start + insertion.length
		pendingCaret.current = end
		change(
			value.slice(0, mention.start) + insertion + value.slice(mention.end),
			end,
		)
		setMention(null)
		input.current?.focus()
	}
	async function submit() {
		if (!value.trim() || lock.current) return
		lock.current = true
		setSending(true)
		try {
			if (await onSubmit(value.trim())) {
				setValue('')
				try {
					localStorage.removeItem(draftKey)
				} catch {}
			}
		} finally {
			lock.current = false
			setSending(false)
		}
	}
	useLayoutEffect(() => {
		const element = input.current
		if (element) {
			element.style.height = '0'
			element.style.height = `${Math.min(220, Math.max(32, element.scrollHeight))}px`
			if (pendingCaret.current !== null) {
				element.setSelectionRange(pendingCaret.current, pendingCaret.current)
				pendingCaret.current = null
			}
		}
	}, [value])
	useEffect(() => {
		if (focus) input.current?.focus({ preventScroll: true })
	}, [focus])
	useHotkey('Mod+Enter', () => void submit(), {
		target: input,
		ignoreInputs: false,
		enabled: !sending && !!value.trim(),
		meta: { name: 'Send comment' },
	})
	useHotkeys(
		[
			{
				hotkey: 'ArrowDown',
				callback: (event) => {
					event.stopPropagation()
					setChoice((choice + 1) % candidates.length)
				},
			},
			{
				hotkey: 'ArrowUp',
				callback: (event) => {
					event.stopPropagation()
					setChoice((choice + candidates.length - 1) % candidates.length)
				},
			},
			{
				hotkey: 'Enter',
				callback: (event) => {
					event.stopPropagation()
					selectMention(choice)
				},
			},
			{
				hotkey: 'Escape',
				callback: (event) => {
					event.stopPropagation()
					setMention(null)
				},
			},
		],
		{
			target: input,
			ignoreInputs: false,
			enabled: !!mention && candidates.length > 0,
		},
	)
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault()
				void submit()
			}}
			css={{
				position: 'relative',
				padding: 10,
				border: `1px solid ${colors.border}`,
				borderRadius: 8,
				background: colors.surface,
				'&:focus-within': {
					borderColor: colors.textMuted,
					boxShadow: `0 0 0 1px ${colors.borderSubtle}`,
				},
			}}
		>
			<div css={{ display: 'flex', gap: 9, alignItems: 'start' }}>
				<Avatar actor={actor} />
				<textarea
					ref={input}
					role="combobox"
					aria-autocomplete="list"
					aria-haspopup="listbox"
					aria-label={label}
					placeholder={
						label === 'New comment'
							? 'Add a comment…'
							: label === 'Edit comment'
								? 'Edit comment…'
								: 'Reply…'
					}
					aria-expanded={!!mention && candidates.length > 0}
					aria-controls={
						mention && candidates.length ? `${mentionId}-list` : undefined
					}
					aria-activedescendant={
						mention && candidates.length ? `${mentionId}-${choice}` : undefined
					}
					value={value}
					maxLength={8000}
					disabled={sending}
					rows={1}
					onChange={(event) =>
						change(event.target.value, event.target.selectionStart)
					}
					onSelect={(event) => {
						if (mention)
							updateMention(
								event.currentTarget.value,
								event.currentTarget.selectionStart,
							)
					}}
					css={{
						display: 'block',
						minWidth: 0,
						flex: 1,
						width: '100%',
						boxSizing: 'border-box',
						resize: 'none',
						border: 0,
						padding: '3px 0',
						background: 'transparent',
						color: colors.text,
						font: 'inherit',
						fontSize: 13,
						lineHeight: 1.5,
						outline: 'none',
						'&:focus-visible': { outline: 'none', boxShadow: 'none' },
					}}
				/>
			</div>
			{mention && candidates.length > 0 && (
				<div
					role="listbox"
					id={`${mentionId}-list`}
					aria-label="Mention someone in this file"
					css={{
						position: 'absolute',
						bottom: '100%',
						left: 0,
						right: 0,
						marginBottom: 5,
						padding: 4,
						borderRadius: 8,
						border: `1px solid ${colors.border}`,
						background: colors.surface,
						boxShadow: '0 6px 20px #0002',
						zIndex: 5,
					}}
				>
					{candidates.map((name, index) => (
						<button
							key={name}
							id={`${mentionId}-${index}`}
							role="option"
							aria-selected={index === choice}
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => selectMention(index)}
							css={{
								...commentButtonCss,
								display: 'flex',
								width: '100%',
								justifyContent: 'start',
								background:
									index === choice ? colors.borderSubtle : 'transparent',
							}}
						>
							@{name}
						</button>
					))}
				</div>
			)}
			<div
				css={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 5 }}
			>
				<button
					type="button"
					aria-label="Mention someone"
					title="Mention someone"
					css={commentButtonCss}
					disabled={sending}
					onClick={() => {
						const start = input.current?.selectionStart ?? value.length
						pendingCaret.current = start + 1
						change(value.slice(0, start) + '@' + value.slice(start), start + 1)
						input.current?.focus()
					}}
				>
					@
				</button>
				<span css={{ fontSize: 10, color: colors.textMuted }}>
					{formatForDisplay('Mod+Enter')}
				</span>
				<span css={{ flex: 1 }} />
				{onCancel && (
					<button
						type="button"
						css={commentButtonCss}
						onClick={() => {
							try {
								localStorage.removeItem(draftKey)
							} catch {}
							onCancel()
						}}
					>
						Cancel
					</button>
				)}
				<button
					type="submit"
					aria-label={submitLabel}
					title={submitLabel}
					disabled={!value.trim() || sending}
					css={{
						...commentButtonCss,
						padding: 5,
						minHeight: 25,
						color: value.trim() ? colors.text : colors.textMuted,
						background: value.trim() ? colors.primarySoft : 'transparent',
					}}
				>
					{sending ? (
						<LoadingIndicator inline label="Sending comment" />
					) : (
						<CommentIcon kind="send" />
					)}
				</button>
			</div>
		</form>
	)
}

export function FileComments({
	threads,
	comments,
	actor,
	actors,
	canComment,
	manage,
	notifications,
	activeId,
	composing,
	anchor,
	draftScope,
	onSelect,
	onCreated,
	onBack,
	onClose,
	onNew,
	run,
	documentRoot,
	moreThreads,
	moreComments,
	loadThreads,
	loadComments,
	commandError,
	status,
}: {
	threads: FileThread[]
	comments: FileComment[]
	actor: CollaborationActor
	actors: CollaborationActor[]
	canComment: boolean
	manage: boolean
	notifications: FileNotification[]
	activeId: string | null
	composing: boolean
	anchor: CommentAnchor
	draftScope: string
	onSelect: (thread: FileThread) => void
	onCreated: (id: string, anchor: CommentAnchor) => void
	commandError?: string
	status?: string
	onBack: () => void
	onClose: () => void
	onNew: () => void
	run: (command: CommentCommand) => Promise<boolean>
	documentRoot: RefObject<HTMLDivElement | null>
	moreThreads: boolean
	moreComments: boolean
	loadThreads: () => Promise<unknown>
	loadComments: () => Promise<unknown>
}) {
	const root = useRef<HTMLElement>(null)
	const [filter, setFilter] = useState('open')
	const [error, setError] = useState('')
	const [notice, setNotice] = useState<{ id: string; name: string } | null>(
		null,
	)
	const [offset, setOffset] = useState(0)
	const [loading, setLoading] = useState(false)
	const [resolving, setResolving] = useState(false)
	const pending = useRef(false)
	const focusCreated = useRef<string | null>(null)
	const selected = threads.find((thread) => thread.id === activeId)
	useEffect(() => {
		if (selected && focusCreated.current === selected.id) {
			root.current
				?.querySelector<HTMLElement>('[aria-label="Reply to discussion"]')
				?.focus({ preventScroll: true })
			focusCreated.current = null
		} else if (
			!root.current?.contains(document.activeElement) &&
			!documentRoot.current?.contains(document.activeElement)
		)
			root.current?.focus({ preventScroll: true })
	}, [activeId, composing, !!selected, documentRoot])
	const unread = new Set(
		notifications
			.filter((notification) => !notification.read)
			.map((notification) => notification.threadId),
	)
	const byThread = new Map<string, FileComment[]>()
	for (const comment of comments) {
		const group = byThread.get(comment.threadId) ?? []
		group.push(comment)
		byThread.set(comment.threadId, group)
	}
	for (const group of byThread.values())
		group.sort(
			(a, b) =>
				a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
		)
	const ordered = [...threads].sort((a, b) => {
		if (
			(a.anchor.kind === 'video' || a.anchor.kind === 'audio') &&
			(b.anchor.kind === 'video' || b.anchor.kind === 'audio')
		)
			return a.anchor.timeMs - b.anchor.timeMs || a.id.localeCompare(b.id)
		if (a.anchor.kind === 'video' || a.anchor.kind === 'audio') return -1
		if (b.anchor.kind === 'video' || b.anchor.kind === 'audio') return 1
		const last = (thread: FileThread) =>
			byThread.get(thread.id)?.at(-1)?.createdAt ?? thread.createdAt
		return last(b).localeCompare(last(a)) || b.id.localeCompare(a.id)
	})
	const visible = ordered.filter(
		(thread) =>
			thread.id === activeId ||
			filter === 'all' ||
			(filter === 'resolved'
				? !!thread.resolvedAt
				: filter === 'unread'
					? unread.has(thread.id) && !thread.resolvedAt
					: !thread.resolvedAt),
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
			onClose()
		},
		{
			target: root,
			ignoreInputs: false,
			preventDefault: false,
			ignoreDefaultPrevented: true,
			meta: { name: 'Close comments' },
		},
	)
	const index = visible.findIndex((thread) => thread.id === activeId)
	function step(direction: number) {
		const thread = visible[index + direction]
		if (thread) onSelect(thread)
	}
	useHotkeys(
		[
			{ hotkey: 'Alt+ArrowDown', callback: () => step(1) },
			{ hotkey: 'Alt+ArrowUp', callback: () => step(-1) },
		],
		{ target: root, ignoreInputs: true, enabled: !!selected },
	)
	useLayoutEffect(() => {
		if (!selected && !composing) {
			setOffset(0)
			return
		}
		let frame = 0
		const update = () => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				const target = activeId
					? documentRoot.current?.querySelector(
							`[data-comment-thread="${CSS.escape(activeId)}"]`,
						)
					: (anchor.kind === 'block' || anchor.kind === 'text') &&
						  anchor.blockId
						? documentRoot.current?.querySelector(
								`[data-page-block-id="${CSS.escape(anchor.blockId)}"]`,
							)
						: null
				const rect = target?.getBoundingClientRect(),
					aside = root.current?.getBoundingClientRect()
				setOffset(
					rect && aside
						? Math.max(
								0,
								Math.min(
									rect.top - aside.top - 48,
									window.innerHeight - aside.top - 260,
								),
							)
						: 0,
				)
			})
		}
		update()
		window.addEventListener('scroll', update, true)
		window.addEventListener('resize', update)
		const observer = new ResizeObserver(update)
		if (documentRoot.current) observer.observe(documentRoot.current)
		return () => {
			cancelAnimationFrame(frame)
			observer.disconnect()
			window.removeEventListener('scroll', update, true)
			window.removeEventListener('resize', update)
		}
	}, [activeId, anchor, composing, documentRoot, !!selected])
	async function execute(command: CommentCommand) {
		setError('')
		const ok = await run(command)
		if (!ok) setError('Could not save this change. Your draft is still here.')
		return ok
	}
	async function send(body: string) {
		if (pending.current) return false
		pending.current = true
		try {
			const threadId = activeId ?? crypto.randomUUID()
			const command: CommentCommand = activeId
				? {
						kind: 'reply',
						operationId: crypto.randomUUID(),
						threadId,
						commentId: crypto.randomUUID(),
						body,
					}
				: {
						kind: 'create',
						operationId: crypto.randomUUID(),
						threadId,
						commentId: crypto.randomUUID(),
						anchor,
						body,
					}
			if (!(await execute(command))) return false
			if (!activeId) {
				focusCreated.current = threadId
				onCreated(threadId, anchor)
			}
			return true
		} finally {
			pending.current = false
		}
	}
	async function resolve() {
		if (!selected || pending.current) return
		pending.current = true
		setResolving(true)
		try {
			if (
				await execute({
					kind: 'resolve',
					operationId: crypto.randomUUID(),
					threadId: selected.id,
					expectedVersion: selected.version,
					resolved: !selected.resolvedAt,
				})
			) {
				if (!selected.resolvedAt) {
					setNotice({ id: selected.id, name: 'Discussion resolved' })
					onBack()
				}
			}
		} finally {
			pending.current = false
			setResolving(false)
		}
	}
	async function more(load: () => Promise<unknown>) {
		if (loading) return
		setLoading(true)
		try {
			await load()
		} catch {
			setError('Could not load more comments. Try again.')
		} finally {
			setLoading(false)
		}
	}
	const filterId = useId()
	const context = selected?.anchor ?? anchor
	return (
		<aside
			ref={root}
			tabIndex={-1}
			aria-label="File comments"
			css={{
				minWidth: 0,
				position: 'relative',
				paddingInlineStart: 14,
				borderInlineStart: `1px solid ${colors.border}`,
				fontSize: 13,
				outline: 'none',
				'@media(prefers-reduced-motion:reduce)': {
					'& *': { transition: 'none !important' },
				},
				'@media(max-width:760px)': {
					position: 'fixed',
					zIndex: 70,
					inset: 'auto 0 0',
					maxHeight: 'min(75dvh, 640px)',
					overflowY: 'auto',
					padding: '0 16px max(16px, env(safe-area-inset-bottom))',
					border: `1px solid ${colors.border}`,
					borderRadius: '14px 14px 0 0',
					background: colors.surface,
					boxShadow: '0 -8px 32px #0002',
				},
			}}
		>
			<div
				css={{
					display: 'flex',
					gap: 6,
					alignItems: 'center',
					minHeight: 42,
					position: 'sticky',
					top: 0,
					zIndex: 2,
				}}
			>
				{(selected || composing) && (
					<button
						css={commentButtonCss}
						aria-label="All discussions"
						onClick={onBack}
					>
						<CommentIcon kind="back" />
					</button>
				)}
				<strong css={{ fontSize: 12, flex: 1 }}>
					Comments
					{unread.size > 0 && (
						<span
							aria-label={`${unread.size} unread discussions`}
							css={{ marginLeft: 6, color: colors.primary, fontSize: 10 }}
						>
							{unread.size}
						</span>
					)}
				</strong>
				{!selected && !composing ? (
					<Combobox
						id={filterId}
						compact
						label="Filter discussions"
						hideLabel
						selectOnly
						value={filter}
						onChange={setFilter}
						options={[
							{ id: 'open', label: 'Open' },
							{ id: 'unread', label: 'Unread' },
							{ id: 'resolved', label: 'Resolved' },
							{ id: 'all', label: 'All' },
						]}
					/>
				) : selected && visible.length > 1 ? (
					<>
						<button
							css={commentButtonCss}
							aria-label="Previous discussion"
							disabled={index <= 0}
							onClick={() => step(-1)}
						>
							<CommentIcon kind="up" />
						</button>
						<button
							css={commentButtonCss}
							aria-label="Next discussion"
							disabled={index < 0 || index >= visible.length - 1}
							onClick={() => step(1)}
						>
							<CommentIcon kind="down" />
						</button>
					</>
				) : null}
				<button
					css={commentButtonCss}
					aria-label="Close comments"
					onClick={onClose}
				>
					<CommentIcon kind="close" />
				</button>
			</div>
			{notice && (
				<div
					role="status"
					css={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '8px 0',
						fontSize: 12,
						color: colors.textMuted,
					}}
				>
					{notice.name}
					<button
						css={commentButtonCss}
						onClick={() => {
							const thread = threads.find((thread) => thread.id === notice.id)
							if (thread)
								void execute({
									kind: 'resolve',
									operationId: crypto.randomUUID(),
									threadId: thread.id,
									expectedVersion: thread.version,
									resolved: false,
								}).then((ok) => {
									if (ok) {
										setNotice(null)
										onSelect(thread)
									}
								})
						}}
					>
						Undo
					</button>
				</div>
			)}
			<div
				css={{
					marginTop: offset,
					transition: 'margin-top 140ms ease-out',
					'@media(max-width:760px)': { marginTop: 0 },
					'@media(prefers-reduced-motion:reduce)': { transition: 'none' },
				}}
			>
				{selected || composing || activeId ? (
					<div
						css={{
							border: `1px solid ${colors.border}`,
							borderRadius: 9,
							background: colors.surface,
							boxShadow: '0 3px 12px #0000000a',
							overflow: 'visible',
						}}
					>
						{context.kind !== 'file' && (
							<button
								css={{
									...commentButtonCss,
									display: 'block',
									textAlign: 'left',
									width: '100%',
									padding: '10px 12px',
									borderBottom: `1px solid ${colors.border}`,
									borderRadius: '8px 8px 0 0',
									color: colors.textMuted,
									lineHeight: 1.45,
								}}
								aria-label={
									context.kind === 'video' || context.kind === 'audio'
										? `Go to ${videoTime(context.timeMs, true)}`
										: 'Show commented content'
								}
								disabled={
									(context.kind === 'video' || context.kind === 'audio') &&
									(!selected || selected.outdated)
								}
								onClick={() => {
									if (selected) onSelect(selected)
									else
										documentRoot.current
											?.querySelector('[data-comment-draft]')
											?.scrollIntoView({
												block: 'center',
												behavior: window.matchMedia(
													'(prefers-reduced-motion: reduce)',
												).matches
													? 'auto'
													: 'smooth',
											})
								}}
							>
								<span
									css={{
										display: 'block',
										paddingLeft: 8,
										borderLeft: '2px solid #d3a64a',
										maxHeight: '3lh',
										overflow: 'hidden',
									}}
								>
									{context.kind === 'video' || context.kind === 'audio'
										? videoTime(context.timeMs, true)
										: commentAnchorLabel(context)}
								</span>
							</button>
						)}
						{selected && (
							<>
								{(selected.outdated || selected.resolvedAt) && (
									<div
										css={{
											padding: '8px 12px 0',
											color: colors.textMuted,
											fontSize: 11,
										}}
									>
										{selected.outdated
											? 'Original content removed'
											: `Resolved by ${selected.resolvedBy?.name ?? 'a collaborator'}`}
									</div>
								)}
								<ThreadComments
									comments={byThread.get(selected.id) ?? []}
									actor={actor}
									actors={actors}
									canComment={canComment}
									manage={manage}
									run={execute}
									draftScope={draftScope}
									onResolve={resolve}
									resolving={resolving}
									resolved={!!selected.resolvedAt}
								/>
								{moreComments && (
									<button
										css={commentButtonCss}
										disabled={loading}
										onClick={() => void more(loadComments)}
									>
										{loading ? (
											<LoadingIndicator inline label="Loading comments" />
										) : (
											'More replies'
										)}
									</button>
								)}
							</>
						)}
						{activeId && !selected && (
							<div
								role="status"
								css={{ padding: 12, fontSize: 12, color: colors.textMuted }}
							>
								{status === 'offline' ? (
									'Comment saved on this device. Waiting for connection.'
								) : (
									<LoadingIndicator inline label="Loading discussion" />
								)}
							</div>
						)}
						{canComment &&
							!selected?.resolvedAt &&
							(!activeId || !!selected) && (
								<div css={{ padding: selected ? '6px 9px 9px' : 9 }}>
									<CommentComposer
										key={`${activeId ?? 'new'}:${JSON.stringify(anchor)}`}
										actor={actor}
										actors={actors}
										draftKey={`${draftScope}:${activeId ?? (anchor.kind === 'file' ? 'new' : `new:${JSON.stringify(anchor)}`)}`}
										label={activeId ? 'Reply to discussion' : 'New comment'}
										submitLabel={activeId ? 'Send reply' : 'Post comment'}
										onSubmit={send}
										focus={composing}
									/>
								</div>
							)}
					</div>
				) : (
					<>
						<div css={{ display: 'grid', gap: 3 }}>
							{visible.map((thread) => {
								const replies = byThread.get(thread.id) ?? [],
									first = replies[0],
									last = replies.at(-1)
								return (
									<button
										key={thread.id}
										aria-label={`Open discussion by ${thread.createdBy.name}${thread.anchor.kind === 'video' || thread.anchor.kind === 'audio' ? ` at ${videoTime(thread.anchor.timeMs, true)}` : ''}${unread.has(thread.id) ? ', unread' : ''}`}
										onClick={() => onSelect(thread)}
										css={{
											...commentButtonCss,
											display: 'block',
											textAlign: 'left',
											width: '100%',
											padding: '11px 8px',
											borderBottom: `1px solid ${colors.border}`,
											borderRadius: 5,
											color: colors.text,
										}}
									>
										<div
											css={{ display: 'flex', alignItems: 'center', gap: 8 }}
										>
											<Avatar actor={thread.createdBy} />
											<strong
												css={{
													flex: 1,
													minWidth: 0,
													overflow: 'hidden',
													textOverflow: 'ellipsis',
													whiteSpace: 'nowrap',
													fontSize: 12,
												}}
											>
												{thread.createdBy.name}
											</strong>
											{unread.has(thread.id) && (
												<span
													aria-label="Unread"
													css={{
														width: 5,
														height: 5,
														borderRadius: '50%',
														background: colors.primary,
													}}
												/>
											)}
											<time
												dateTime={last?.createdAt ?? thread.createdAt}
												title={new Date(
													last?.createdAt ?? thread.createdAt,
												).toLocaleString()}
												css={{ color: colors.textMuted, fontSize: 10 }}
											>
												{commentTime(last?.createdAt ?? thread.createdAt)}
											</time>
										</div>
										{thread.anchor.kind !== 'file' && (
											<div
												css={{
													margin: '7px 0 5px 34px',
													paddingLeft: 6,
													borderLeft: '2px solid #d3a64a',
													color: colors.textMuted,
													fontSize: 11,
													whiteSpace: 'nowrap',
													overflow: 'hidden',
													textOverflow: 'ellipsis',
												}}
											>
												{thread.anchor.kind === 'video' ||
												thread.anchor.kind === 'audio'
													? videoTime(thread.anchor.timeMs, true)
													: commentAnchorLabel(thread.anchor)}
											</div>
										)}
										<div
											css={{
												paddingLeft: 34,
												marginTop: 5,
												lineHeight: 1.5,
												overflow: 'hidden',
												display: '-webkit-box',
												WebkitLineClamp: 2,
												WebkitBoxOrient: 'vertical',
												fontSize: 12,
											}}
										>
											{first?.deletedAt
												? 'Comment removed'
												: (first?.body ?? 'Discussion')}
										</div>
										{(replies.length > 1 ||
											thread.resolvedAt ||
											thread.outdated) && (
											<div
												css={{
													paddingLeft: 34,
													paddingTop: 5,
													fontSize: 10,
													color: colors.textMuted,
												}}
											>
												{thread.resolvedAt
													? 'Resolved'
													: thread.outdated
														? 'Original content removed'
														: `${replies.length - 1} ${replies.length === 2 ? 'reply' : 'replies'}`}
											</div>
										)}
									</button>
								)
							})}
						</div>
						{!visible.length && !moreThreads && (
							<div
								css={{
									display: 'grid',
									justifyItems: 'center',
									gap: 8,
									padding: '28px 12px',
									textAlign: 'center',
									color: colors.textMuted,
								}}
							>
								<CommentIcon />
								<p role="status" css={{ fontSize: 12, margin: 0 }}>
									{filter === 'unread'
										? 'You’re all caught up'
										: filter === 'resolved'
											? 'No resolved discussions'
											: filter === 'open' && threads.length
												? 'No open discussions'
												: 'No comments yet'}
								</p>
							</div>
						)}
						{moreThreads && (
							<button
								css={commentButtonCss}
								disabled={loading}
								onClick={() => void more(loadThreads)}
							>
								{loading ? (
									<LoadingIndicator inline label="Loading discussions" />
								) : (
									'Load more discussions'
								)}
							</button>
						)}
						{canComment && (
							<button
								css={{
									...commentButtonCss,
									margin: '12px 0',
									width: '100%',
									background: colors.primarySoft,
									fontWeight: 600,
								}}
								onClick={onNew}
							>
								<CommentIcon /> Add a comment
							</button>
						)}
					</>
				)}
			</div>
			{(error || commandError) && (
				<p
					role="alert"
					css={{ color: colors.danger, fontSize: 12, lineHeight: 1.5 }}
				>
					{commandError || error}
				</p>
			)}
		</aside>
	)
}

function ThreadComments({
	comments,
	actor,
	actors,
	canComment,
	manage,
	run,
	draftScope,
	onResolve,
	resolving,
	resolved,
}: {
	comments: FileComment[]
	actor: CollaborationActor
	actors: CollaborationActor[]
	canComment: boolean
	manage: boolean
	run: (command: CommentCommand) => Promise<boolean>
	draftScope: string
	onResolve: () => Promise<void>
	resolving: boolean
	resolved: boolean
}) {
	const [editing, setEditing] = useState<string | null>(null)
	const [clipboardError, setClipboardError] = useState('')
	const [busy, setBusy] = useState(false)
	const lock = useRef(false)
	async function change(command: CommentCommand) {
		if (lock.current) return false
		lock.current = true
		setBusy(true)
		try {
			return await run(command)
		} finally {
			lock.current = false
			setBusy(false)
		}
	}
	function actions(target: Element): ContextAction[] | undefined {
		const id =
			target.closest<HTMLElement>('[data-comment-id]')?.dataset.commentId
		const comment = comments.find((comment) => comment.id === id)
		if (!comment || comment.deletedAt || busy || resolving) return
		const result: ContextAction[] = [
			{
				id: 'copy',
				label: 'Copy text',
				run: async () => {
					try {
						await navigator.clipboard.writeText(comment.body)
						setClipboardError('')
					} catch {
						setClipboardError(
							'Could not copy. Select the comment text to copy it.',
						)
					}
				},
			},
		]
		if (canComment && comment.author.id === actor.id)
			result.unshift({
				id: 'edit',
				label: 'Edit',
				run: () => setEditing(comment.id),
			})
		if (canComment && (manage || comment.author.id === actor.id))
			result.push({
				id: 'remove',
				label: 'Remove',
				danger: true,
				run: async () => {
					await change({
						kind: 'remove',
						operationId: crypto.randomUUID(),
						commentId: comment.id,
						expectedVersion: comment.version,
					})
				},
			})
		return result
	}
	return (
		<ContextMenuSurface resolve={actions}>
			<div>
				{[...comments]
					.sort(
						(a, b) =>
							a.createdAt.localeCompare(b.createdAt) ||
							a.id.localeCompare(b.id),
					)
					.map((comment, index) => (
						<article
							key={comment.id}
							data-comment-id={comment.id}
							aria-label={`Comment by ${comment.author.name}`}
							css={{
								position: 'relative',
								padding: '10px 12px',
								'& .comment-actions': {
									opacity: 0,
									transition: 'opacity 120ms ease-out',
								},
								'&:hover .comment-actions, &:focus-within .comment-actions': {
									opacity: 1,
									transition: 'none',
								},
								'@media(hover:none)': { '& .comment-actions': { opacity: 1 } },
							}}
						>
							<div css={{ display: 'flex', gap: 8, alignItems: 'start' }}>
								<Avatar actor={comment.author} />
								<div css={{ flex: 1, minWidth: 0 }}>
									<div
										css={{
											display: 'flex',
											gap: 5,
											alignItems: 'center',
											margin: '2px 0 6px',
											fontSize: 11,
										}}
									>
										<strong>{comment.author.name}</strong>
										{comment.author.kind === 'agent' && (
											<span
												css={{
													color: colors.textMuted,
													fontSize: 9,
													border: `1px solid ${colors.border}`,
													borderRadius: 3,
													padding: '0 3px',
												}}
											>
												Agent
											</span>
										)}
										<time
											dateTime={comment.createdAt}
											title={new Date(comment.createdAt).toLocaleString()}
											css={{ color: colors.textMuted, fontSize: 10 }}
										>
											{commentTime(comment.createdAt)}
										</time>
										{comment.editedAt && (
											<span
												title={new Date(comment.editedAt).toLocaleString()}
												css={{ color: colors.textMuted, fontSize: 9 }}
											>
												edited
											</span>
										)}
										<span css={{ flex: 1 }} />
										{index === 0 && canComment && (
											<button
												css={commentButtonCss}
												className="comment-actions"
												disabled={busy || resolving}
												aria-label={
													resolved ? 'Reopen discussion' : 'Resolve discussion'
												}
												title={
													resolved ? 'Reopen discussion' : 'Resolve discussion'
												}
												onClick={() => void onResolve()}
											>
												{resolving ? (
													<LoadingIndicator inline label="Saving discussion" />
												) : (
													<CommentIcon kind="check" />
												)}
											</button>
										)}
										{!comment.deletedAt && (
											<ContextMenuButton
												className="comment-actions"
												label={`Actions for comment by ${comment.author.name}`}
												disabled={busy || resolving}
												css={{
													...commentButtonCss,
													minHeight: 22,
													padding: '0 3px',
												}}
											>
												<CommentIcon kind="more" />
											</ContextMenuButton>
										)}
									</div>
									{editing === comment.id ? (
										<CommentComposer
											actor={actor}
											actors={actors}
											draftKey={`${draftScope}:edit:${comment.id}`}
											label="Edit comment"
											submitLabel="Save comment"
											initial={comment.body}
											focus
											onCancel={() => setEditing(null)}
											onSubmit={async (body) => {
												const ok = await change({
													kind: 'edit',
													operationId: crypto.randomUUID(),
													commentId: comment.id,
													expectedVersion: comment.version,
													body,
												})
												if (ok) setEditing(null)
												return ok
											}}
										/>
									) : comment.deletedAt ? (
										<span css={{ color: colors.textMuted, fontSize: 12 }}>
											Comment removed
										</span>
									) : (
										<CommentBody body={comment.body} />
									)}
								</div>
							</div>
						</article>
					))}
			</div>
			{clipboardError && <p role="alert">{clipboardError}</p>}
		</ContextMenuSurface>
	)
}
