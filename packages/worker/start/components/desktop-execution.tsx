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
	type DesktopExecutionBridge,
	type DesktopExecutionState,
} from '../desktop-shell.ts'
import { onboardingQuery } from '../onboarding-query.ts'

const DesktopMachineContext = createContext<null | {
	state: DesktopExecutionState | undefined
	commands: (action: 'status' | 'on' | 'off') => Promise<void>
	forget: () => void
	open: () => void
	toggle: () => Promise<void>
	restart: (() => Promise<void>) | null
	autoUpdate: ((enabled: boolean) => Promise<void>) | null
	error: string | null
}>(null)

const oneRunnerCopy =
	'One runner per machine: this app and the kody CLI share this machine’s registration and its runner.'

type SetupData = Extract<ExecutionContextsPageData, { enabled: true }>
const buttonCss = getPillButtonCss({ size: 'sm' })
const secondaryCss = getGhostButtonCss({ size: 'sm' })

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
	const [step, setStep] = useState<'intro' | 'machine' | 'done' | 'forget'>(
		'intro',
	)
	const [name, setName] = useState('')
	const [replace, setReplace] = useState('')
	const [setup, setSetup] = useState<SetupData | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const dialog = useRef<HTMLDialogElement>(null)
	const client = useQueryClient()
	const router = useRouter()
	const enable = useServerFn(setExperiment)
	const loadSetup = useServerFn(loadExecutionContextsPage)
	const putFirst = useServerFn(putDesktopExecutionFirst)
	useEffect(() => {
		setBridge(window.kodyDesktop?.execution ?? null)
	}, [])
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
	async function prepare() {
		if (!bridge || !orgSlug) return
		await run(async () => {
			await enable({
				data: { experiment: 'execution-contexts', enabled: true },
			})
			const signedIn = machine.data?.cliReady
				? machine.data
				: await bridge.signIn()
			client.setQueryData(['desktop-machine', actorKey], signedIn)
			const page = await loadSetup({ data: { orgSlug, search: [] } })
			if (!page.payload.enabled)
				throw new Error('Execution contexts could not be enabled. Try again.')
			setSetup(page.payload)
			setReplace('')
			setStep('machine')
		})
	}
	async function connect() {
		if (!bridge || !orgSlug || !username) return
		await run(async () => {
			const registered = await bridge.connect(name)
			client.setQueryData(['desktop-machine', actorKey], registered)
			if (!registered.contextId)
				throw new Error('The machine could not be registered. Try again.')
			try {
				await putFirst({
					data: {
						orgSlug,
						username,
						contextId: registered.contextId,
						...(needsReplacement && replace
							? { replaceContextId: replace }
							: {}),
					},
				})
			} catch (error) {
				const current = await loadSetup({ data: { orgSlug, search: [] } })
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
						setStep('forget')
						setOpened(true)
					},
					error: error ?? machine.data?.error ?? machine.error?.message ?? null,
					open: () => {
						setError(null)
						setStep('intro')
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
						{step === 'forget'
							? 'Forget desktop setup?'
							: step === 'done'
								? 'This machine is ready'
								: step === 'machine'
									? 'Enable this machine'
									: 'Run Kody on this machine'}
					</h2>
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
										setStep('intro')
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
					) : step === 'intro' ? (
						<>
							<p>
								Kody can run work here while the desktop app is open.{' '}
								{machine.data?.platform === 'darwin'
									? 'Closing the window keeps it available; quitting stops it.'
									: 'Quitting stops execution.'}
							</p>
							<p>
								Local folders require separate permission. Your cloud
								credentials stay in Kody cloud.
							</p>
							<button
								type="button"
								css={buttonCss}
								disabled={busy}
								onClick={() => void prepare()}
							>
								{busy ? 'Opening browser…' : 'Continue in browser'}
							</button>
						</>
					) : step === 'machine' ? (
						<>
							{existingContext ? (
								<p>
									The kody CLI already registered this machine
									{existingContext.name ? ` as ${existingContext.name}` : ''}.
									This app uses that registration and its runner instead of
									creating a second one. {oneRunnerCopy}
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
							<p>
								This machine will be first in your personal execution chain.
								Your other entries and cloud fallback settings stay in their
								current order.
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
								disabled={
									busy ||
									!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ||
									(!!needsReplacement && !replace)
								}
								onClick={() => void connect()}
							>
								{busy
									? 'Enabling…'
									: existingContext
										? 'Use this machine’s existing registration'
										: 'Enable this machine'}
							</button>
						</>
					) : (
						<>
							<p>
								This machine is first in your execution chain. You can pause or
								resume it from Execution contexts.
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

export function DesktopMachinePanel() {
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
	if (!machine) return null
	const state = machine.state
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
				<p>Local execution is not available on Windows in this version.</p>
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
							? state.runner?.label
								? ` · ${state.runner.label}`
								: state.running
									? ' · Runner running'
									: ' · Runner paused'
							: state.existingContext
								? ' · Registered with the kody CLI'
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
					<button
						type="button"
						css={{ ...buttonCss, marginLeft: state.contextId ? spacing.sm : 0 }}
						disabled={state.busy}
						onClick={machine.open}
					>
						{state.contextId
							? 'Manage setup'
							: state.needsVerification
								? 'Verify this machine'
								: state.existingContext
									? 'Use this machine’s existing registration'
									: 'Set up this machine'}
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
		</section>
	)
}
