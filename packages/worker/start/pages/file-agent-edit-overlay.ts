import { actorColor } from '#universal/collaboration-color.ts'
import type { FileRoomClient } from './file-room-client.ts'
import {
	agentHighlightMs,
	agentSelectionMs,
	type AgentEdit,
	type AgentEditRange,
} from './file-agent-edit-ranges.ts'

export function editRangeRects(
	start: { node: Node; offset: number },
	end: { node: Node; offset: number },
) {
	const range = document.createRange()
	range.setStart(start.node, start.offset)
	range.setEnd(end.node, end.offset)
	return Array.from(range.getClientRects(), (rect) =>
		range.collapsed ? new DOMRect(rect.left, rect.top, 0, rect.height) : rect,
	)
}

export function mountAgentEditOverlay(
	client: FileRoomClient,
	surface: HTMLElement,
	viewport: HTMLElement,
	layer: HTMLElement,
	resolve: (range: AgentEditRange) => DOMRect[],
) {
	const highlights = new Map<AgentEdit, number>()
	const selection = document.createElement('div')
	const marks = document.createElement('div')
	layer.append(marks, selection)
	let frame = 0
	let expiry: ReturnType<typeof setTimeout> | undefined

	function visibleRects(ranges: AgentEditRange[]) {
		const bounds = viewport.getBoundingClientRect()
		const rects = new Map<
			string,
			{ left: number; right: number; top: number; bottom: number }
		>()
		for (const range of ranges) {
			for (const rect of resolve(range)) {
				const left = Math.max(0, bounds.left, rect.left)
				const right = Math.min(window.innerWidth, bounds.right, rect.right)
				const top = Math.max(0, bounds.top, rect.top)
				const bottom = Math.min(window.innerHeight, bounds.bottom, rect.bottom)
				if (right >= left && bottom > top)
					rects.set(`${left}:${right}:${top}:${bottom}`, {
						left,
						right,
						top,
						bottom,
					})
			}
		}
		return [...rects.values()]
	}

	function paint() {
		frame = 0
		marks.replaceChildren()
		clearTimeout(expiry)
		const now = performance.now()
		const origin = layer.getBoundingClientRect()
		let next = Infinity
		for (const [edit, start] of highlights) {
			const remaining = agentHighlightMs - (now - start)
			if (remaining <= 0) {
				highlights.delete(edit)
				continue
			}
			next = Math.min(next, remaining)
			const color = actorColor(edit.agent.id)
			for (const rect of visibleRects(edit.after)) {
				const removed = rect.left === rect.right
				const mark = rectangle(rect, color, origin)
				const opacity = removed ? 0.65 : 0.35
				mark.dataset.agentEditHighlight = edit.agent.id
				marks.append(mark)
				mark.animate(
					[
						{ opacity: (opacity * remaining) / agentHighlightMs },
						{ opacity: 0 },
					],
					{ duration: remaining, fill: 'both' },
				)
			}
		}
		if (Number.isFinite(next)) expiry = setTimeout(paint, next)
	}

	function rectangle(
		rect: { left: number; right: number; top: number; bottom: number },
		color: string,
		origin: DOMRect,
	) {
		const mark = document.createElement('div')
		Object.assign(mark.style, {
			position: 'absolute',
			left: `${rect.left - origin.left}px`,
			top: `${rect.top - origin.top}px`,
			width: `${rect.right - rect.left || 3}px`,
			height: `${rect.bottom - rect.top}px`,
			background: color,
			borderRadius: '2px',
		})
		return mark
	}

	function repaint() {
		if (highlights.size && !frame) frame = requestAnimationFrame(paint)
	}
	function reposition() {
		selection.replaceChildren()
		repaint()
	}
	const unsubscribe = client.subscribeToAgentEdits((edit, phase) => {
		selection.replaceChildren()
		if (phase === 'after') {
			if (edit.after.length) {
				highlights.set(edit, performance.now())
				repaint()
			}
			return false
		}
		const rects = visibleRects(edit.before)
		if (!rects.length) return false
		const color = actorColor(edit.agent.id)
		const origin = layer.getBoundingClientRect()
		const dragMs = agentSelectionMs - 90
		rects.forEach((rect, index) => {
			if (rect.left === rect.right) return
			const mark = rectangle(rect, color, origin)
			mark.style.opacity = '0.38'
			selection.append(mark)
			mark.animate(
				[{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
				{
					duration: dragMs / rects.length,
					delay: (dragMs * index) / rects.length,
					fill: 'both',
				},
			)
		})
		const first = rects[0]!
		const cursor = rectangle({ ...first, right: first.left + 2 }, color, origin)
		cursor.dataset.agentEditCursor = edit.agent.id
		const label = document.createElement('span')
		label.textContent = edit.agent.name
		Object.assign(label.style, {
			position: 'absolute',
			bottom: '100%',
			left: '0',
			padding: '2px 5px',
			background: color,
			color: 'white',
			borderRadius: '4px 4px 4px 0',
			whiteSpace: 'nowrap',
			font: '11px system-ui',
		})
		cursor.append(label)
		selection.append(cursor)
		cursor.animate(
			rects.flatMap((rect, index) => [
				{
					offset: index / rects.length,
					transform: `translate(${rect.left - first.left}px, ${rect.top - first.top}px)`,
				},
				{
					offset: (index + 1) / rects.length,
					transform: `translate(${rect.right - first.left}px, ${rect.top - first.top}px)`,
				},
			]),
			{ duration: dragMs, fill: 'both' },
		)
		return true
	})
	const mutation = new MutationObserver(repaint)
	mutation.observe(surface, {
		subtree: true,
		childList: true,
		characterData: true,
		attributes: true,
	})
	const resize = new ResizeObserver(repaint)
	resize.observe(viewport)
	window.addEventListener('scroll', reposition, true)
	window.addEventListener('resize', reposition)
	return () => {
		unsubscribe()
		mutation.disconnect()
		resize.disconnect()
		window.removeEventListener('scroll', reposition, true)
		window.removeEventListener('resize', reposition)
		cancelAnimationFrame(frame)
		clearTimeout(expiry)
		layer.replaceChildren()
	}
}

export const agentEditLayerStyle = {
	position: 'absolute',
	inset: 0,
	pointerEvents: 'none',
	zIndex: 2,
} as const
