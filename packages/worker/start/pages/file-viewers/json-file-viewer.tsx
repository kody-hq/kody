/** @jsxImportSource @emotion/react */
import { FileAnchorContext } from '../file-anchor-context.ts'
import { FileAnchorMarker } from '../file-anchor-markers.tsx'
import { WorkspaceFileStatus } from '../workspace-file-status.tsx'
import {
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import type {
	JsonLine,
	JsonNode,
	JsonRequest,
	JsonResponse,
} from '#universal/json-preview.ts'
import { colors } from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import { LoadingIndicator } from '../../components/loading-indicator.tsx'
const control = {
	...getGhostButtonCss(),
	padding: '4px 8px',
	minHeight: 28,
	fontSize: 12,
	borderRadius: 4,
	boxShadow: 'none',
	'&[aria-pressed=true]': {
		background: colors.primarySoft,
		color: colors.text,
		fontWeight: 600,
	},
	'@media (pointer: coarse)': { minHeight: 36 },
} as const
const syntax = {
	key: 'light-dark(#7b2480, #d9a5e8)',
	string: 'light-dark(#176a44, #91cfa6)',
	number: 'light-dark(#155e9c, #89bafa)',
	literal: 'light-dark(#9c3b1b, #f0aa82)',
	plain: colors.text,
}
type Row = { node: JsonNode; depth: number; parent?: string; more?: boolean }
export default function JsonFileViewer({
	src,
	download,
	inline = false,
	content,
}: {
	src: string
	download: string
	inline?: boolean
	content?: string
}) {
	const comments = useContext(FileAnchorContext)
	const selected = comments?.threads.find(
		(thread) => thread.id === comments.activeId && !thread.outdated,
	)
	const pointer =
		selected?.anchor.kind === 'json' ? selected.anchor.pointer : undefined
	const revealed = useRef<string | undefined>(undefined)

	const [mode, setMode] = useState<'raw' | 'tree'>('tree')
	const [lines, setLines] = useState<JsonLine[] | null>(null),
		[root, setRoot] = useState<JsonNode>()
	const [error, setError] = useState(''),
		[invalid, setInvalid] = useState('')
	const [children, setChildren] = useState(new Map<string, JsonNode[]>())
	const [expanded, setExpanded] = useState(new Set<string>(['']))
	const [pending, setPending] = useState(new Set<string>())
	const worker = useRef<Worker>(null),
		scroll = useRef<HTMLDivElement>(null)
	const [focused, setFocused] = useState('')
	const focusAfter = useRef(false)
	const revealLoads = useRef(new Set<string>())
	const revealAfter = useRef<string | undefined>(undefined)
	function request(message: JsonRequest) {
		worker.current?.postMessage(message)
	}
	function load(id: string, offset = 0, reveal = false) {
		if (reveal) revealLoads.current.add(id)
		setPending((current) => new Set(current).add(id))
		request({ type: 'children', id, offset })
	}
	useEffect(() => {
		const instance = new Worker(
			new URL('./json-preview.worker.ts', import.meta.url),
			{ type: 'module' },
		)
		worker.current = instance
		revealLoads.current.clear()
		revealed.current = undefined
		revealAfter.current = undefined
		setLines(null)
		setRoot(undefined)
		setError('')
		setInvalid('')
		setChildren(new Map())
		setExpanded(new Set(['']))
		setPending(new Set())
		setFocused('')
		instance.onmessage = (event: MessageEvent<JsonResponse>) => {
			const result = event.data
			if (result.type === 'error') {
				setError(result.message)
				setPending(new Set())
			} else if (result.type === 'ready') {
				setLines(result.lines)
				setRoot(result.root)
				setInvalid(result.invalid ?? '')
				if (result.root?.count) {
					setPending(new Set(['']))
					instance.postMessage({
						type: 'children',
						id: '',
						offset: 0,
					} satisfies JsonRequest)
				}
				if (result.invalid) setMode('raw')
			} else {
				const revealing = revealLoads.current.delete(result.id)
				if (!revealing && result.offset && result.children[0]) {
					focusAfter.current = true
					setFocused(result.children[0].id)
				}
				setChildren((current) =>
					new Map(current).set(
						result.id,
						result.offset
							? [...(current.get(result.id) ?? []), ...result.children]
							: result.children,
					),
				)
				setPending((current) => {
					const next = new Set(current)
					next.delete(result.id)
					return next
				})
			}
		}
		instance.onerror = () => setError('Could not start the JSON viewer.')
		instance.postMessage({
			type: 'load',
			content,
			src: new URL(src, location.href).href,
		} satisfies JsonRequest)
		return () => {
			instance.terminate()
			worker.current = null
		}
	}, [src, content])
	const rows = useMemo(() => {
		const result: Row[] = []
		function visit(node: JsonNode, depth: number, parent?: string) {
			result.push({ node, depth, parent })
			if (!expanded.has(node.id)) return
			const loaded = children.get(node.id) ?? []
			for (const child of loaded) visit(child, depth + 1, node.id)
			if (loaded.length < node.count && !pending.has(node.id))
				result.push({ node, depth: depth + 1, parent: node.id, more: true })
		}
		if (root) visit(root, 0)
		return result
	}, [root, children, expanded, pending])
	const focusedIndex = rows.findIndex(
		(row) => !row.more && row.node.id === focused,
	)
	const virtual = useVirtualizer({
		count: mode === 'raw' ? (lines?.length ?? 0) : rows.length,
		getScrollElement: () => scroll.current,
		estimateSize: () => 26,
		overscan: 8,
		getItemKey: (index) =>
			mode === 'raw'
				? index
				: `${rows[index]!.more ? 'more' : 'node'}:${rows[index]!.node.id}`,
		rangeExtractor: (range) =>
			[
				...new Set([
					...defaultRangeExtractor(range),
					...(mode === 'tree' && focusedIndex >= 0 ? [focusedIndex] : []),
				]),
			].sort((a, b) => a - b),
	})
	useLayoutEffect(() => {
		if (!focusAfter.current) return
		if (focusedIndex >= 0)
			virtual.scrollToIndex(focusedIndex, { align: 'auto' })
		const target = scroll.current?.querySelector<HTMLElement>(
			`[data-json-path="${CSS.escape(focused)}"]`,
		)
		if (target) {
			focusAfter.current = false
			target.focus({ preventScroll: true })
		}
	})
	useLayoutEffect(() => {
		if (revealAfter.current === undefined) return
		const index = rows.findIndex(
			(row) => !row.more && row.node.id === revealAfter.current,
		)
		if (index < 0) return
		revealAfter.current = undefined
		virtual.scrollToIndex(index, { align: 'center' })
	})

	function toggle(node: JsonNode) {
		if (!node.count) return
		setExpanded((current) => {
			const next = new Set(current)
			if (next.has(node.id)) next.delete(node.id)
			else next.add(node.id)
			return next
		})
		if (!children.has(node.id) && !pending.has(node.id)) load(node.id)
	}
	function focus(index: number) {
		const row = rows[index]
		if (!row || row.more) return
		focusAfter.current = true
		setFocused(row.node.id)
		virtual.scrollToIndex(index, { align: 'auto' })
	}
	useEffect(() => {
		if (pointer === undefined || !selected) {
			revealed.current = undefined
			return
		}
		if (!root || revealed.current === selected.id) return
		setMode('tree')
		const segments = pointer.split('/').slice(1)
		let parent = root
		const ancestors: string[] = []
		for (const segment of segments) {
			ancestors.push(parent.id)
			const loaded = children.get(parent.id) ?? []
			const child = loaded.find((node) => node.id === `${parent.id}/${segment}`)
			if (!child) {
				if (loaded.length < parent.count && !pending.has(parent.id))
					load(parent.id, loaded.length, true)
				return
			}
			parent = child
		}
		setExpanded((current) => new Set([...current, ...ancestors]))
		setFocused(pointer)
		const index = rows.findIndex((row) => !row.more && row.node.id === pointer)
		if (index >= 0) virtual.scrollToIndex(index, { align: 'center' })
		else revealAfter.current = pointer
		revealed.current = selected.id
	}, [pointer, selected?.id, root, children, pending])

	if (error)
		return (
			<WorkspaceFileStatus
				message={error}
				action={{ label: 'Download JSON', href: download }}
			/>
		)
	if (!lines) return <LoadingIndicator label="Loading JSON" />
	return (
		<section
			aria-label="JSON viewer"
			css={{
				display: 'flex',
				flexDirection: 'column',
				flex: 1,
				minWidth: 0,
				minHeight: inline ? 280 : 0,
				height: inline ? 420 : undefined,
				overflow: 'hidden',
				background: colors.background,
			}}
		>
			<div
				css={{
					display: 'flex',
					alignItems: 'center',
					gap: 4,
					flexWrap: 'wrap',
					flexShrink: 0,
					padding: '5px 12px',
					borderBottom: `1px solid ${colors.borderSubtle}`,
				}}
			>
				{(['tree', 'raw'] as const).map((value) => (
					<button
						key={value}
						css={control}
						aria-pressed={mode === value}
						disabled={value === 'tree' && !!invalid}
						onClick={() => {
							setMode(value)
							scroll.current?.scrollTo({ top: 0, left: 0 })
						}}
					>
						{value === 'tree' ? 'Tree' : 'Raw'}
					</button>
				))}
				<span css={{ flex: 1 }} />
				<a
					css={{ ...control, textDecoration: 'none' }}
					href={download}
					download
				>
					Download
				</a>
			</div>
			{invalid && (
				<p
					role="alert"
					css={{
						fontSize: 12,
						margin: '8px 12px',
						padding: '8px 10px',
						border: `1px solid ${colors.border}`,
						borderRadius: 6,
						color: colors.danger,
						overflowWrap: 'anywhere',
					}}
				>
					Invalid JSON: {invalid}
				</p>
			)}
			<div
				ref={scroll}
				role={mode === 'tree' ? 'tree' : 'region'}
				aria-label={mode === 'tree' ? 'JSON tree' : 'JSON source'}
				tabIndex={mode === 'raw' ? 0 : undefined}
				css={{
					flex: 1,
					minHeight: 0,
					overflow: 'auto',
					fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
					fontSize: 12,
					lineHeight: '26px',
				}}
			>
				<div
					css={{
						height: virtual.getTotalSize(),
						position: 'relative',
						minWidth: '100%',
						width: 'max-content',
					}}
				>
					{virtual.getVirtualItems().map((item) => {
						if (mode === 'raw') {
							const line = lines[item.index]!
							return (
								<div
									key={item.key}
									data-json-line={item.index}
									css={{
										position: 'absolute',
										top: 0,
										transform: `translateY(${item.start}px)`,
										height: 26,
										whiteSpace: 'pre',
										paddingRight: 16,
									}}
								>
									<span
										aria-hidden
										css={{
											display: 'inline-block',
											width: 56,
											textAlign: 'right',
											paddingRight: 16,
											color: colors.textMuted,
											userSelect: 'none',
										}}
									>
										{line.continuation ? '↳' : line.number}
									</span>
									<code>
										{line.tokens.map((token, index) => (
											<span key={index} style={{ color: syntax[token.kind] }}>
												{token.text}
											</span>
										))}
									</code>
								</div>
							)
						}
						const { node, depth, parent, more } = rows[item.index]!
						if (more)
							return (
								<button
									key={item.key}
									css={{
										...control,
										position: 'absolute',
										top: item.start,
										left: depth * 18 + 12,
									}}
									onClick={() =>
										load(node.id, children.get(node.id)?.length ?? 0)
									}
								>
									Load next{' '}
									{Math.min(
										500,
										node.count - (children.get(node.id)?.length ?? 0),
									)}
								</button>
							)
						const open = expanded.has(node.id)
						return (
							<div
								key={item.key}
								data-json-path={node.id}
								role="treeitem"
								aria-level={depth + 1}
								aria-expanded={node.count ? open : undefined}
								aria-selected={focused === node.id}
								tabIndex={focused === node.id ? 0 : -1}
								onFocus={() => setFocused(node.id)}
								onClick={() => {
									setFocused(node.id)
									toggle(node)
								}}
								onKeyDown={(event) => {
									if (
										event.altKey ||
										event.metaKey ||
										event.ctrlKey ||
										event.shiftKey
									)
										return
									if (
										![
											'ArrowUp',
											'ArrowDown',
											'ArrowLeft',
											'ArrowRight',
											'Home',
											'End',
											'Enter',
											' ',
										].includes(event.key)
									)
										return
									event.preventDefault()
									event.stopPropagation()
									if (event.key === 'Enter' || event.key === ' ') toggle(node)
									else if (event.key === 'ArrowRight') {
										if (!open) toggle(node)
										else if (rows[item.index + 1]?.parent === node.id)
											focus(item.index + 1)
									} else if (event.key === 'ArrowLeft') {
										if (open && node.count) toggle(node)
										else if (parent !== undefined)
											focus(
												rows.findIndex(
													(row) => !row.more && row.node.id === parent,
												),
											)
									} else {
										let index =
											event.key === 'Home'
												? 0
												: event.key === 'End'
													? rows.length - 1
													: item.index + (event.key === 'ArrowDown' ? 1 : -1)
										while (rows[index]?.more)
											index +=
												event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1
										focus(index)
									}
								}}
								css={{
									position: 'absolute',
									top: 0,
									transform: `translateY(${item.start}px)`,
									height: 26,
									paddingLeft: 12 + depth * 18,
									paddingRight: 16,
									minWidth: '100%',
									boxSizing: 'border-box',
									whiteSpace: 'pre',
									outline: 'none',
									cursor: node.count ? 'pointer' : 'default',
									'&:focus-visible': { background: colors.primarySoft },
									'&:hover': { background: colors.borderSubtle },
								}}
							>
								<span
									aria-hidden
									css={{
										display: 'inline-block',
										width: 18,
										color: colors.textMuted,
									}}
								>
									{node.count ? (open ? '⌄' : '›') : ''}
								</span>
								<span css={{ color: syntax.key }}>{node.name}</span>
								<span>: </span>
								{node.kind === 'object' || node.kind === 'array' ? (
									<span css={{ color: colors.textMuted }}>
										{node.kind === 'array'
											? `[${node.count}]`
											: `{${node.count}}`}
									</span>
								) : (
									<span
										style={{
											color:
												node.kind === 'string'
													? syntax.string
													: node.kind === 'number'
														? syntax.number
														: syntax.literal,
										}}
									>
										{node.preview}
									</span>
								)}
								<FileAnchorMarker
									label="Open JSON property comment"
									matches={(anchor) =>
										anchor.kind === 'json' && anchor.pointer === node.id
									}
								/>
							</div>
						)
					})}
				</div>
			</div>
			{pending.size > 0 && (
				<LoadingIndicator inline label="Loading JSON values" />
			)}
		</section>
	)
}
