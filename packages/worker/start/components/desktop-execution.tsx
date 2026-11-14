/** @jsxImportSource @emotion/react */
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import {
	useCallback,
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { useActor } from '@xstate/react'
import { desktopSetupStepState } from '#universal/desktop-setup-step-state.ts'
import {
	desktopSetupOperationState,
	type DesktopSetupOperation,
} from '#client/routes/desktop-setup-operation-state.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
	desktopSetupContextFirst,
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

export const oneRunnerCopy =
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
	const [wizardSnapshot, , wizardActor] = useActor(desktopSetupStepState)
	const wizard = uiState<{
		status: DesktopSetupWizardStep
	}>(wizardSnapshot)
	const transitionStep = useCallback(
		(event: Parameters<typeof wizardActor.send>[0]) =>
			sendUiEvent(wizardActor, event),
		[wizardActor],
	)

	const step = wizard.status

	const [name, setName] = useState('')
	const [replace, setReplace] = useState('')
	const [setup, setSetup] = useState<SetupData | null>(null)
	// Team org this machine should become available to after personal registration.
	const [target, setTarget] = useState<string | null>(null)
	const [attached, setAttached] = useState(false)
	const [operationSnapshot, , operationActor] = useActor(
		desktopSetupOperationState,
	)
	const operation = uiState<DesktopSetupOperation>(operationSnapshot)
	const transitionOperation = useCallback(
		(event: Parameters<typeof operationActor.send>[0]) =>
			sendUiEvent(operationActor, event),
		[operationActor],
	)
	const getOperation = useCallback(
		() => uiState<DesktopSetupOperation>(operationActor.getSnapshot()),
		[operationActor],
	)
	const busy = operation.status === 'running'
	const error = operation.status === 'error' ? operation.message : null
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
	const commandsStatus = useMutation({
		mutationFn: () => bridge!.commandsStatus(),
		onSuccess: (result) =>
			client.setQueryData(['desktop-machine', actorKey], result),
	})
	function clearError() {
		if (getOperation().status === 'error')
			transitionOperation({
				type: 'DISMISS',
				data: uiContext({ status: 'idle' }).data,
			} as Parameters<typeof operationActor.send>[0])
		commandsStatus.reset()
	}
	async function run(action: () => Promise<void>) {
		if (
			!transitionOperation({
				type: 'SUBMIT',
				data: uiContext({ status: 'running' }).data,
			} as Parameters<typeof operationActor.send>[0])
		)
			return
		commandsStatus.reset()
		try {
			try {
				await action()
			} finally {
				await refresh()
			}
			transitionOperation({
				type: 'RESPONSE_OK',
				data: uiContext({ status: 'idle' }).data,
			} as Parameters<typeof operationActor.send>[0])
		} catch (error) {
			transitionOperation({
				type: 'RESPONSE_ERROR',
				data: uiContext({
					status: 'error',
					message: error instanceof Error ? error.message : String(error),
				}).data,
			} as Parameters<typeof operationActor.send>[0])
		}
	}

	async function close() {
		if (!bridge || getOperation().status === 'running') return
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
	const inChain = desktopSetupContextFirst(
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
			const first = desktopSetupContextFirst(
				page.payload.chain.entries,
				signedIn?.contextId ?? null,
			)
			const next = desktopSetupResumeStep({
				targetOrgSlug: target,
				cliReady: !!signedIn?.cliReady,
				contextId: signedIn?.contextId ?? null,
				running: !!signedIn?.running,
				attached,
				inChain: first,
			})
			// After sign-in, overview means registration is still open.
			switch (next) {
				case 'overview':
				case 'register':
					transitionStep({ type: 'REGISTER', data: {} })
					break
				case 'attach':
					transitionStep({ type: 'ATTACH', data: {} })
					break
				case 'done':
					transitionStep({ type: 'COMPLETE', data: {} })
					break
				case 'forget':
					transitionStep({ type: 'FORGET', data: {} })
					break
			}
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
					const first = desktopSetupContextFirst(
						setup?.chain.entries,
						registered.contextId,
					)
					if (first || attached) {
						// Already first on the team chain; runner start was the missing piece.
					} else {
						// Team destination: keep personal registration, attach next.
						transitionStep({ type: 'ATTACH', data: {} })
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
			transitionStep({ type: 'COMPLETE', data: {} })
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
			transitionStep({ type: 'COMPLETE', data: {} })
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
							await commandsStatus.mutateAsync().catch(() => undefined)
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
						clearError()
						setTarget(null)
						setAttached(false)
						transitionStep({ type: 'FORGET', data: {} })
						setOpened(true)
					},
					error:
						error ??
						commandsStatus.error?.message ??
						(busy ? null : (machine.data?.error ?? machine.error?.message)) ??
						null,
					open: (targetOrgSlug?: string | null) => {
						clearError()
						setAttached(false)
						setTarget(targetOrgSlug ?? null)
						// Drop any prior org's chain snapshot so overview stages do not
						// treat personal membership as team attach (or the reverse).
						setSetup(null)
						setReplace('')
						// Always start on overview so Continue/Resume loads setup, then
						// advances to the first incomplete stage.
						transitionStep({ type: 'RESET', data: {} })
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
					aria-busy={busy}
					ref={dialog}
					aria-labelledby="desktop-execution-title"
					onCancel={(event) => {
						event.preventDefault()
						if (step === 'forget') {
							if (getOperation().status !== 'running') setOpened(false)
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
										transitionStep({ type: 'RESET', data: {} })
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
										: bridge?.approvesInApp
											? 'Waiting for approval…'
											: 'Opening browser…'
									: machine.data?.cliReady || machine.data?.contextId
										? 'Resume setup'
										: bridge?.approvesInApp
											? 'Continue to approve'
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
