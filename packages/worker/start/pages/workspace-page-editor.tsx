/** @jsxImportSource @emotion/react */
import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useMemo,
	useState,
	type ReactNode,
} from 'react'
import { Node, Extension, InputRule } from '@tiptap/core'
import {
	EditorContent,
	NodeViewContent,
	NodeViewWrapper,
	ReactNodeViewRenderer,
	useEditor,
	type NodeViewProps,
} from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { workspaceCommentMarks } from './workspace-comment-marks.ts'
import { useHotkey } from '@tanstack/react-hotkeys'
import { CommentSelectionToolbar } from './comment-selection-toolbar.tsx'
import {
	type FileThread,
	type CommentAnchor,
} from '#universal/file-collaboration.ts'
import {
	absolutePositionToRelativePosition,
	ySyncPluginKey,
} from '@tiptap/y-tiptap'
import { type FileRoomClient } from './file-room-client.ts'
import { actorColor } from '#universal/collaboration-color.ts'
import { replaceCollaborativeContent } from '#universal/collaborative-document.ts'
import {
	blocksToDocument,
	documentToBlocks,
	stableBlockIdsPlugin,
} from './workspace-document.ts'
import { type FileMetadata } from '#universal/files.ts'
import {
	readWorkspacePage,
	writeWorkspacePage,
	type PageBlock,
} from '#universal/workspace-page.ts'
import {
	ContextMenuSurface,
	ContextMenuButton,
	type ContextAction,
} from '../components/context-menu-surface.tsx'
import { BlockPicker, type BlockChoice } from './block-picker.tsx'
import { colors, typography } from '#universal/styles/tokens.ts'
import { workspaceProse } from './workspace-prose.ts'

const labels = {
	paragraph: 'Text',
	heading: 'Heading',
	bullet: 'Bullet',
	task: 'Checklist',
	quote: 'Quote',
	code: 'Code',
}
const shortcuts: Record<string, Exclude<PageBlock['kind'], 'file'>> = {
	'# ': 'heading',
	'- ': 'bullet',
	'[] ': 'task',
	'> ': 'quote',
	'```': 'code',
}
const control = {
	font: 'inherit',
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
	background: 'transparent',
	border: 0,
	borderRadius: 4,
	padding: '3px 5px',
	cursor: 'pointer',
	'&:hover': {
		background: `color-mix(in srgb, ${colors.text} 7%, transparent)`,
	},
}
function PlusIcon() {
	return (
		<svg
			aria-hidden="true"
			width="14"
			height="14"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.3"
		>
			<path d="M8 3v10M3 8h10" />
		</svg>
	)
}

const noThreads: FileThread[] = []
export function WorkspacePageEditor({
	content,
	onChange,
	files,
	renderFile,
	collaboration,
	onComment,
	threads = noThreads,
	onSelectThread,
	activeThreadId,
	draftAnchor,
}: {
	content: string
	threads?: FileThread[]
	onSelectThread?: (thread: FileThread) => void
	onComment?: (anchor: CommentAnchor) => void
	activeThreadId?: string | null
	draftAnchor?: CommentAnchor
	collaboration?: FileRoomClient
	onChange?: (value: string) => void
	files: FileMetadata[]
	renderFile: (id: string) => ReactNode
}) {
	const blocks = useMemo(
		() => readWorkspacePage(content)?.blocks ?? [],
		[content],
	)
	const editable = !!onChange
	const [focus, setFocus] = useState<{ id: string; end?: boolean } | null>(null)
	const [picker, setPicker] = useState<PickerState | null>(null)
	const [message, setMessage] = useState('')
	const canvas = useRef<HTMLDivElement>(null)

	const discussions = useRef({
		threads,
		select: onSelectThread,
		activeThreadId,
		draftAnchor,
	})
	discussions.current = {
		threads,
		select: onSelectThread,
		activeThreadId,
		draftAnchor,
	}
	const [commentRect, setCommentRect] = useState<DOMRect | null>(null)
	const editor = useEditor({
		extensions: [
			workspaceCommentMarks(() => discussions.current),
			...documentExtensions.map((extension) =>
				collaboration && extension.name === 'starterKit'
					? extension.configure({ undoRedo: false })
					: extension,
			),
			...(collaboration
				? [
						Collaboration.configure({ document: collaboration.doc }),
						CollaborationCaret.configure({
							provider: collaboration,
							render(user) {
								const caret = CollaborationCaret.options.render(user)
								if (typeof user.sessionId === 'string')
									caret.dataset.presenceSession = user.sessionId
								return caret
							},
							user: {
								name:
									collaboration.getSnapshot().snapshot?.actor.name ?? 'Member',
								color: actorColor(
									collaboration.getSnapshot().snapshot?.actor.id ?? 'member',
								),
							},
						}),
					]
				: []),
		],
		content: collaboration ? undefined : blocksToDocument(blocks),
		immediatelyRender: false,
		editable: !!onChange,
		editorProps: {
			attributes: {
				'aria-label': 'Page content',
				role: 'textbox',
				'aria-multiline': 'true',
			},
		},
		onUpdate: ({ editor }) => {
			onChange?.(writeWorkspacePage(documentToBlocks(editor.state.doc)))
			const { $from, empty } = editor.state.selection
			if (
				empty &&
				$from.parent.type.name === 'workspaceText' &&
				$from.parent.textContent === '/' &&
				$from.parent.attrs.kind !== 'code'
			) {
				const element = editor.view.nodeDOM($from.before())
				if (element instanceof HTMLElement)
					setPicker({
						id: $from.parent.attrs.id,
						after: $from.index(0),
						mode: 'slash',
						anchor: element.getBoundingClientRect(),
					})
			}
		},
	})
	useEffect(() => {
		if (editor)
			editor.view.dispatch(editor.state.tr.setMeta('comments-updated', true))
	}, [editor, threads, activeThreadId, draftAnchor])
	function selectedCommentAnchor(): CommentAnchor | null {
		if (!editor || !collaboration) return null
		const { from, to, $from, empty } = editor.state.selection
		const block = $from.depth ? $from.node(1) : null
		const blockId = block?.attrs.id as string | undefined
		if (empty)
			return blockId
				? { kind: 'block', blockId, quote: block?.textContent.slice(0, 2000) }
				: null
		const binding = ySyncPluginKey.getState(editor.state)?.binding
		if (!binding) return null
		const start = absolutePositionToRelativePosition(
				from,
				binding.type,
				binding.mapping,
			),
			end = absolutePositionToRelativePosition(
				to,
				binding.type,
				binding.mapping,
			)
		const quote = editor.state.doc.textBetween(from, to, ' ').slice(0, 2000)
		return start && end && quote
			? {
					kind: 'text',
					blockId,
					start: JSON.stringify(start),
					end: JSON.stringify(end),
					quote,
					revisionId: collaboration.getSnapshot().snapshot!.revisionId,
				}
			: null
	}
	function commentSelection() {
		const anchor = selectedCommentAnchor()
		if (anchor) {
			onComment?.(anchor)
			setCommentRect(null)
		}
	}
	useHotkey('Mod+Alt+M', commentSelection, {
		target: canvas,
		ignoreInputs: false,
		enabled: !!onComment && !!collaboration,
		meta: { name: 'Comment on selection' },
	})
	useEffect(() => {
		if (!editor || !onComment || !collaboration) return
		const update = () => {
			const range = window.getSelection()
			const active = document.activeElement
			if (
				active instanceof HTMLElement &&
				active.matches('input, textarea, [contenteditable=true]') &&
				!canvas.current?.contains(active)
			) {
				setCommentRect(null)
				return
			}
			if (
				!range?.rangeCount ||
				range.isCollapsed ||
				!canvas.current?.contains(range.anchorNode) ||
				editor.state.selection.empty
			) {
				setCommentRect(null)
				return
			}
			setCommentRect(range.getRangeAt(0).getBoundingClientRect())
		}
		const blur = () =>
			requestAnimationFrame(() => {
				if (
					!canvas.current?.contains(document.activeElement) &&
					!(
						document.activeElement instanceof Element &&
						document.activeElement.closest('[aria-label="Text selection"]')
					)
				)
					setCommentRect(null)
			})
		editor.on('selectionUpdate', update)
		editor.on('blur', blur)
		document.addEventListener('selectionchange', update)
		window.addEventListener('scroll', update, true)
		window.addEventListener('resize', update)
		return () => {
			editor.off('selectionUpdate', update)
			editor.off('blur', blur)
			document.removeEventListener('selectionchange', update)
			window.removeEventListener('scroll', update, true)
			window.removeEventListener('resize', update)
		}
	}, [editor, onComment, collaboration])
	useEffect(() => {
		editor?.setEditable(editable)
	}, [editor, editable])
	useEffect(() => {
		if (
			!collaboration &&
			editor &&
			writeWorkspacePage(documentToBlocks(editor.state.doc)) !==
				writeWorkspacePage(blocks)
		) {
			editor.commands.setContent(blocksToDocument(blocks), {
				emitUpdate: false,
			})
		}
	}, [editor, blocks, collaboration])
	useEffect(() => {
		if (!focus || !editor) return
		editor.state.doc.forEach((node, pos) => {
			if (node.attrs.id === focus.id && node.isTextblock)
				editor.commands.focus(focus.end ? pos + node.nodeSize - 1 : pos + 1)
		})
	}, [focus, editor])
	function change(next: PageBlock[]) {
		if (!editor || !onChange) return
		if (collaboration) {
			replaceCollaborativeContent(
				collaboration.doc,
				'application/vnd.kody.page+json',
				writeWorkspacePage(next),
			)
			return
		}
		editor.commands.command(({ tr }) => {
			tr.replaceWith(
				0,
				tr.doc.content.size,
				editor.schema.nodeFromJSON(blocksToDocument(next)).content,
			)
			return true
		})
	}
	function update(block: PageBlock) {
		change(blocks.map((entry) => (entry.id === block.id ? block : entry)))
	}

	function choose(choice: BlockChoice) {
		if (!picker) return
		const existing = blocks.find((block) => block.id === picker.id)
		const id =
			picker.mode === 'insert'
				? crypto.randomUUID()
				: (existing?.id ?? crypto.randomUUID())
		const text =
			existing && existing.kind !== 'file'
				? picker.mode === 'slash'
					? existing.text.replace(/^\//, '')
					: existing.text
				: ''
		const next: PageBlock =
			choice.kind === 'file'
				? { id, kind: 'file', fileId: choice.fileId }
				: {
						id,
						kind: choice.kind,
						text,
						...(existing &&
						existing.kind !== 'file' &&
						existing.checked !== undefined
							? { checked: existing.checked }
							: {}),
					}
		if (picker.mode !== 'insert' && existing) update(next)
		else if (blocks.length < 250)
			change([
				...blocks.slice(0, picker.after + 1),
				next,
				...blocks.slice(picker.after + 1),
			])
		setPicker(null)
		if (choice.kind !== 'file') setFocus({ id })
	}
	function closePicker(restoreFocus = false) {
		if (restoreFocus && picker?.id) setFocus({ id: picker.id })
		else if (restoreFocus && picker?.trigger) {
			const trigger = picker.trigger
			requestAnimationFrame(() => trigger.focus({ preventScroll: true }))
		}
		setPicker(null)
	}
	function actions(target: Element): ContextAction[] | undefined {
		const id = target.closest<HTMLElement>('[data-page-block-id]')?.dataset
			.pageBlockId
		const index = blocks.findIndex((block) => block.id === id)
		const block = blocks[index]
		if (!block) return
		// File previews retain file actions, while their gutter manages the embed block.
		if (block.kind === 'file' && !target.closest('[data-block-gutter]')) return
		const result: ContextAction[] = [
			{
				id: 'copy-link',
				label: 'Copy block link',
				run: async () => {
					try {
						const url = new URL(window.location.href)
						url.hash = 'block-' + block.id
						await navigator.clipboard.writeText(url.href)
					} catch {
						setMessage('Could not copy the link.')
					}
				},
			},
		]
		if (block.kind !== 'file')
			result.unshift({
				id: 'copy',
				label: 'Copy text',
				run: async () => {
					try {
						await navigator.clipboard.writeText(block.text)
					} catch {
						setMessage('Could not copy the text.')
					}
				},
			})
		if (onComment) {
			const selection = selectedCommentAnchor()
			const quote =
				block.kind === 'file'
					? (files.find((file) => file.id === block.fileId)?.name ??
						'Attached file')
					: block.text.slice(0, 2000)
			result.unshift({
				id: 'comment',
				label: 'Comment',
				run: () =>
					onComment(
						selection?.kind === 'text'
							? selection
							: { kind: 'block', blockId: block.id, quote },
					),
			})
		}
		if (!onChange) return result
		if (block.kind !== 'file')
			result.unshift({
				id: 'turn',
				label: 'Turn into…',
				run: () => {
					const element = canvas.current?.querySelector<HTMLElement>(
						`[data-page-block-id="${block.id}"]`,
					)
					if (element)
						setPicker({
							id: block.id,
							after: index,
							mode: 'turn',
							anchor: element.getBoundingClientRect(),
						})
				},
			})
		result.push({
			id: 'duplicate',
			label: 'Duplicate block',
			disabled: blocks.length >= 250,
			run: () => {
				const id = crypto.randomUUID()
				change([
					...blocks.slice(0, index + 1),
					{ ...block, id },
					...blocks.slice(index + 1),
				])
				setFocus({ id })
			},
		})
		for (const [direction, offset] of [
			['up', -1],
			['down', 1],
		] as const)
			result.push({
				id: 'move-' + direction,
				label: 'Move ' + direction,
				disabled: index + offset < 0 || index + offset >= blocks.length,
				run: () => {
					const next = [...blocks]
					const other = next[index + offset]
					if (other) {
						next[index] = other
						next[index + offset] = block
						change(next)
					}
				},
			})
		result.push({
			id: 'remove',
			label: 'Remove block',
			danger: true,
			run: () => {
				change(blocks.filter((entry) => entry.id !== block.id))
				const previous = blocks[index - 1]
				if (previous) setFocus({ id: previous.id, end: true })
			},
		})
		return result
	}
	return (
		<WorkspaceEditorContext.Provider
			value={{ renderFile, editable: !!onChange, openPicker: setPicker }}
		>
			<ContextMenuSurface
				resolve={actions}
				allowTextEditing={Boolean(onComment)}
			>
				{commentRect && onComment && (
					<CommentSelectionToolbar
						rect={commentRect}
						onComment={commentSelection}
					/>
				)}
				<div ref={canvas} css={documentCss}>
					{editor ? (
						<EditorContent editor={editor} />
					) : (
						blocks.map((block) => (
							<div
								key={block.id}
								data-kind={block.kind}
								className="workspace-block"
							>
								{block.kind === 'file' ? (
									renderFile(block.fileId)
								) : (
									<div className="block-row">
										{block.kind === 'task' && (
											<input
												type="checkbox"
												aria-label={block.text || 'Task'}
												checked={block.checked ?? false}
												disabled
											/>
										)}
										{block.kind === 'bullet' && (
											<span className="block-bullet" aria-hidden="true">
												•
											</span>
										)}
										<div className="block-text">{block.text}</div>
									</div>
								)}
							</div>
						))
					)}
					{onChange && blocks.length < 250 && (
						<button
							type="button"
							css={{
								...control,
								display: 'flex',
								alignItems: 'center',
								gap: 7,
								marginTop: 8,
							}}
							aria-label="Add block"
							onClick={(event) =>
								setPicker({
									after: blocks.length - 1,
									mode: 'insert',
									anchor: event.currentTarget.getBoundingClientRect(),
									trigger: event.currentTarget,
								})
							}
						>
							<PlusIcon />
							Add block
						</button>
					)}
					{picker && (
						<BlockPicker
							anchor={picker.anchor}
							files={files}
							includeFiles={picker.mode !== 'turn'}
							onSelect={choose}
							onClose={closePicker}
						/>
					)}
					{message && <p role="status">{message}</p>}
				</div>
			</ContextMenuSurface>
		</WorkspaceEditorContext.Provider>
	)
}

type PickerState = {
	id?: string
	after: number
	mode: 'insert' | 'turn' | 'slash'
	anchor: DOMRect
	trigger?: HTMLButtonElement
}
const WorkspaceEditorContext = createContext<{
	renderFile: (id: string) => ReactNode
	editable: boolean
	openPicker: (picker: PickerState) => void
}>({ renderFile: () => null, editable: false, openPicker: () => {} })

function WorkspaceBlockView({
	node,
	editor,
	getPos,
	updateAttributes,
}: NodeViewProps) {
	const { renderFile, editable, openPicker } = useContext(
		WorkspaceEditorContext,
	)
	const pos = getPos()
	const index =
		typeof pos === 'number' ? editor.state.doc.resolve(pos).index() : 0
	const kind = node.type.name === 'workspaceFile' ? 'file' : node.attrs.kind
	return (
		<NodeViewWrapper
			className="workspace-block"
			data-kind={kind}
			data-page-block-id={node.attrs.id}
			id={`block-${node.attrs.id}`}
		>
			{editable && (
				<div
					contentEditable={false}
					data-block-gutter=""
					className="block-gutter"
				>
					<button
						type="button"
						css={control}
						aria-label={`Insert after block ${index + 1}`}
						onClick={(event) =>
							openPicker({
								after: index,
								mode: 'insert',
								anchor: event.currentTarget.getBoundingClientRect(),
								trigger: event.currentTarget,
							})
						}
					>
						<PlusIcon />
					</button>
					<span data-drag-handle="">
						<ContextMenuButton
							label={`Block ${index + 1} actions`}
							onDragStart={() => {}}
							css={control}
						>
							<span aria-hidden="true">⠿</span>
						</ContextMenuButton>
					</span>
				</div>
			)}
			{kind === 'file' ? (
				<div contentEditable={false}>{renderFile(node.attrs.fileId)}</div>
			) : (
				<div className="block-row">
					{kind === 'task' && (
						<input
							contentEditable={false}
							type="checkbox"
							aria-label={node.textContent || 'Task'}
							checked={node.attrs.checked ?? false}
							disabled={!editable}
							onChange={(event) =>
								updateAttributes({ checked: event.target.checked })
							}
						/>
					)}
					{kind === 'bullet' && (
						<span
							contentEditable={false}
							className="block-bullet"
							aria-hidden="true"
						>
							•
						</span>
					)}
					<NodeViewContent
						className="block-text"
						data-placeholder={
							kind === 'paragraph'
								? 'Type / for commands'
								: labels[kind as keyof typeof labels]
						}
					/>
				</div>
			)}
		</NodeViewWrapper>
	)
}

const WorkspaceText = Node.create({
	name: 'workspaceText',
	group: 'block',
	content: 'inline*',
	draggable: true,
	addAttributes() {
		return {
			id: { default: null },
			kind: { default: 'paragraph' },
			checked: { default: null },
		}
	},
	parseHTML() {
		return [
			{ tag: 'div[data-workspace-text]' },
			{ tag: 'p', getAttrs: () => ({ kind: 'paragraph' }) },
			{ tag: 'h1', getAttrs: () => ({ kind: 'heading' }) },
			{ tag: 'h2', getAttrs: () => ({ kind: 'heading' }) },
			{ tag: 'h3', getAttrs: () => ({ kind: 'heading' }) },
			{ tag: 'blockquote', getAttrs: () => ({ kind: 'quote' }) },
			{ tag: 'pre', getAttrs: () => ({ kind: 'code' }) },
			{ tag: 'li', getAttrs: () => ({ kind: 'bullet' }) },
		]
	},
	renderHTML({ HTMLAttributes }) {
		return ['div', { 'data-workspace-text': '', ...HTMLAttributes }, 0]
	},
	addNodeView() {
		return ReactNodeViewRenderer(WorkspaceBlockView)
	},
	addKeyboardShortcuts() {
		return {
			Enter: () => {
				const { $from, empty } = this.editor.state.selection
				const node = $from.parent
				if (node.type.name !== 'workspaceText') return false
				if (node.attrs.kind === 'code')
					return this.editor.commands.setHardBreak()
				if (
					empty &&
					!node.textContent &&
					['bullet', 'task'].includes(node.attrs.kind)
				)
					return this.editor.commands.updateAttributes('workspaceText', {
						kind: 'paragraph',
						checked: null,
					})
				const kind = ['bullet', 'task'].includes(node.attrs.kind)
					? node.attrs.kind
					: 'paragraph'
				return this.editor
					.chain()
					.splitBlock()
					.updateAttributes('workspaceText', {
						id: null,
						kind,
						checked: kind === 'task' ? false : null,
					})
					.run()
			},
		}
	},
	addInputRules() {
		return Object.entries(shortcuts).map(
			([text, kind]) =>
				new InputRule({
					find: new RegExp(
						'^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
					),
					handler: ({ state, range }) => {
						const node = state.selection.$from.parent
						if (
							node.type.name !== 'workspaceText' ||
							node.attrs.kind !== 'paragraph'
						)
							return null
						state.tr
							.delete(range.from, range.to)
							.setNodeMarkup(state.selection.$from.before(), undefined, {
								...node.attrs,
								kind,
							})
					},
				}),
		)
	},
})
const WorkspaceFile = Node.create({
	name: 'workspaceFile',
	group: 'block',
	atom: true,
	draggable: true,
	addAttributes() {
		return { id: { default: null }, fileId: { default: null } }
	},
	parseHTML() {
		return [{ tag: 'div[data-workspace-file]' }]
	},
	renderHTML({ HTMLAttributes }) {
		return ['div', { 'data-workspace-file': '', ...HTMLAttributes }]
	},
	addNodeView() {
		return ReactNodeViewRenderer(WorkspaceBlockView)
	},
})
const StableBlockIds = Extension.create({
	name: 'stableWorkspaceBlockIds',
	addProseMirrorPlugins() {
		return [stableBlockIdsPlugin()]
	},
})
const documentExtensions = [
	StarterKit.configure({
		paragraph: false,
		heading: false,
		blockquote: false,
		bulletList: false,
		orderedList: false,
		listItem: false,
		listKeymap: false,
		codeBlock: false,
		code: false,
		bold: false,
		italic: false,
		strike: false,
		underline: false,
		link: false,
		horizontalRule: false,
		trailingNode: false,
	}),
	WorkspaceText,
	WorkspaceFile,
	StableBlockIds,
]
const documentCss: import('@emotion/react').CSSObject = {
	...workspaceProse.body,
	'& .tiptap': { outline: 'none' },
	'& .collaboration-carets__caret': {
		borderLeft: '2px solid',
		position: 'relative',
		marginInline: '-1px',
		pointerEvents: 'none',
	},
	'& .collaboration-carets__label': {
		position: 'absolute',
		bottom: '100%',
		left: -2,
		padding: '1px 5px',
		borderRadius: '3px 3px 3px 0',
		fontSize: 11,
		color: '#fff',
		whiteSpace: 'nowrap',
	},
	'& .collaboration-carets__selection': { opacity: 0.25 },
	'& .workspace-block': {
		position: 'relative' as const,
		...workspaceProse.block,
	},
	'& .block-row': {
		display: 'flex',
		alignItems: 'baseline',
		gap: 8,
		minWidth: 0,
	},
	'& .block-text': {
		font: 'inherit',
		color: 'inherit',
		lineHeight: workspaceProse.body.lineHeight,
		width: '100%',
		minWidth: 0,
		...workspaceProse.text,
		whiteSpace: 'pre-wrap' as const,
		overflowWrap: 'anywhere' as const,
	},
	'& [data-kind="heading"] .block-text': workspaceProse.heading,
	'& [data-kind="quote"] .block-text': workspaceProse.quote,
	'& [data-kind="code"] .block-text': workspaceProse.code,
	'& .block-gutter': {
		position: 'absolute' as const,
		insetInlineStart: -49,
		top: 0,
		display: 'flex',
		gap: 1,
		opacity: 0,
		userSelect: 'none' as const,
	},
	'& [data-kind="heading"] > .block-gutter': { top: 13 },
	'& .workspace-block:hover > .block-gutter, & .workspace-block:focus-within > .block-gutter':
		{ opacity: 1 },
	'& .block-gutter button': { width: 23, height: 26 },
	'& .block-bullet': { userSelect: 'none' as const },
	'& input[type="checkbox"]': { accentColor: colors.primary, flexShrink: 0 },
	'& .workspace-comment-anchor': {
		background: '#c4922330',
		boxShadow: 'inset 0 -1px #c4922380',
		cursor: 'pointer',
	},
	'& .workspace-comment-active': {
		background: '#c492234d',
		boxShadow: 'inset 0 -2px #c49223b0',
	},
	'& .workspace-comment-marker': {
		position: 'absolute',
		insetInlineEnd: -27,
		top: 3,
		width: 23,
		height: 22,
		display: 'grid',
		placeItems: 'center',
		border: `1px solid ${colors.border}`,
		borderRadius: '5px 5px 5px 1px',
		background: colors.surface,
		color: '#bd8b27',
		fontSize: 10,
		cursor: 'pointer',
		zIndex: 2,
		'&:hover': { background: '#c4922330' },
		'&:focus-visible': { outline: `2px solid ${colors.primary}` },
	},
	'& .ProseMirror-selectednode': {
		outline: `1px solid ${colors.primary}`,
		borderRadius: 4,
	},
	'@media (hover: none)': { '& .block-gutter': { opacity: 1 } },
	'@media (max-width:760px)': {
		paddingInlineStart: 28,
		'& .block-gutter': { insetInlineStart: -30, gap: 0 },
		'& .block-gutter button': { width: 15 },
	},
}
