/** @jsxImportSource @emotion/react */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'

/** Window rows while retaining the focused item, including across resize. */
export function VirtualCollection({
	keys,
	renderItem,
	grid = false,
	rowHeight = 32,
	label,
	activeKey,
	itemWidth = 130,
}: {
	keys: string[]
	activeKey?: string
	itemWidth?: number
	renderItem: (index: number) => ReactNode
	grid?: boolean
	rowHeight?: number
	label?: string
}) {
	const root = useRef<HTMLDivElement>(null)
	const [columns, setColumns] = useState(1)
	const [focused, setFocused] = useState<string | null>(activeKey ?? null)
	const focusTarget = useRef<string | null>(activeKey ?? null)
	const pending = useRef<string | null>(null)
	useLayoutEffect(() => {
		if (!grid || !root.current) return
		const observer = new ResizeObserver(([entry]) => {
			const item = (
				document.activeElement as Element | null
			)?.closest<HTMLElement>('[data-browser-item]')
			if (!pending.current && item && root.current?.contains(item))
				pending.current = focusTarget.current
			setColumns(
				Math.max(
					1,
					Math.floor(
						((entry?.contentRect.width ?? itemWidth) + 12) / (itemWidth + 12),
					),
				),
			)
		})
		observer.observe(root.current)
		return () => observer.disconnect()
	}, [grid, itemWidth])
	const focusedIndex = focused ? keys.indexOf(focused) : -1
	const virtual = useVirtualizer({
		count: Math.ceil(keys.length / columns),
		getScrollElement: () => root.current,
		estimateSize: () => rowHeight,
		getItemKey: (index) => keys[index * columns]!,
		overscan: 5,
		initialRect: { width: 800, height: 600 },
		rangeExtractor: (range) => {
			const indexes = defaultRangeExtractor(range)
			if (focusedIndex >= 0) indexes.push(Math.floor(focusedIndex / columns))
			return [...new Set(indexes)].sort((a, b) => a - b)
		},
	})
	useLayoutEffect(() => {
		virtual.measure()
	}, [rowHeight, virtual])

	useLayoutEffect(() => {
		if (activeKey && keys.includes(activeKey)) {
			focusTarget.current = activeKey
			setFocused(activeKey)
			virtual.scrollToIndex(Math.floor(keys.indexOf(activeKey) / columns), {
				align: 'auto',
			})
		} else if (pending.current) {
			const index = keys.indexOf(pending.current)
			if (index >= 0)
				virtual.scrollToIndex(Math.floor(index / columns), { align: 'auto' })
		}
	}, [activeKey, columns])

	function focusIndex(index: number) {
		const id = keys[index]!
		focusTarget.current = id
		pending.current = id
		setFocused(id)
		virtual.scrollToIndex(Math.floor(index / columns), { align: 'auto' })
		const element = root.current?.querySelector<HTMLElement>(
			`[data-browser-item="${CSS.escape(id)}"]`,
		)
		if (element) {
			pending.current = null
			element.focus({ preventScroll: true })
		}
	}

	useLayoutEffect(() => {
		if (!pending.current) return
		const element = root.current?.querySelector<HTMLElement>(
			`[data-browser-item="${CSS.escape(pending.current)}"]`,
		)
		if (element) {
			pending.current = null
			element.focus({ preventScroll: true })
		}
	})
	useLayoutEffect(() => {
		const parent = root.current?.parentElement
		if (parent?.tagName !== 'NAV') return
		const handle = (event: KeyboardEvent) => {
			if (
				event.target !== parent ||
				!keys.length ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				!['ArrowDown', 'ArrowUp', 'ArrowRight', 'Home', 'End'].includes(
					event.key,
				)
			)
				return
			event.preventDefault()
			event.stopPropagation()
			const index =
				event.key === 'End' || event.key === 'ArrowUp' ? keys.length - 1 : 0
			focusIndex(index)
		}
		parent.addEventListener('keydown', handle, true)
		return () => parent.removeEventListener('keydown', handle, true)
	}, [keys, columns, virtual])

	return (
		<div
			ref={root}
			aria-label={label}
			data-virtual-collection
			css={{
				minHeight: 0,
				minWidth: 0,
				flex: 1,
				height: '100%',
				overflow: 'auto',
			}}
			onFocusCapture={(event) => {
				const item = (event.target as Element).closest<HTMLElement>(
					'[data-browser-item]',
				)
				if (item) {
					focusTarget.current = item.dataset.browserItem ?? null
					setFocused(focusTarget.current)
				}
			}}
			onKeyDownCapture={(event) => {
				if (
					event.altKey ||
					event.ctrlKey ||
					event.metaKey ||
					event.shiftKey ||
					(event.target as Element).closest(
						'input,textarea,select,[contenteditable=true]',
					)
				)
					return
				const item = (event.target as Element).closest<HTMLElement>(
					'[data-browser-item]',
				)
				if (!item) return
				const index = keys.indexOf(item.dataset.browserItem ?? '')
				if (index < 0) return
				const step =
					event.key === 'ArrowDown'
						? columns
						: event.key === 'ArrowUp'
							? -columns
							: grid && event.key === 'ArrowRight'
								? 1
								: grid && event.key === 'ArrowLeft'
									? -1
									: 0
				if (!step && event.key !== 'Home' && event.key !== 'End') return
				event.preventDefault()
				event.stopPropagation()
				const next =
					event.key === 'Home'
						? 0
						: event.key === 'End'
							? keys.length - 1
							: Math.max(0, Math.min(keys.length - 1, index + step))
				focusIndex(next)
			}}
		>
			<div
				css={{
					position: 'relative',
					height: virtual.getTotalSize(),
					width: '100%',
				}}
			>
				{virtual.getVirtualItems().flatMap((row) =>
					Array.from(
						{ length: Math.min(columns, keys.length - row.index * columns) },
						(_, lane) => {
							const index = row.index * columns + lane
							return (
								<div
									key={keys[index]}
									css={{
										position: 'absolute',
										top: 0,
										left: `calc(${(lane * 100) / columns}% + ${((grid ? 12 : 0) * lane) / columns}px)`,
										width: `calc((100% - ${(grid ? 12 : 0) * (columns - 1)}px) / ${columns})`,
										minWidth: 0,
										height: rowHeight,
										transform: `translateY(${row.start}px)`,
									}}
								>
									{renderItem(index)}
								</div>
							)
						},
					),
				)}
			</div>
		</div>
	)
}
