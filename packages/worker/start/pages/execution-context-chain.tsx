/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useRefreshExecutionContextsPage } from '../execution-contexts-query.ts'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { setExecutionChain } from '#start/server/execution-contexts'
import {
	type ExecutionChain,
	type ExecutionChainEntry,
	type ExecutionContextListItem,
	addableContexts,
	chainEntryInputs,
	chainHasCloud,
	chainIsFull,
	chainWarning,
	contextDisplayStatus,
	displayStatusLabel,
	maxChainContexts,
	moveChainContext,
	normalizeChain,
	removeChainContext,
	skippedLabel,
	unusableReasonCopy,
} from '#universal/execution-contexts.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
import { formatTimestamp } from '../components/local-timestamp.tsx'
import { AccountManagementMessage } from './account-management-components.tsx'
import { selectCss } from './package-collaborators-parts.tsx'

const saveDelayMs = 600

const listCss = css({
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
})
const rowCss = css({
	display: 'grid',
	gridTemplateColumns: 'auto auto minmax(0, 1fr) auto',
	alignItems: 'center',
	gap: spacing.sm,
	padding: spacing.sm,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	background: colors.surface,
	'@container (max-width: 520px)': {
		gridTemplateColumns: 'auto auto minmax(0, 1fr)',
	},
})
const grabbedRowCss = css({
	outline: `2px solid ${colors.primary}`,
	outlineOffset: 2,
})
const targetCss = css({ minWidth: 44, minHeight: 44 })
const handleCss = css(targetCss, {
	cursor: 'grab',
	border: `1px dashed ${colors.border}`,
	borderRadius: radius.sm,
	background: 'transparent',
	color: colors.textMuted,
})
const mutedCss = css({ color: colors.textMuted, fontSize: '0.9rem', margin: 0 })
const actionsCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.xs,
	justifyContent: 'end',
	'@container (max-width: 520px)': {
		gridColumn: '1 / -1',
		justifyContent: 'start',
	},
})

type ChainFailure = {
	ok: false
	error: string
	message: string
	current?: ExecutionChain
	contextId?: string
}

export function ExecutionChainPanel(props: {
	orgSlug: string
	chain: ExecutionChain
	contexts: ReadonlyArray<ExecutionContextListItem>
}) {
	const refresh = useRefreshExecutionContextsPage()
	const [chain, setChain] = useState(props.chain)
	const committed = useRef(props.chain)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const [notice, setNotice] = useState<{
		tone?: 'error'
		text: string
		retry?: ExecutionChain
	} | null>(null)
	const [announcement, setAnnouncement] = useState('')
	const [grabbed, setGrabbed] = useState<{
		id: string
		snapshot: ExecutionChain
	} | null>(null)
	const [dragId, setDragId] = useState<string | null>(null)
	const [confirmStrict, setConfirmStrict] = useState(false)
	const [addId, setAddId] = useState('')
	const listRef = useRef<HTMLOListElement | null>(null)
	const focusAfterMove = useRef<string | null>(null)

	useEffect(() => {
		const target = focusAfterMove.current
		if (!target || !listRef.current) return
		focusAfterMove.current = null
		const [id, control] = target.split('|')
		const find = (name: string) =>
			listRef.current?.querySelector<HTMLButtonElement>(
				`[data-chain-focus="${CSS.escape(`${id}|${name}`)}"]:not(:disabled)`,
			)
		const other = control === 'up' ? 'down' : 'up'
		;(find(control ?? 'handle') ?? find(other) ?? find('handle'))?.focus()
	})

	useEffect(() => {
		if (timer.current) return
		committed.current = props.chain
		setChain(props.chain)
	}, [props.chain])
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current)
		},
		[],
	)

	const byId = new Map(props.contexts.map((context) => [context.id, context]))
	const nameFor = (id: string) => byId.get(id)?.name ?? id
	const entries = normalizeChain(chain.entries)
	const contextEntries = entries.filter(
		(entry): entry is Extract<ExecutionChainEntry, { kind: 'context' }> =>
			entry.kind === 'context',
	)
	const hasCloud = chainHasCloud(entries)
	const full = chainIsFull(entries)
	const addable = addableContexts(props.contexts, chain)
	const warning = chainWarning({ chain, contextsById: byId })

	async function save(next: ExecutionChain, retried = false): Promise<void> {
		const result = (await setExecutionChain({
			data: {
				orgSlug: props.orgSlug,
				entries: chainEntryInputs(next.entries),
				strict: !chainHasCloud(next.entries),
				ifMatch: committed.current.updatedAt ?? null,
			},
		}).catch((): ChainFailure => ({
			ok: false,
			error: 'unexpected',
			message: 'Could not save your chain. Try again.',
		}))) as { ok: true; chain: ExecutionChain } | ChainFailure
		if (result.ok) {
			committed.current = result.chain
			setChain(result.chain)
			refresh()
			return
		}
		if (result.error === 'chain_changed' && result.current) {
			committed.current = result.current
			setChain(result.current)
			setNotice({
				text: 'Your chain changed somewhere else, maybe by an agent. This is the current chain.',
				retry: next,
			})
			return
		}
		if (result.error === 'context_not_usable' && result.contextId && !retried) {
			const name = nameFor(result.contextId)
			const pruned = {
				...next,
				entries: removeChainContext(next.entries, result.contextId),
			}
			setChain(pruned)
			setNotice({
				text: `${name} is no longer usable, so it was left out of your change.`,
			})
			return save(pruned, true)
		}
		setChain(committed.current)
		setNotice({
			tone: 'error',
			text:
				result.error === 'chain_too_long'
					? `Your chain is full. It holds up to ${maxChainContexts} contexts plus Kody cloud.`
					: result.message || 'Could not save your chain.',
		})
	}

	function persist(next: ExecutionChain, message?: string) {
		setChain(next)
		setNotice(null)
		if (message) setAnnouncement(message)
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => {
			timer.current = null
			void save(next)
		}, saveDelayMs)
	}

	function move(id: string, delta: -1 | 1, commit = true) {
		const next = {
			...chain,
			entries: moveChainContext(chain.entries, id, delta),
		}
		const position =
			next.entries.findIndex(
				(entry) => entry.kind === 'context' && entry.id === id,
			) + 1
		const message = `${nameFor(id)} moved to position ${position} of ${contextEntries.length}.`
		focusAfterMove.current = `${id}|${commit ? (delta < 0 ? 'up' : 'down') : 'handle'}`
		if (commit) persist(next, message)
		else {
			setChain(next)
			setAnnouncement(message)
		}
	}

	function dropOn(targetId: string) {
		if (!dragId || dragId === targetId) return
		const ids = contextEntries.map((entry) => entry.id)
		const from = ids.indexOf(dragId)
		const to = ids.indexOf(targetId)
		if (from < 0 || to < 0) return
		let next = chain.entries
		const step = to > from ? 1 : -1
		for (let index = from; index !== to; index += step)
			next = moveChainContext(next, dragId, step)
		persist(
			{ ...chain, entries: next },
			`${nameFor(dragId)} moved to position ${to + 1} of ${ids.length}.`,
		)
		setDragId(null)
	}

	function onHandleKey(event: KeyboardEvent<HTMLButtonElement>, id: string) {
		if (event.key === ' ' || event.key === 'Enter') {
			event.preventDefault()
			if (grabbed?.id === id) {
				setGrabbed(null)
				persist(chain, `${nameFor(id)} dropped.`)
			} else {
				setGrabbed({ id, snapshot: chain })
				setAnnouncement(
					`${nameFor(id)} grabbed. Use the arrow keys to move it, Space to drop, Escape to cancel.`,
				)
			}
		} else if (
			grabbed?.id === id &&
			(event.key === 'ArrowUp' || event.key === 'ArrowDown')
		) {
			event.preventDefault()
			move(id, event.key === 'ArrowUp' ? -1 : 1, false)
		} else if (grabbed?.id === id && event.key === 'Escape') {
			event.preventDefault()
			focusAfterMove.current = `${id}|handle`
			setChain(grabbed.snapshot)
			setGrabbed(null)
			setAnnouncement(`Move cancelled. ${nameFor(id)} is back where it was.`)
		}
	}

	return (
		<section
			aria-labelledby="execution-chain-title"
			data-testid="execution-chain"
			css={{ display: 'grid', gap: spacing.md, containerType: 'inline-size' }}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2 id="execution-chain-title" css={{ margin: 0, fontSize: '1.15rem' }}>
					Your fallback chain in @{props.orgSlug}
				</h2>
				<p css={mutedCss}>
					Kody tries these in order for your execute runs and moves to the next
					one when a context is offline, busy or not usable. Up to{' '}
					{maxChainContexts} contexts.
				</p>
			</div>
			<div
				role="status"
				aria-live="polite"
				css={{
					position: 'absolute',
					width: 1,
					height: 1,
					overflow: 'hidden',
					clip: 'rect(0 0 0 0)',
				}}
			>
				{announcement}
			</div>
			{warning === 'cloud-only' ? (
				<p css={mutedCss} data-testid="chain-cloud-only">
					Every run uses Kody cloud. Add a context to run code on your own
					machine.
				</p>
			) : warning === 'strict-no-usable' ? (
				<AccountManagementMessage tone="error">
					Nothing in your chain can run code right now, and Kody cloud is off,
					so your execute runs will fail. Add a usable context or add Kody cloud
					back.
				</AccountManagementMessage>
			) : warning === 'strict-none-accepting' ? (
				<AccountManagementMessage tone="error">
					No context in your chain is online, and Kody cloud is off, so your
					execute runs will fail until one comes back.
				</AccountManagementMessage>
			) : null}
			{notice ? (
				<div
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
					}}
				>
					<AccountManagementMessage tone={notice.tone}>
						{notice.text}
					</AccountManagementMessage>
					{notice.retry ? (
						<button
							type="button"
							css={getGhostButtonCss({ size: 'sm' })}
							onClick={() => notice.retry && persist(notice.retry)}
						>
							Apply my change again
						</button>
					) : null}
				</div>
			) : null}
			<ol ref={listRef} css={listCss} aria-label="Fallback chain">
				{contextEntries.map((entry, index) => {
					const context = byId.get(entry.id)
					const status = context ? contextDisplayStatus(context) : 'offline'
					return (
						// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drop target for pointer drag; keyboard and buttons reorder too
						<li
							key={entry.id}
							data-testid="chain-entry"
							data-context-id={entry.id}
							css={[rowCss, grabbed?.id === entry.id ? grabbedRowCss : null]}
							onDragOver={(event) => {
								if (dragId) event.preventDefault()
							}}
							onDrop={(event) => {
								event.preventDefault()
								dropOn(entry.id)
							}}
						>
							<button
								type="button"
								css={handleCss}
								draggable
								data-chain-focus={`${entry.id}|handle`}
								aria-pressed={grabbed?.id === entry.id}
								aria-label={`Reorder ${nameFor(entry.id)}, position ${index + 1} of ${contextEntries.length}`}
								onDragStart={(event) => {
									setDragId(entry.id)
									event.dataTransfer.effectAllowed = 'move'
									event.dataTransfer.setData('text/plain', entry.id)
								}}
								onDragEnd={() => setDragId(null)}
								onKeyDown={(event) => onHandleKey(event, entry.id)}
							>
								⠿
							</button>
							<span aria-hidden css={{ fontWeight: 600 }}>
								{index + 1}
							</span>
							<div css={{ display: 'grid', gap: 2, minWidth: 0 }}>
								<strong css={{ overflowWrap: 'anywhere' }}>
									{nameFor(entry.id)}
								</strong>
								{entry.usable ? (
									<span css={mutedCss}>{displayStatusLabel(status)}</span>
								) : (
									<span css={mutedCss} data-testid="chain-entry-unusable">
										{skippedLabel(entry.unusableReason)}
										{entry.unusableReason && context
											? `. ${unusableReasonCopy({
													reason: entry.unusableReason,
													name: context.name,
													operator: context.operator.handle,
													orgSlug: props.orgSlug,
												})}`
											: null}
									</span>
								)}
							</div>
							<div css={actionsCss}>
								<button
									type="button"
									css={getGhostButtonCss({ size: 'sm' })}
									disabled={index === 0}
									data-chain-focus={`${entry.id}|up`}
									aria-label={`Move ${nameFor(entry.id)} up`}
									onClick={() => move(entry.id, -1)}
								>
									Up
								</button>
								<button
									type="button"
									css={getGhostButtonCss({ size: 'sm' })}
									disabled={index === contextEntries.length - 1}
									data-chain-focus={`${entry.id}|down`}
									aria-label={`Move ${nameFor(entry.id)} down`}
									onClick={() => move(entry.id, 1)}
								>
									Down
								</button>
								<button
									type="button"
									css={getGhostButtonCss({ size: 'sm' })}
									aria-label={`Remove ${nameFor(entry.id)} from your chain`}
									onClick={() =>
										persist(
											{
												...chain,
												entries: removeChainContext(chain.entries, entry.id),
											},
											`${nameFor(entry.id)} removed from your chain.`,
										)
									}
								>
									Remove
								</button>
							</div>
						</li>
					)
				})}
				{hasCloud ? (
					<li css={rowCss} data-testid="chain-cloud">
						<span
							css={[
								targetCss,
								{
									display: 'grid',
									placeContent: 'center',
									color: colors.textMuted,
								},
							]}
							aria-hidden
						>
							☁
						</span>
						<span aria-hidden css={{ fontWeight: 600 }}>
							{contextEntries.length + 1}
						</span>
						<div css={{ display: 'grid', gap: 2 }}>
							<strong>Kody cloud</strong>
							<span css={mutedCss}>
								Always last. Used when nothing above can take the run.
							</span>
						</div>
						<div
							css={[
								actionsCss,
								confirmStrict
									? { gridColumn: '1 / -1', justifyContent: 'start' }
									: null,
							]}
						>
							{confirmStrict ? (
								<>
									<span css={mutedCss}>
										Without Kody cloud, runs fail when no context in your chain
										can take them.
									</span>
									<button
										type="button"
										css={getGhostButtonCss({ size: 'sm' })}
										onClick={() => {
											setConfirmStrict(false)
											persist(
												{
													...chain,
													entries: entries.filter(
														(item) => item.kind !== 'cloud',
													),
												},
												'Kody cloud removed. Your chain is strict.',
											)
										}}
									>
										Remove Kody cloud
									</button>
									<button
										type="button"
										css={getGhostButtonCss({ size: 'sm' })}
										onClick={() => setConfirmStrict(false)}
									>
										Keep it
									</button>
								</>
							) : (
								<button
									type="button"
									css={getGhostButtonCss({ size: 'sm' })}
									onClick={() => setConfirmStrict(true)}
								>
									Remove Kody cloud
								</button>
							)}
						</div>
					</li>
				) : null}
			</ol>
			<div
				css={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'center',
				}}
			>
				{hasCloud ? null : (
					<button
						type="button"
						css={getPillButtonCss({ size: 'sm' })}
						onClick={() =>
							persist(
								{ ...chain, entries: [...entries, { kind: 'cloud' }] },
								'Kody cloud added back at the end of your chain.',
							)
						}
					>
						Add Kody cloud back
					</button>
				)}
				{addable.length > 0 ? (
					<>
						<label
							css={{
								display: 'inline-flex',
								gap: spacing.xs,
								alignItems: 'center',
							}}
						>
							<span>Add a context</span>
							<select
								value={addId}
								disabled={full}
								onChange={(event) => setAddId(event.target.value)}
								css={[targetCss, selectCss]}
							>
								<option value="">Choose…</option>
								{addable.map((context) => (
									<option key={context.id} value={context.id}>
										{context.name}
									</option>
								))}
							</select>
						</label>
						<button
							type="button"
							css={getGhostButtonCss({ size: 'sm' })}
							disabled={full || !addId}
							onClick={() => {
								const context = byId.get(addId)
								if (!context) return
								const next = normalizeChain([
									...entries.filter((entry) => entry.kind === 'context'),
									{ kind: 'context' as const, id: context.id, usable: true },
									...entries.filter((entry) => entry.kind === 'cloud'),
								])
								setAddId('')
								persist(
									{ ...chain, entries: next },
									`${context.name} added to your chain.`,
								)
							}}
						>
							Add to chain
						</button>
						{full ? (
							<span css={mutedCss}>
								Your chain is full. Remove a context to add another.
							</span>
						) : null}
					</>
				) : null}
			</div>
			{chain.updatedAt ? (
				<p css={mutedCss}>
					Last changed {formatTimestamp(chain.updatedAt)}
					{chain.updatedBy ? ` by ${chain.updatedBy.label}` : ''}.
				</p>
			) : null}
		</section>
	)
}
