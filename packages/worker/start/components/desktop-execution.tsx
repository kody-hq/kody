/** @jsxImportSource @emotion/react */
import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { setExperiment } from '#start/server/experiment-opt-in'
import {
	loadExecutionContextsPage,
	putDesktopExecutionFirst,
	runExecutionContextDaemonAction,
} from '#start/server/execution-contexts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	getGhostButtonCss,
	inputCss,
} from '#universal/styles/style-primitives.ts'
import {
	chainIsFull,
	type ExecutionContextsPageData,
} from '#universal/execution-contexts.ts'
import {
	desktopSetupContextInChain,
	desktopSetupPanelAction,
	desktopSetupResumeStep,
	desktopSetupStages,
	type DesktopSetupStageId,
	type DesktopSetupWizardStep,
} from '#universal/desktop-setup-stages.ts'
import type {
	DesktopExecutionBridge,
	DesktopExecutionState,
	DesktopMachineMenuCommand,
} from '../desktop-shell.ts'
import { onboardingQuery } from '../onboarding-query.ts'

const DesktopMachineContext = createContext<null | {
	state: DesktopExecutionState | undefined
	commands: (action: 'status' | 'on' | 'off') => Promise<void>
	forget: () => void
	open: (targetOrgSlug?: string | null) => void
	toggle: () => Promise<void>
	restart: (() => Promise<void>) | null
	autoUpdate: ((enabled: boolean) => Promise<void>) | null
	error: string | null
	orgSlug: string | null
	menuCommand: DesktopMachineMenuCommand | null
	clearMenuCommand: () => void
	needsAccountOnboarding: boolean | null
}>(null)

const oneRunnerCopy =
	'One runner per machine: this app and the kody CLI share this machine’s registration and its runner.'

type SetupData = Extract<ExecutionContextsPageData, { enabled: true }>
const buttonCss = getPillButtonCss({ size: 'sm' })
const secondaryCss = getGhostButtonCss({ size: 'sm' })

function SetupStageList({
	stages,
}: {
	stages: ReturnType<typeof desktopSetupStages>
}) {
	return (
		<ol
			data-testid="desktop-setup-stages"
			css={{
				margin: `0 0 ${spacing.md}`,
				padding: 0,
				listStyle: 'none',
				display: 'grid',
				gap: spacing.xs,
			}}
		>
			{stages.map((stage, index) => (
				<li
					key={stage.id}
					data-stage={stage.id}
					data-status={stage.status}
					css={{
						display: 'flex',
						gap: spacing.sm,
						alignItems: 'baseline',
						color: stage.status === 'upcoming' ? colors.textMuted : colors.text,
						fontWeight: stage.status === 'current' ? 600 : undefined,
					}}
				>
					<span aria-hidden css={{ minWidth: '1.5rem' }}>
						{stage.status === 'complete'
							? '✓'
							: stage.status === 'current'
								? '→'
								: `${index + 1}.`}
					</span>
					<span>
						{stage.label}
						{stage.status === 'current' ? (
							<span css={{ color: colors.textMuted }}> (current)</span>
						) : null}
					</span>
				</li>
			))}
		</ol>
	)
}

export function DesktopExecutionProvider({
	children,
	actorKey,
	username,
	orgSlug,
	pathname,
}: {
	children: ReactNode
	actorKey: string | null
	username: string | null
	orgSlug: string | null
	pathname: string
}) {
	const [bridge, setBridge] = useState<DesktopExecutionBridge | null>(null)
	const [opened, setOpened] = useState(false)
	const [step, setStep] = useState<DesktopSetupWizardStep>('overview')
	const [name, setName] = useState('')
	const [replace, setReplace] = useState('')
	const [setup, setSetup] = useState<SetupData | null>(null)
	// Team org this machine should become available to after personal registration.
	const [target, setTarget] = useState<string | null>(null)
	const [attached, setAttached] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const dialog = useRef<HTMLDialogElement>(null)
	const client = useQueryClient()
	const router = useRouter()
	const enable = useServerFn(setExperiment)
	const loadSetup = useServerFn(loadExecutionContextsPage)
	const putFirst = useServerFn(putDesktopExecutionFirst)
	const [menuCommand, setMenuCommand] =
		useState<DesktopMachineMenuCommand | null>(null)
	useEffect(() => {
		setBridge(window.kodyDesktop?.execution ?? null)
	}, [])
	useEffect(() => {
		if (!bridge?.takeMenuCommand) return
		const take = () =>
			void bridge
				.takeMenuCommand?.()
				.then((command) => command && setMenuCommand(command))
				.catch(() => {})
		take()
		return bridge.onMenuCommand?.(take)
	}, [bridge])
	const machine = useQuery({
		queryKey: ['desktop-machine', actorKey],
		queryFn: () => bridge!.getState(),
		enabled: !!bridge,
		refetchInterval: 5000,
		retry: false,
	})
	const onboarding = useQuery({
		...onboardingQuery(actorKey, undefined),
		enabled: !!bridge && !!username,
		refetchInterval: (query) =>
			query.state.data?.payload.needsOnboarding ? 4000 : false,
	})
	useEffect(() => {
		if (machine.data && !name) setName(machine.data.name)
	}, [machine.data, name])
	const existingContext = machine.data?.contextId
		? null
		: (machine.data?.existingContext ?? null)
	useEffect(() => {
		const existing = existingContext?.name
		if (existing && /^[a-z0-9][a-z0-9-]{0,62}$/.test(existing))
			setName(existing)
	}, [existingContext?.name])
	useEffect(() => {
		if (
			bridge &&
			username &&
			!pathname.startsWith('/onboarding') &&
			!pathname.startsWith('/pending-verification') &&
			onboarding.data?.payload.needsOnboarding === false &&
			machine.data?.signedIn &&
			machine.data.supported &&
			!machine.data.blocked &&
			!machine.data.onboardingSeen
		)
			setOpened(true)
	}, [bridge, username, pathname, onboarding.data, machine.data])
	useEffect(() => {
		if (!dialog.current) return
		if (opened && !dialog.current.open) dialog.current.showModal()
		if (!opened && dialog.current.open) dialog.current.close()
	}, [opened])
	async function refresh() {
		await client.invalidateQueries({ queryKey: ['desktop-machine', actorKey] })
	}
	async function run(action: () => Promise<void>) {
		if (busy) return
		setBusy(true)
		setError(null)
		try {
			await action()
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(false)
			await refresh()
		}
	}
	async function close() {
		if (!bridge || busy) return
		await run(async () => {
			await bridge.dismissOnboarding()
			setOpened(false)
		})
	}
	function stageFocus(): DesktopSetupStageId | null {
		if (step === 'register') return 'register'
		if (step === 'attach') return 'attach'
		if (step === 'overview') return 'sign-in'
		return null
	}
	const inChain = desktopSetupContextInChain(
		setup?.chain.entries,
		machine.data?.contextId ?? null,
	)
	const stages = desktopSetupStages({
		targetOrgSlug: target,
		cliReady: !!machine.data?.cliReady,
		contextId: machine.data?.contextId ?? null,
		running: !!machine.data?.running,
		attached,
		inChain,
		focus: opened ? stageFocus() : null,
	})
	async function prepare() {
		if (!bridge || !orgSlug) return
		await run(async () => {
			await enable({
				data: { experiment: 'execution-contexts', enabled: true },
			})
			const signedIn =
				machine.data?.cliReady || machine.data?.contextId
					? machine.data
					: await bridge.signIn()
			client.setQueryData(['desktop-machine', actorKey], signedIn)
			const page = await loadSetup({
				data: { orgSlug: target ?? orgSlug, search: [] },
			})
			if (!page.payload.enabled)
				throw new Error('Execution contexts could not be enabled. Try again.')
			setSetup(page.payload)
			setReplace('')
			const listed = desktopSetupContextInChain(
				page.payload.chain.entries,
				signedIn?.contextId ?? null,
			)
			const next = desktopSetupResumeStep({
				targetOrgSlug: target,
				cliReady: !!signedIn?.cliReady,
				contextId: signedIn?.contextId ?? null,
				running: !!signedIn?.running,
				attached,
				inChain: listed,
			})
			// After sign-in, overview means registration is still open.
			setStep(next === 'overview' ? 'register' : next)
		})
	}
	async function putMachineFirst(contextId: string) {
		if (!orgSlug || !username) return
		await putFirst({
			data: {
				orgSlug,
				username,
				contextId,
				...(target ? { targetOrgSlug: target } : {}),
				...(needsReplacement && replace ? { replaceContextId: replace } : {}),
			},
		})
		if (target) setAttached(true)
	}
	async function registerMachine() {
		if (!bridge || !orgSlug || !username) return
		await run(async () => {
			let registered = machine.data
			if (!registered?.contextId) {
				registered = await bridge.connect(name)
				client.setQueryData(['desktop-machine', actorKey], registered)
			} else if (!registered.running) {
				// Resume after a stopped runner: start it before claiming success.
				registered = await bridge.start()
				client.setQueryData(['desktop-machine', actorKey], registered)
			}
			if (!registered?.contextId)
				throw new Error('The machine could not be registered. Try again.')
			if (!registered.running)
				throw new Error(
					'The runner is not connected yet. Start it from This machine, then resume setup.',
				)
			try {
				if (target) {
					const listed = desktopSetupContextInChain(
						setup?.chain.entries,
						registered.contextId,
					)
					if (listed || attached) {
						// Already on the team chain; runner start was the missing piece.
					} else {
						// Team destination: keep personal registration, attach next.
						setStep('attach')
						return
					}
				} else {
					await putMachineFirst(registered.contextId)
				}
			} catch (error) {
				const current = await loadSetup({
					data: { orgSlug: target ?? orgSlug, search: [] },
				})
				if (current.payload.enabled) setSetup(current.payload)
				setReplace('')
				throw error
			}
			await bridge.completeOnboarding()
			await client.invalidateQueries({ queryKey: ['shell'] })
			await client.invalidateQueries({ queryKey: ['page'] })
			await router.invalidate()
			setStep('done')
		})
	}
	async function attachMachine() {
		if (!bridge || !orgSlug || !username || !target) return
		await run(async () => {
			let registered = machine.data
			const contextId = registered?.contextId
			if (!contextId)
				throw new Error('Register this device personally before attaching it.')
			if (!registered?.running) {
				registered = await bridge.start()
				client.setQueryData(['desktop-machine', actorKey], registered)
			}
			if (!registered?.running)
				throw new Error(
					'The runner is not connected yet. Start it from This machine, then resume setup.',
				)
			try {
				await putMachineFirst(contextId)
			} catch (error) {
				const current = await loadSetup({
					data: { orgSlug: target, search: [] },
				})
				if (current.payload.enabled) setSetup(current.payload)
				setReplace('')
				throw error
			}
			await bridge.completeOnboarding()
			await client.invalidateQueries({ queryKey: ['shell'] })
			await client.invalidateQueries({ queryKey: ['page'] })
			await router.invalidate()
			setStep('done')
		})
	}
	const needsReplacement =
		setup &&
		chainIsFull(setup.chain.entries) &&
		!setup.chain.entries.some(
			(entry) =>
				entry.kind === 'context' && entry.id === machine.data?.contextId,
		)
	const value =
		bridge && username
			? {
					state: machine.data,
					orgSlug,
					menuCommand,
					clearMenuCommand: () => setMenuCommand(null),
					needsAccountOnboarding:
						onboarding.data?.payload.needsOnboarding ?? null,
					commands: async (action: 'status' | 'on' | 'off') => {
						if (action === 'status') {
							try {
								client.setQueryData(
									['desktop-machine', actorKey],
									await bridge.commandsStatus(),
								)
							} catch (error) {
								setError(error instanceof Error ? error.message : String(error))
							}
							return
						}
						await run(async () => {
							const result = await (action === 'on'
								? bridge.enableCommands()
								: bridge.disableCommands())
							client.setQueryData(['desktop-machine', actorKey], result)
						})
					},
					forget: () => {
						setError(null)
						setTarget(null)
						setAttached(false)
						setStep('forget')
						setOpened(true)
					},
					error: error ?? machine.data?.error ?? machine.error?.message ?? null,
					open: (targetOrgSlug?: string | null) => {
						setError(null)
						setAttached(false)
						setTarget(targetOrgSlug ?? null)
						// Drop any prior org's chain snapshot so overview stages do not
						// treat personal membership as team attach (or the reverse).
						setSetup(null)
						setReplace('')
						// Always start on overview so Continue/Resume loads setup, then
						// advances to the first incomplete stage.
						setStep('overview')
						setOpened(true)
					},
					toggle: () =>
						run(async () => {
							if (machine.data?.running) await bridge.stop()
							else await bridge.start()
						}),
					restart: bridge.restart
						? () =>
								run(async () => {
									await bridge.restart?.()
								})
						: null,
					autoUpdate:
						bridge.enableAutoUpdate && bridge.disableAutoUpdate
							? (enabled: boolean) =>
									run(async () => {
										await (enabled
											? bridge.enableAutoUpdate?.()
											: bridge.disableAutoUpdate?.())
									})
							: null,
				}
			: null
	const title =
		step === 'forget'
			? 'Forget desktop setup?'
			: step === 'done'
				? target
					? `This machine is ready in @${target}`
					: 'This machine is ready'
				: step === 'attach' && target
					? `Make available to @${target}`
					: step === 'register'
						? 'Register this device personally'
						: 'Run Kody on this machine'
	return (
		<DesktopMachineContext value={value}>
			{children}
			{bridge && username ? (
				<dialog
					ref={dialog}
					aria-labelledby="desktop-execution-title"
					onCancel={(event) => {
						event.preventDefault()
						if (step === 'forget') {
							if (!busy) setOpened(false)
						} else void close()
					}}
					css={{
						width: 'min(480px, calc(100vw - 32px))',
						maxHeight: 'calc(100dvh - 32px)',
						overflowY: 'auto',
						boxSizing: 'border-box',
						border: `1px solid ${colors.border}`,
						borderRadius: radius.lg,
						padding: spacing.xl,
						color: colors.text,
						background: colors.surface,
						'&::backdrop': { background: '#0006' },
					}}
				>
					<h2 id="desktop-execution-title" css={{ marginTop: 0 }}>
						{title}
					</h2>
					{step !== 'forget' && step !== 'done' ? (
						<SetupStageList stages={stages} />
					) : null}
					{step === 'forget' ? (
						<>
							<p>
								This stops execution and forgets this app’s setup. The device
								and chain entry stay on the website. Revoke the device there to
								remove access.
							</p>
							<button
								type="button"
								css={buttonCss}
								disabled={busy}
								onClick={() =>
									void run(async () => {
										await bridge.forgetSetup()
										setName('')
										setSetup(null)
										setAttached(false)
										setStep('overview')
										setOpened(false)
									})
								}
							>
								Forget desktop setup
							</button>
							<button
								type="button"
								css={{ ...secondaryCss, marginLeft: spacing.sm }}
								disabled={busy}
								onClick={() => setOpened(false)}
							>
								Cancel
							</button>
						</>
					) : step === 'overview' ? (
						<>
							<p>
								Kody can run work here while the desktop app is open.{' '}
								{machine.data?.platform === 'darwin'
									? 'Closing the window keeps it available; quitting stops it.'
									: 'Quitting stops execution.'}
							</p>
							<p>
								A machine is registered to you personally
								{target ? `, then made available to @${target}` : ''}. Local
								folders require separate permission. Your cloud credentials stay
								in Kody cloud.
							</p>
							<button
								type="button"
								css={buttonCss}
								disabled={busy}
								onClick={() => void prepare()}
							>
								{busy
									? machine.data?.cliReady || machine.data?.contextId
										? 'Loading…'
										: 'Opening browser…'
									: machine.data?.cliReady || machine.data?.contextId
										? 'Resume setup'
										: 'Continue in browser'}
							</button>
						</>
					) : step === 'register' ? (
						<>
							{existingContext ? (
								<p>
									The kody CLI already registered this machine
									{existingContext.name ? ` as ${existingContext.name}` : ''}.
									This app uses that registration and its runner instead of
									creating a second one. {oneRunnerCopy}
								</p>
							) : machine.data?.contextId ? (
								<p>
									{`${name} is already registered to you personally. Continue to confirm the runner and ${
										target
											? `make it available to @${target}`
											: 'put it first in your personal execution chain'
									}.`}
								</p>
							) : (
								<label css={{ display: 'grid', gap: spacing.sm }}>
									Machine name
									<input
										css={inputCss}
										value={name}
										onChange={(event) => setName(event.target.value)}
										pattern="[a-z0-9][a-z0-9-]{0,62}"
										maxLength={63}
										disabled={busy || !!machine.data?.contextId}
									/>
								</label>
							)}
							{target ? (
								<p>
									Registration stays personal. The next step makes this machine
									available in @{target}.
								</p>
							) : (
								<p>
									This machine will be first in your personal execution chain.
									Your other entries and cloud fallback settings stay in their
									current order.
								</p>
							)}
							{!target && needsReplacement ? (
								<label css={{ display: 'grid', gap: spacing.sm }}>
									Your chain is full. Replace an entry
									<select
										css={inputCss}
										value={replace}
										onChange={(event) => setReplace(event.target.value)}
										disabled={busy}
									>
										<option value="">Choose a machine</option>
										{setup?.chain.entries.flatMap((entry) =>
											entry.kind === 'context'
												? [
														<option key={entry.id} value={entry.id}>
															{setup.contexts.find(
																(context) => context.id === entry.id,
															)?.name ?? entry.id}
														</option>,
													]
												: [],
										)}
									</select>
								</label>
							) : null}
							<button
								type="button"
								css={buttonCss}
								disabled={
									busy ||
									(!machine.data?.contextId &&
										!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) ||
									(!target && !!needsReplacement && !replace)
								}
								onClick={() => void registerMachine()}
							>
								{busy
									? 'Registering…'
									: existingContext
										? 'Use this machine’s existing registration'
										: machine.data?.contextId
											? target
												? 'Continue'
												: 'Enable this machine'
											: 'Register this device'}
							</button>
						</>
					) : step === 'attach' && target ? (
						<>
							<p>
								{`${name} will be first in your execution chain in @${target}. It keeps its personal setup, and your other entries in @${target} stay in their current order.`}
							</p>
							{needsReplacement ? (
								<label css={{ display: 'grid', gap: spacing.sm }}>
									Your chain is full. Replace an entry
									<select
										css={inputCss}
										value={replace}
										onChange={(event) => setReplace(event.target.value)}
										disabled={busy}
									>
										<option value="">Choose a machine</option>
										{setup?.chain.entries.flatMap((entry) =>
											entry.kind === 'context'
												? [
														<option key={entry.id} value={entry.id}>
															{setup.contexts.find(
																(context) => context.id === entry.id,
															)?.name ?? entry.id}
														</option>,
													]
												: [],
										)}
									</select>
								</label>
							) : null}
							<button
								type="button"
								css={buttonCss}
								disabled={busy || (!!needsReplacement && !replace)}
								onClick={() => void attachMachine()}
							>
								{busy ? 'Adding…' : `Make available to @${target}`}
							</button>
						</>
					) : (
						<>
							<p>
								This machine is first in your execution chain
								{target ? ` in @${target}` : ''} and its runner is connected.
								You can pause or resume it from Execution contexts.
							</p>
							<button
								type="button"
								css={buttonCss}
								onClick={() => setOpened(false)}
							>
								Done
							</button>
						</>
					)}
					{error ? <p role="alert">{error}</p> : null}
					{step !== 'done' && step !== 'forget' ? (
						<button
							type="button"
							css={{ ...secondaryCss, marginLeft: spacing.sm }}
							disabled={busy}
							onClick={() => void close()}
						>
							Not now
						</button>
					) : null}
				</dialog>
			) : null}
		</DesktopMachineContext>
	)
}

export function useDesktopMachine() {
	return useContext(DesktopMachineContext)
}

/** `orgSlug`: the team org this page is for, if not the personal workspace. */
export function DesktopMachinePanel({
	orgSlug: selectedOrgSlug = null,
}: {
	orgSlug?: string | null
} = {}) {
	const machine = useDesktopMachine()
	const contextId = machine?.state?.contextId
	const commands = useRef(machine?.commands)
	commands.current = machine?.commands
	useEffect(() => {
		if (!contextId) return
		void commands.current?.('status')
		const interval = setInterval(() => void commands.current?.('status'), 15000)
		return () => clearInterval(interval)
	}, [contextId])
	const orgSlug = machine?.orgSlug ?? null
	const loadPage = useServerFn(loadExecutionContextsPage)
	const daemonAction = useServerFn(runExecutionContextDaemonAction)
	const server = useQuery({
		queryKey: ['desktop-machine-server', orgSlug, contextId],
		queryFn: async () => {
			const page = await loadPage({ data: { orgSlug: orgSlug!, search: [] } })
			return page.payload.enabled
				? (page.payload.contexts.find((context) => context.id === contextId) ??
						null)
				: null
		},
		enabled: Boolean(orgSlug && contextId),
		refetchInterval: 15000,
		retry: false,
	})
	const [routingBusy, setRoutingBusy] = useState(false)
	const [routingError, setRoutingError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [logLines, setLogLines] = useState<Array<string> | null>(null)
	async function daemon(action: DesktopMachineMenuCommand) {
		if (!orgSlug || !contextId) return
		setRoutingBusy(true)
		setRoutingError(null)
		setNotice(null)
		try {
			const result = (await daemonAction({
				data: { orgSlug, contextId, action },
			})) as
				| { ok: true; message: string | null; lines: Array<string> | null }
				| { ok: false; message?: string }
			if (!result.ok)
				setRoutingError(result.message ?? `Could not ${action} this machine.`)
			else if (action === 'logs') setLogLines(result.lines ?? [])
			else if (action === 'update') setNotice(result.message)
		} catch (error) {
			setRoutingError(error instanceof Error ? error.message : String(error))
		} finally {
			setRoutingBusy(false)
			await server.refetch()
		}
	}
	const menuCommand = machine?.menuCommand ?? null
	const clearMenuCommand = machine?.clearMenuCommand
	const serverReady = server.isFetched
	const daemonRef = useRef(daemon)
	daemonRef.current = daemon
	useEffect(() => {
		if (!menuCommand || !serverReady) return
		clearMenuCommand?.()
		void daemonRef.current(menuCommand)
	}, [menuCommand, serverReady, clearMenuCommand])
	if (!machine) return null
	const state = machine.state
	const serverContext = server.data ?? null
	const pausedInKody = serverContext?.paused ?? null
	const panelAction = desktopSetupPanelAction({
		state,
		needsAccountOnboarding: machine.needsAccountOnboarding,
	})
	return (
		<section
			aria-labelledby="desktop-machine-heading"
			css={{
				padding: spacing.lg,
				marginBottom: spacing.lg,
				border: `1px solid ${colors.border}`,
				borderRadius: radius.md,
			}}
		>
			<h2 id="desktop-machine-heading" css={{ marginTop: 0 }}>
				This machine
			</h2>
			{!state ? (
				<p>Checking this machine…</p>
			) : !state.supported ? (
				<p>Local execution is not available on this platform.</p>
			) : state.blocked ? (
				<p>
					This app manages a registration for another workspace. Switch to that
					account to manage it.
				</p>
			) : (
				<>
					<p>
						{state.name}
						{state.contextId
							? pausedInKody
								? ` · Runner paused${pausedInKody.by ? ` by @${pausedInKody.by}` : ''}`
								: state.runner?.label
									? ` · ${state.runner.label}`
									: state.running
										? ' · Runner running'
										: ' · Runner paused'
							: state.existingContext
								? ' · Registered with the kody CLI'
								: state.cliReady
									? ' · Signed in · Setup incomplete'
									: ' · Not set up'}
					</p>
					{state.runner?.mode === 'service' ||
					state.runner?.mode === 'external' ||
					(!state.contextId && state.existingContext) ? (
						<p css={{ color: colors.textMuted }}>
							{oneRunnerCopy}{' '}
							{state.runner?.mode === 'external'
								? 'It was started with `kody daemon` outside this app.'
								: 'The CLI installed a background service (`kody daemon install`), so this app controls that service instead of starting a second runner.'}
						</p>
					) : null}
					{state.contextId ? (
						<button
							type="button"
							css={buttonCss}
							disabled={state.busy}
							onClick={() => void machine.toggle()}
						>
							{state.running ? 'Pause execution' : 'Resume execution'}
						</button>
					) : null}
					{pausedInKody ? (
						<p
							data-testid="desktop-machine-paused"
							css={{
								color: colors.textMuted,
								borderLeft: `3px solid ${colors.warning}`,
								paddingLeft: spacing.sm,
							}}
						>
							Paused in Kody
							{pausedInKody.reason ? `: ${pausedInKody.reason}` : ''}. Chains
							skip this machine and host commands are refused until it is
							resumed. The runner stays connected.
						</p>
					) : null}
					{serverContext &&
					(pausedInKody ? serverContext.canResume : serverContext.canPause) ? (
						<button
							type="button"
							css={{ ...secondaryCss, marginLeft: spacing.sm }}
							disabled={state.busy || routingBusy}
							onClick={() => void daemon(pausedInKody ? 'resume' : 'pause')}
							data-testid="desktop-machine-routing"
						>
							{routingBusy
								? pausedInKody
									? 'Resuming…'
									: 'Pausing…'
								: pausedInKody
									? 'Resume routing'
									: 'Pause routing'}
						</button>
					) : null}
					{state.contextId && state.runner?.canRestart && machine.restart ? (
						<button
							type="button"
							css={{ ...secondaryCss, marginLeft: spacing.sm }}
							disabled={state.busy}
							onClick={() => void machine.restart?.()}
						>
							Restart runner
						</button>
					) : null}
					{serverContext?.canControlDaemon &&
					serverContext.status === 'online' ? (
						<button
							type="button"
							css={{ ...secondaryCss, marginLeft: spacing.sm }}
							disabled={state.busy || routingBusy}
							onClick={() => void daemon('update')}
							data-testid="desktop-machine-update"
						>
							Update runner now
						</button>
					) : null}
					{serverContext?.canReadDaemonLogs ? (
						<button
							type="button"
							css={{ ...secondaryCss, marginLeft: spacing.sm }}
							disabled={routingBusy}
							onClick={() => void daemon('logs')}
							data-testid="desktop-machine-logs"
						>
							{logLines ? 'Refresh runner log' : 'Show runner log'}
						</button>
					) : null}
					{notice ? <p role="status">{notice}</p> : null}
					{logLines ? (
						<pre
							data-testid="desktop-machine-log"
							css={{
								maxHeight: '16rem',
								overflow: 'auto',
								padding: spacing.sm,
								background: colors.surface,
								border: `1px solid ${colors.border}`,
								borderRadius: radius.sm,
								fontSize: '0.8125rem',
								whiteSpace: 'pre-wrap',
							}}
						>
							{logLines.length ? logLines.join('\n') : 'No log lines yet.'}
						</pre>
					) : null}
					{panelAction.kind === 'unavailable' ? (
						<p
							data-testid="desktop-setup-unavailable"
							css={{ color: colors.textMuted }}
						>
							{panelAction.reason}
						</p>
					) : null}
					<button
						type="button"
						css={{ ...buttonCss, marginLeft: state.contextId ? spacing.sm : 0 }}
						disabled={state.busy || panelAction.kind === 'unavailable'}
						onClick={() => machine.open(selectedOrgSlug)}
					>
						{panelAction.label}
					</button>
					{typeof state.autoUpdate === 'boolean' && machine.autoUpdate ? (
						<p>
							Automatic runner updates: {state.autoUpdate ? 'On' : 'Off'}{' '}
							<button
								type="button"
								css={{ ...secondaryCss, marginLeft: spacing.sm }}
								disabled={state.busy}
								onClick={() => void machine.autoUpdate?.(!state.autoUpdate)}
							>
								{state.autoUpdate
									? 'Turn off automatic updates'
									: 'Turn on automatic updates'}
							</button>
						</p>
					) : null}
				</>
			)}
			{state?.contextId && state.supported ? (
				<button
					type="button"
					css={{ ...secondaryCss, marginLeft: spacing.sm }}
					disabled={state.busy || state.commandsEnabled === null}
					onClick={() =>
						void machine.commands(state.commandsEnabled ? 'off' : 'on')
					}
				>
					{state.commandsEnabled
						? 'Turn off host commands'
						: 'Allow host commands'}
				</button>
			) : null}
			{state?.hasSetup ? (
				<button
					type="button"
					css={{ ...secondaryCss, marginLeft: spacing.sm }}
					disabled={state.busy}
					onClick={machine.forget}
				>
					Forget desktop setup
				</button>
			) : null}
			{machine.error ? <p role="alert">{machine.error}</p> : null}
			{routingError ? <p role="alert">{routingError}</p> : null}
		</section>
	)
}
