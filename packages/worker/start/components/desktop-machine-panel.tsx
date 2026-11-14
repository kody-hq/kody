/** @jsxImportSource @emotion/react */
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import {
	loadExecutionContextsPage,
	runExecutionContextDaemonAction,
} from '#start/server/execution-contexts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import { desktopSetupPanelAction } from '#universal/desktop-setup-stages.ts'
import type { DesktopMachineMenuCommand } from '../desktop-shell.ts'
import { oneRunnerCopy, useDesktopMachine } from './desktop-execution.tsx'

const buttonCss = getPillButtonCss({ size: 'sm' })
const secondaryCss = getGhostButtonCss({ size: 'sm' })

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
