/** @jsxImportSource @emotion/react */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import type {
	CommentAnchor,
	FilePresence,
	FileThread,
} from '#universal/file-collaboration.ts'
import { replaceCollaborativeText } from '#universal/collaborative-document.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import type { FileRoomClient } from './file-room-client.ts'
import { actorColor } from '#universal/collaboration-color.ts'
import { useHotkey } from '@tanstack/react-hotkeys'
import { CommentIcon } from './file-comments.tsx'
import { CommentSelectionToolbar } from './comment-selection-toolbar.tsx'

export function CollaborativeTextEditor({
	client,
	content,
	participants,
	readOnly,
	onComment,
	activeAnchor,
	threads,
	activeThreadId,
	onSelectThread,
}: {
	client: FileRoomClient
	content: string
	participants: FilePresence[]
	readOnly: boolean
	onComment?: (anchor: CommentAnchor) => void
	activeAnchor?: CommentAnchor
	threads: FileThread[]
	activeThreadId: string | null
	onSelectThread: (thread: FileThread) => void
}) {
	const input = useRef<HTMLTextAreaElement>(null),
		mirror = useRef<HTMLPreElement>(null)
	const [selectedAnchor, setSelectedAnchor] = useState<CommentAnchor | null>(
		null,
	)
	const [width, setWidth] = useState<number>()
	const [selectedRange, setSelectedRange] = useState<{
		from: number
		to: number
	} | null>(null)
	const [commentRect, setCommentRect] = useState<DOMRect | null>(null)
	function resolveTextRange(anchor?: CommentAnchor) {
		if (anchor?.kind !== 'text') return null
		try {
			const from = Y.createAbsolutePositionFromRelativePosition(
					Y.createRelativePositionFromJSON(JSON.parse(anchor.start)),
					client.doc,
				),
				to = Y.createAbsolutePositionFromRelativePosition(
					Y.createRelativePositionFromJSON(JSON.parse(anchor.end)),
					client.doc,
				)
			if (
				from &&
				to &&
				from.type === client.doc.getText('content') &&
				to.type === from.type
			)
				return {
					from: Math.min(from.index, to.index),
					to: Math.max(from.index, to.index),
				}
		} catch {
			// The discussion remains available in the rail if its anchor no longer resolves.
		}
		return null
	}
	const activeRange = resolveTextRange(activeAnchor)
	const threadAnchors = threads.flatMap((thread) => {
		if (thread.outdated || (thread.resolvedAt && thread.id !== activeThreadId))
			return []
		const range = resolveTextRange(thread.anchor)
		return range && range.from < range.to
			? [{ thread, offset: range.from }]
			: []
	})
	const [markers, setMarkers] = useState<Array<{ top: number; ids: string[] }>>(
		[],
	)
	const [scrollTop, setScrollTop] = useState(0)
	const anchorKey = JSON.stringify(
		threadAnchors.map(({ thread, offset }) => [thread.id, offset]),
	)
	useLayoutEffect(() => {
		const surface = mirror.current
		if (!surface) return
		const anchors: [string, number][] = JSON.parse(anchorKey)
		const measure = () => {
			const top = surface.getBoundingClientRect().top
			const lines = new Map<number, string[]>()
			for (const [id, offset] of anchors) {
				const node = surface.querySelector(`[data-text-start="${offset}"]`)
				const first = node?.getClientRects()[0]
				if (!first) continue
				const line = Math.round(first.top - top)
				const ids = lines.get(line)
				if (ids) ids.push(id)
				else lines.set(line, [id])
			}
			setMarkers(Array.from(lines, ([top, ids]) => ({ top, ids })))
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(surface)
		return () => observer.disconnect()
	}, [anchorKey, content, width])

	function commentSelection() {
		if (selectedAnchor) {
			onComment?.(selectedAnchor)
			setSelectedAnchor(null)
			setCommentRect(null)
		}
	}
	useHotkey('Mod+Alt+M', commentSelection, {
		target: input,
		ignoreInputs: false,
		enabled: !!onComment && !!selectedAnchor,
		meta: { name: 'Comment on selected text' },
	})
	useEffect(() => {
		if (!selectedRange || !selectedAnchor) {
			setCommentRect(null)
			return
		}
		const update = () => {
			const element = mirror.current?.querySelector(
				`[data-text-start="${selectedRange.to}"]`,
			)
			if (element) setCommentRect(element.getBoundingClientRect())
		}
		update()
		window.addEventListener('scroll', update, true)
		window.addEventListener('resize', update)
		return () => {
			window.removeEventListener('scroll', update, true)
			window.removeEventListener('resize', update)
		}
	}, [selectedRange, selectedAnchor, width])
	useEffect(() => {
		const element = input.current
		if (!element) return
		const observer = new ResizeObserver(() => setWidth(element.clientWidth))
		observer.observe(element)
		setWidth(element.clientWidth)
		return () => observer.disconnect()
	}, [])
	const ranges = participants
		.filter(
			(person) => person.sessionId !== client.sessionId && person.selection,
		)
		.flatMap((person) => {
			try {
				const start = Y.createAbsolutePositionFromRelativePosition(
					Y.createRelativePositionFromJSON(
						JSON.parse(person.selection!.anchor),
					),
					client.doc,
				)
				const end = Y.createAbsolutePositionFromRelativePosition(
					Y.createRelativePositionFromJSON(JSON.parse(person.selection!.head)),
					client.doc,
				)
				if (
					!start ||
					!end ||
					start.type !== client.doc.getText('content') ||
					end.type !== start.type
				)
					return []
				return [
					{
						from: Math.min(start.index, end.index),
						to: Math.max(start.index, end.index),
						head: end.index,
						person,
					},
				]
			} catch {
				return []
			}
		})
		.slice(0, 12)
	const boundaries = [
		...new Set([
			0,
			content.length,
			...threadAnchors.map(({ offset }) => offset),
			...(selectedRange ? [selectedRange.from, selectedRange.to] : []),
			...(activeRange ? [activeRange.from, activeRange.to] : []),
			...ranges.flatMap((range) => [range.from, range.to, range.head]),
		]),
	].sort((a, b) => a - b)
	const textStyle = {
		fontFamily: typography.fontFamilyMono,
		fontSize: typography.fontSize.sm,
		lineHeight: 1.65,
		letterSpacing: 'normal',
		tabSize: 4,
		padding: '12px 16px',
		paddingInlineEnd: threadAnchors.length ? 40 : 16,
		margin: 0,
		border: 0,
		whiteSpace: 'pre-wrap' as const,
		overflowWrap: 'break-word' as const,
		boxSizing: 'border-box' as const,
	}
	function selection() {
		const element = input.current
		const snapshot = client.getSnapshot().snapshot
		if (!element || !snapshot) return
		const text = client.doc.getText('content')
		setSelectedRange(
			element.selectionStart !== element.selectionEnd
				? { from: element.selectionStart, to: element.selectionEnd }
				: null,
		)
		const start = Y.createRelativePositionFromTypeIndex(
				text,
				element.selectionStart,
			),
			end = Y.createRelativePositionFromTypeIndex(text, element.selectionEnd)
		setSelectedAnchor(
			document.activeElement === element &&
				element.selectionStart !== element.selectionEnd
				? {
						kind: 'text',
						start: JSON.stringify(start),
						end: JSON.stringify(end),
						quote: text
							.toString()
							.slice(element.selectionStart, element.selectionEnd)
							.slice(0, 2000),
						revisionId: snapshot.revisionId,
					}
				: null,
		)
		client.awareness.setLocalStateField('cursor', {
			anchor: Y.createRelativePositionFromTypeIndex(
				text,
				element.selectionStart,
			),
			head: Y.createRelativePositionFromTypeIndex(text, element.selectionEnd),
		})
	}
	return (
		<div
			css={{
				position: 'relative',
				minWidth: 0,
				width: '100%',
				overflow: 'hidden',
			}}
		>
			{selectedAnchor && commentRect && onComment && (
				<CommentSelectionToolbar
					rect={commentRect}
					onComment={commentSelection}
				/>
			)}
			<pre
				aria-hidden="true"
				ref={mirror}
				css={{
					...textStyle,
					position: 'absolute',
					inset: '28px 0 0',
					width: width ?? '100%',
					pointerEvents: 'none',
					color: 'transparent',
					overflow: 'visible',
				}}
			>
				{boundaries.map((position, index) => (
					<span key={position}>
						{ranges
							.filter((range) => range.head === position)
							.map((range) => (
								<span
									key={range.person.sessionId}
									data-presence-session={range.person.sessionId}
									css={{
										position: 'relative',
										borderLeft: `2px solid ${actorColor(range.person.actor.id)}`,
										marginInlineStart: -2,
									}}
								>
									<span
										css={{
											position: 'absolute',
											bottom: '100%',
											insetInlineStart: 0,
											color: 'white',
											background: actorColor(range.person.actor.id),
											font: '10px system-ui',
											padding: '1px 4px',
											borderRadius: '3px 3px 3px 0',
											whiteSpace: 'nowrap',
										}}
									>
										{range.person.actor.name}
									</span>
								</span>
							))}
						<span
							data-text-start={position}
							css={{
								background:
									activeRange &&
									activeRange.from <= position &&
									activeRange.to > position
										? '#c492234d'
										: ranges.some(
													(range) =>
														range.from <= position && range.to > position,
											  )
											? `${actorColor(ranges.find((range) => range.from <= position && range.to > position)!.person.actor.id)}30`
											: undefined,
							}}
						>
							{content.slice(position, boundaries[index + 1] ?? position)}
						</span>
					</span>
				))}
				{'\u200b'}
			</pre>
			{markers.map(({ top, ids }) => {
				const active = ids.indexOf(activeThreadId ?? '')
				return (
					<button
						key={ids[0]}
						type="button"
						aria-label={
							ids.length === 1
								? 'Open comment on this line'
								: `Open ${ids.length} comments on this line`
						}
						aria-pressed={active >= 0}
						onClick={() => {
							const thread = threads.find(
								(item) => item.id === ids[(active + 1) % ids.length],
							)
							if (thread) onSelectThread(thread)
						}}
						css={{
							position: 'absolute',
							top: 28 + top - scrollTop,
							insetInlineEnd: 8,
							zIndex: 2,
							display: 'inline-flex',
							alignItems: 'center',
							gap: 3,
							minHeight: 19,
							padding: '0 4px',
							border: `1px solid ${colors.border}`,
							borderRadius: 5,
							background: active >= 0 ? colors.primarySoft : colors.surface,
							color: active >= 0 ? colors.primary : colors.textMuted,
							fontSize: 10,
							cursor: 'pointer',
							'&:hover': { background: colors.primarySoft },
						}}
					>
						<CommentIcon />
						{ids.length > 1 ? ids.length : null}
					</button>
				)
			})}
			<textarea
				ref={input}
				aria-label="Document text"
				readOnly={readOnly}
				spellCheck={false}
				value={content}
				onChange={(event) => {
					client.doc.transact(() =>
						replaceCollaborativeText(
							client.doc.getText('content'),
							event.target.value,
						),
					)
					selection()
				}}
				onSelect={selection}
				onBlur={() => {
					client.awareness.setLocalStateField('cursor', null)
					setSelectedAnchor(null)
					setCommentRect(null)
				}}
				onScroll={(event) => {
					setScrollTop(event.currentTarget.scrollTop)
					if (mirror.current)
						mirror.current.style.transform = `translate(${-event.currentTarget.scrollLeft}px,${-event.currentTarget.scrollTop}px)`
				}}
				css={{
					...textStyle,
					display: 'block',
					position: 'relative',
					zIndex: 1,
					width: '100%',
					minHeight: '60vh',
					marginTop: 28,
					resize: 'vertical',
					background: 'transparent',
					color: colors.text,
					outline: 'none',
				}}
			/>
		</div>
	)
}
