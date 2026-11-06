/** @jsxImportSource @emotion/react */
import { orgSlugFromPathname } from '#universal/org-pages.ts'
import { useEffect, useId, useRef, useState } from 'react'
import { useHotkeys, formatForDisplay } from '@tanstack/react-hotkeys'
import { useRouter } from '@tanstack/react-router'
import { useQueries } from '@tanstack/react-query'
import { useJobCommands } from './job-commands.ts'
import type { SessionInfo } from '#client/session.ts'
import { searchCommands } from '#start/server/command-search'
import { toast } from '#client/toast.ts'
import { colors } from '#universal/styles/tokens.ts'
import { renderIcon } from '../components/icon.tsx'
import { ShortcutSettings } from './shortcut-settings.tsx'
import { commandHotkeys } from './hotkeys.ts'
import { commandCatalog } from './catalog.ts'
import { rankCommands, parseCommandQuery, type Command } from './model.ts'
import { readCommandHistory, saveCommandHistory } from './preferences.ts'
import {
	dialogCss,
	inputCss,
	rowCss,
	footerCss,
	smallButtonCss,
} from './styles.ts'

export function CommandDialog({
	session,
	pathname,
	pageCommands,
	onClose,
}: {
	session: SessionInfo | null
	pathname: string
	pageCommands: Command[]
	onClose: () => void
}) {
	const router = useRouter()
	const dialog = useRef<HTMLDialogElement>(null)
	const input = useRef<HTMLInputElement>(null)
	const confirmationHeading = useRef<HTMLHeadingElement>(null)
	const list = useRef<HTMLDivElement>(null)
	const id = useId()
	const [query, setQuery] = useState('')
	const [debounced, setDebounced] = useState('')
	const [slug, setSlug] = useState(
		() =>
			session?.organizations?.find(
				(org) => orgSlugFromPathname(pathname) === org.slug,
			)?.slug ?? session?.organizations?.find((org) => org.personal)?.slug,
	)
	const [index, setIndex] = useState(0)
	const [selectionId, setSelectionId] = useState<string | null>(null)
	const [actions, setActions] = useState<Command | null>(null)
	const [confirmation, setConfirmation] = useState<Command | null>(null)
	const [busy, setBusy] = useState(false)
	const busyRef = useRef(false)
	const [error, setError] = useState<string | null>(null)
	const [help, setHelp] = useState(false)
	const historyKey = `kody:commands:v1:${session?.username ?? 'public'}`
	const [history, setHistory] = useState(() => readCommandHistory(historyKey))
	const [favorites, setFavorites] = useState(false)
	const historyRef = useRef(history)
	const parsed = parseCommandQuery(query)
	const parsedDebounced = parseCommandQuery(debounced)
	const org = session?.organizations?.find((org) => org.slug === slug)
	const preferredIds = Object.entries(history)
		.filter(([id, use]) => use.pinned && id.includes(`:${slug}:`))
		.map(([id]) => id)
		.slice(0, 40)
	const kinds = [
		'repository',
		'job',
		'credential',
		'memory',
		'workflow',
	] as const
	const searches = useQueries({
		queries: kinds.map((kind) => ({
			queryKey: [
				'command-search',
				session?.username,
				slug,
				kind,
				parsedDebounced.text,
				preferredIds,
				org?.role,
				parsedDebounced.commandsOnly || parsedDebounced.kind === 'action'
					? 'actions'
					: parsedDebounced.kind
						? 'resources'
						: 'all',
			],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				searchCommands({
					data: {
						orgSlug: slug!,
						kind,
						mode:
							parsedDebounced.commandsOnly || parsedDebounced.kind === 'action'
								? 'actions'
								: parsedDebounced.kind
									? 'resources'
									: 'all',
						query: parsedDebounced.text.slice(0, 200),
						preferredIds,
					},
					signal,
				}),
			enabled: Boolean(
				org &&
				org.role !== null &&
				(!parsedDebounced.commandsOnly || kind === 'job') &&
				(!parsedDebounced.kind ||
					parsedDebounced.kind === kind ||
					(parsedDebounced.kind === 'action' && kind === 'job')) &&
				(kind !== 'memory' || org.personal),
			),
			staleTime: 15_000,
			gcTime: 60_000,
			retry: false,
		})),
	})
	const loading =
		query !== debounced || searches.some((search) => search.isFetching)
	const failures = searches.flatMap((search, i) =>
		search.isError ? [kinds[i]] : [],
	)
	const catalog = commandCatalog(session, slug, pathname)
	const copyPage: Command = {
		id: 'copy-page',
		title: 'Copy page link',
		kind: 'action',
		icon: 'link',
		context: true,
		run: async () => {
			await navigator.clipboard.writeText(location.href)
			toast.success('Link copied')
		},
	}
	const clearHistory: Command = {
		id: 'clear-history',
		title: 'Clear command history and favorites',
		kind: 'action',
		icon: 'refresh',
		confirm: 'Clear your command history and favorites on this browser?',
		run: () => {
			historyRef.current = {}
			saveCommandHistory(historyKey, {})
			setHistory({})
		},
	}
	const resourceCommands = useJobCommands(
		org && org.role !== null && query === debounced
			? searches.flatMap((search) => search.data ?? [])
			: [],
		slug,
	)
	const all = [
		...catalog,
		...resourceCommands,
		...(slug ===
		(session?.organizations?.find(
			(item) => orgSlugFromPathname(pathname) === item.slug,
		)?.slug ?? session?.organizations?.find((item) => item.personal)?.slug)
			? pageCommands
			: []),
		copyPage,
		clearHistory,
	]
	const ranked = rankCommands(
		[...new Map(all.map((command) => [command.id, command])).values()],
		query,
		history,
	)
	const results = (
		favorites ? ranked.filter((command) => history[command.id]?.pinned) : ranked
	).slice(0, 60)
	const selected =
		results.find((command) => command.id === selectionId) ??
		results[Math.min(index, Math.max(0, results.length - 1))]
	const rows: Command[] = actions
		? [
				{
					...actions,
					title:
						actions.kind === 'action' ? actions.title : `Open ${actions.title}`,
				},
				{
					id: 'pin',
					title: history[actions.id]?.pinned
						? 'Remove from favorites'
						: 'Add to favorites',
					kind: 'action',
					icon: 'star',
					run: () => {
						togglePin(actions)
						setActions(null)
					},
				},
				...(actions.href
					? [
							{
								id: 'copy',
								title: 'Copy link',
								kind: 'action' as const,
								icon: 'link' as const,
								run: async () => {
									await navigator.clipboard.writeText(
										new URL(actions.href!, location.origin).href,
									)
									toast.success('Link copied')
								},
							},
						]
					: []),
			]
		: results
	const active =
		rows.find((command) => command.id === selectionId) ??
		rows[Math.min(index, Math.max(0, rows.length - 1))]
	function selectIndex(next: number) {
		setIndex(next)
		setSelectionId(rows[next]?.id ?? null)
	}
	function resetSelection() {
		setIndex(0)
		setSelectionId(null)
	}
	function updateQuery(value: string) {
		setQuery(value)
		resetSelection()
		setActions(null)
		setError(null)
	}
	function togglePin(command: Command) {
		const previous = historyRef.current
		const next = {
			...previous,
			[command.id]: {
				count: previous[command.id]?.count ?? 0,
				lastUsed: previous[command.id]?.lastUsed ?? 0,
				pinned: !previous[command.id]?.pinned,
			},
		}
		historyRef.current = next
		saveCommandHistory(historyKey, next)
		setHistory(next)
	}

	async function execute(command: Command | undefined, confirmed = false) {
		if (!command || busyRef.current) return
		if (command.confirm && !confirmed) {
			setConfirmation(command)
			return
		}
		busyRef.current = true
		setBusy(true)
		setError(null)
		try {
			if (command.run) await command.run()
			else if (command.href) await router.navigate({ href: command.href })
			if (command.id !== 'clear-history' && command.id !== 'pin') {
				const next = {
					...historyRef.current,
					[command.id]: {
						...historyRef.current[command.id],
						count: (historyRef.current[command.id]?.count ?? 0) + 1,
						lastUsed: Date.now(),
					},
				}
				historyRef.current = next
				saveCommandHistory(historyKey, next)
			}
			if (command.id !== 'pin') onClose()
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: 'Could not complete this command. Try again.',
			)
			setConfirmation(null)
		} finally {
			busyRef.current = false
			setBusy(false)
		}
	}
	function back() {
		if (busyRef.current) return
		if (confirmation) {
			setConfirmation(null)
			requestAnimationFrame(() => input.current?.focus())
		} else if (help) {
			setHelp(false)
			requestAnimationFrame(() => input.current?.focus())
		} else if (actions) {
			setActions(null)
			resetSelection()
		} else onClose()
	}
	useHotkeys(
		[
			{
				hotkey: commandHotkeys['commands.open'],
				callback: back,
				options: { requireReset: true, ignoreInputs: 'auto' },
			},
			{
				hotkey: 'Escape',
				callback: back,
				options: { meta: { name: 'Back or close' } },
			},
			{
				hotkey: 'ArrowDown',
				callback: () =>
					selectIndex(
						rows.length ? (rows.indexOf(active!) + 1) % rows.length : 0,
					),
				options: {
					meta: { name: 'Next result' },
					target: input,
					enabled: !confirmation && !help,
				},
			},
			{
				hotkey: 'ArrowUp',
				callback: () =>
					selectIndex(
						rows.length
							? (rows.indexOf(active!) - 1 + rows.length) % rows.length
							: 0,
					),
				options: {
					meta: { name: 'Previous result' },
					target: input,
					enabled: !confirmation && !help,
				},
			},
			{
				hotkey: 'Enter',
				callback: () => void execute(active),
				options: {
					meta: { name: 'Open selected' },
					target: input,
					enabled: !confirmation && !help && !busy,
				},
			},
			{
				hotkey: 'Mod+Enter',
				callback: () =>
					void execute(confirmation ?? active, Boolean(confirmation)),
				options: { meta: { name: 'Confirm action' }, enabled: !help && !busy },
			},
			{
				hotkey: 'Mod+P',
				callback: () => {
					if (selected) togglePin(selected)
				},
				options: {
					meta: { name: 'Favorite selected' },
					enabled: !confirmation && !help,
				},
			},
			{
				hotkey: 'Mod+ArrowRight',
				callback: () => {
					if (selected) {
						setActions(selected)
						resetSelection()
					}
				},
				options: {
					meta: { name: 'Result actions' },
					enabled: !actions && !confirmation && !help,
				},
			},
			{
				hotkey: 'Mod+ArrowLeft',
				callback: () => {
					setActions(null)
					resetSelection()
				},
				options: {
					meta: { name: 'Back to results' },
					enabled: Boolean(actions),
				},
			},
			...(
				[
					'Mod+1',
					'Mod+2',
					'Mod+3',
					'Mod+4',
					'Mod+5',
					'Mod+6',
					'Mod+7',
					'Mod+8',
					'Mod+9',
				] as const
			).map((hotkey, i) => ({
				hotkey,
				callback: () => void execute(rows[i]),
				options: { enabled: !confirmation && !help && !busy },
			})),
		],
		{ target: dialog, ignoreInputs: false, preventDefault: true },
	)
	useEffect(() => {
		if (confirmation) confirmationHeading.current?.focus()
		else if (!help) input.current?.focus()
	}, [actions, confirmation, help])
	useEffect(() => {
		const timeout = setTimeout(() => setDebounced(query), 180)
		return () => clearTimeout(timeout)
	}, [query])
	useEffect(() => {
		const previous = document.activeElement
		dialog.current?.showModal()
		input.current?.focus()
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected)
				previous.focus()
		}
	}, [])
	useEffect(() => {
		list.current
			?.querySelector('[aria-selected="true"]')
			?.scrollIntoView({ block: 'nearest' })
	}, [index, selectionId])
	return (
		<dialog
			ref={dialog}
			aria-label="Search and commands"
			css={dialogCss}
			onCancel={(event) => {
				event.preventDefault()
				back()
			}}
			closedby="any"
		>
			{confirmation ? (
				<div css={{ padding: 24 }}>
					<h2
						ref={confirmationHeading}
						tabIndex={-1}
						css={{ fontSize: 18, marginTop: 0 }}
					>
						{confirmation.title}
					</h2>
					<p>{confirmation.confirm}</p>
					<div css={{ display: 'flex', gap: 8 }}>
						<button
							css={smallButtonCss}
							disabled={busy}
							onClick={() => void execute(confirmation, true)}
						>
							{busy ? 'Working…' : 'Confirm'}{' '}
							<kbd>{formatForDisplay('Mod+Enter')}</kbd>
						</button>
						<button css={smallButtonCss} disabled={busy} onClick={back}>
							Cancel
						</button>
					</div>
				</div>
			) : help ? (
				<ShortcutSettings
					onBack={() => {
						setHelp(false)
						requestAnimationFrame(() => input.current?.focus())
					}}
				/>
			) : (
				<>
					<div
						css={{
							display: 'flex',
							alignItems: 'center',
							gap: 12,
							padding: '16px 20px',
							borderBottom: `1px solid ${colors.border}`,
						}}
					>
						{renderIcon('search', { size: '20px' })}
						<input
							ref={input}
							data-field-ring
							css={inputCss}
							value={query}
							onChange={(event) => updateQuery(event.target.value)}
							placeholder={
								actions
									? `Actions for ${actions.title}`
									: 'Search Kody or type a command…'
							}
							aria-label="Search Kody"
							role="combobox"
							aria-expanded="true"
							aria-controls={`${id}-results`}
							aria-activedescendant={
								active ? `${id}-${rows.indexOf(active)}` : undefined
							}
							aria-autocomplete="list"
							autoComplete="off"
							maxLength={200}
						/>
						<button
							css={smallButtonCss}
							onClick={back}
							aria-label="Close commands"
						>
							Esc
						</button>
					</div>
					<div
						css={{
							display: 'flex',
							gap: 8,
							padding: '10px 16px',
							flexWrap: 'wrap',
							alignItems: 'center',
							borderBottom: `1px solid ${colors.border}`,
						}}
					>
						{actions ? (
							<button
								css={smallButtonCss}
								onClick={() => {
									setActions(null)
									resetSelection()
								}}
							>
								Back
							</button>
						) : (
							<>
								<select
									aria-label="Search workspace"
									value={slug ?? ''}
									onChange={(event) => {
										setSlug(event.target.value)
										resetSelection()
									}}
									css={{ ...smallButtonCss, maxWidth: 230 }}
								>
									{session?.organizations?.map((org) => (
										<option key={org.slug} value={org.slug}>
											@{org.slug}
										</option>
									))}
									{!session ? <option value="">Kody</option> : null}
								</select>
								<button
									css={smallButtonCss}
									aria-pressed={favorites}
									onClick={() => {
										setFavorites((value) => !value)
										resetSelection()
									}}
								>
									Favorites
								</button>
								<button
									css={smallButtonCss}
									aria-pressed={parsed.commandsOnly}
									onClick={() =>
										updateQuery(
											parsed.commandsOnly
												? query.replace(/^\s*>\s*/, '')
												: `> ${query}`,
										)
									}
								>
									Commands
								</button>
							</>
						)}
						<span
							role="status"
							css={{
								marginLeft: 'auto',
								fontSize: 12,
								color: colors.textMuted,
							}}
						>
							{loading
								? 'Searching…'
								: `${rows.length}${ranked.length > 60 ? '+' : ''} ${rows.length === 1 ? 'result' : 'results'}`}
						</span>
					</div>
					<div
						ref={list}
						id={`${id}-results`}
						role="listbox"
						aria-label={actions ? 'Actions' : 'Results'}
						css={{
							overflowY: 'auto',
							maxHeight: 'min(440px, 52dvh)',
							minHeight: 160,
							padding: 8,
						}}
					>
						{rows.map((command, i) => (
							<div
								key={command.id}
								id={`${id}-${i}`}
								role="option"
								tabIndex={-1}
								aria-selected={active?.id === command.id}
								css={rowCss}
								onMouseMove={() => selectIndex(i)}
								onClick={() => void execute(command)}
							>
								<span
									css={{
										display: 'grid',
										placeItems: 'center',
										width: 34,
										height: 34,
										border: `1px solid ${colors.border}`,
										borderRadius: 8,
										flexShrink: 0,
									}}
								>
									{renderIcon(command.icon, { size: '17px' })}
								</span>
								<span css={{ minWidth: 0, flex: 1 }}>
									<span css={{ display: 'block', fontWeight: 550 }}>
										{command.title}
										{history[command.id]?.pinned ? (
											<span
												aria-label="Favorite"
												css={{ marginLeft: 6, color: colors.primary }}
											>
												★
											</span>
										) : null}
									</span>
									<span
										css={{
											display: 'block',
											overflow: 'hidden',
											textOverflow: 'ellipsis',
											whiteSpace: 'nowrap',
											fontSize: 12,
											color: colors.textMuted,
										}}
									>
										{command.subtitle ?? command.href ?? ''}
									</span>
								</span>
								<span css={{ fontSize: 11, color: colors.textMuted }}>
									{command.kind}
								</span>
								{i < 9 ? (
									<kbd
										css={{
											fontSize: 11,
											color: colors.textMuted,
											minWidth: 24,
										}}
									>
										{`${formatForDisplay('Mod+1').slice(0, -1)}${i + 1}`}
									</kbd>
								) : null}
							</div>
						))}
						{rows.length === 0 ? (
							<p css={{ padding: 24, color: colors.textMuted }}>
								{favorites
									? 'No matching favorites. Select a result and use Favorite to save it.'
									: loading
										? 'Searching your workspace…'
										: 'No matches. Try a different name or switch workspaces.'}
							</p>
						) : null}
					</div>
					<div css={footerCss}>
						<button css={smallButtonCss} onClick={() => setHelp(true)}>
							Keyboard shortcuts
						</button>
						<span css={{ marginLeft: 'auto' }}>↑ ↓</span>
						<button
							css={smallButtonCss}
							disabled={!active || busy}
							onClick={() => void execute(active)}
						>
							{busy ? 'Working…' : 'Open'} ↵
						</button>
						{!actions ? (
							<button
								css={smallButtonCss}
								disabled={!selected}
								onClick={() => {
									if (selected) {
										setActions(selected)
										resetSelection()
									}
								}}
							>
								Actions {formatForDisplay('Mod+ArrowRight')}
							</button>
						) : null}
					</div>
				</>
			)}
			{error ? (
				<p role="alert" css={{ padding: '0 20px', color: colors.text }}>
					{error}
				</p>
			) : null}
			{failures.length ? (
				<div role="status" css={{ padding: '8px 20px', fontSize: 12 }}>
					Could not search {failures.join(', ')}.{' '}
					<button
						css={smallButtonCss}
						onClick={() => {
							for (const search of searches)
								if (search.isError) void search.refetch()
						}}
					>
						Retry
					</button>
				</div>
			) : null}
		</dialog>
	)
}
