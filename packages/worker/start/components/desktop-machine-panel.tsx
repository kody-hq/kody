/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { Badge } from './badge.tsx'
import { Button } from './button.tsx'
import { Switch } from './choice-controls.tsx'
import { renderIcon } from './icon.tsx'
import {
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
} from './menu.tsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import {
	loadExecutionContextsPage,
	runExecutionContextDaemonAction,
} from '#start/server/execution-contexts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { desktopSetupPanelAction } from '#universal/desktop-setup-stages.ts'
import type {
	DesktopExecutionState,
	DesktopMachineMenuCommand,
} from '../desktop-shell.ts'
import { oneRunnerCopy, useDesktopMachine } from './desktop-execution.tsx'

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
	useQuery({
		queryKey: ['desktop-machine-status-poll', contextId],
		queryFn: async () => {
			await commands.current?.('status')
			return true
		},
		enabled: Boolean(contextId),
		refetchInterval: 15000,
		refetchIntervalInBackground: true,
		refetchOnWindowFocus: false,
		retry: false,
		gcTime: 0,
	})
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
	const ready = Boolean(state?.supported && !state.blocked)
	const status = machineStatus(state, pausedInKody)
	const online = serverContext?.status === 'online'
	const canUpdate = ready && Boolean(serverContext?.canControlDaemon) && online
	const canReadLogs = ready && Boolean(serverContext?.canReadDaemonLogs)
	const canManage = ready && panelAction.kind === 'manage'
	const canForget = Boolean(state?.hasSetup)
	const canRoute = pausedInKody
		? serverContext?.canResume === true
		: serverContext?.canPause === true
	const showRouting =
		ready && Boolean(serverContext) && (canRoute || !!pausedInKody)
	const showCommands = Boolean(state?.contextId && state.supported)
	const showAutoUpdate =
		ready && typeof state?.autoUpdate === 'boolean' && !!machine.autoUpdate
	const runnerMode = state?.runner?.mode
	const showFooter =
		ready &&
		(runnerMode === 'service' ||
			runnerMode === 'external' ||
			(!state?.contextId && !!state?.existingContext))
	return (
		<section
			aria-label="This machine"
			data-testid="desktop-machine"
			css={{
				marginBottom: spacing.lg,
				background: colors.surface,
				border: `1px solid ${colors.border}`,
				borderRadius: radius.lg,
				boxShadow: shadows.sm,
			}}
		>
			<div css={headCss}>
				<div
					css={{
						display: 'flex',
						alignItems: 'center',
						gap: spacing.md,
						minWidth: 0,
					}}
				>
					<span aria-hidden="true" css={iconWellCss}>
						{renderIcon('monitor', { size: '1.375rem' })}
					</span>
					<div css={{ minWidth: 0 }}>
						<h2 id="desktop-machine-heading" css={nameCss}>
							{state?.name || 'This machine'}
							{state?.name ? <Badge>This machine</Badge> : null}
						</h2>
						<p
							data-testid="desktop-machine-status"
							title={state?.runner?.label || undefined}
							css={statusCss}
						>
							{status.tone ? (
								<span aria-hidden="true" css={dotCss(status.tone)} />
							) : null}
							{status.label}
						</p>
					</div>
				</div>
				<div css={actionsCss}>
					{ready && state?.contextId ? (
						<Button
							type="button"
							variant="secondary"
							disabled={state.busy}
							onClick={() => void machine.toggle()}
						>
							{state.running ? 'Pause' : 'Resume'}
						</Button>
					) : null}
					{ready &&
					state?.contextId &&
					state.runner?.canRestart &&
					machine.restart ? (
						<Button
							type="button"
							variant="secondary"
							disabled={state.busy}
							onClick={() => void machine.restart?.()}
						>
							Restart
						</Button>
					) : null}
					{ready && !canManage ? (
						<Button
							type="button"
							variant="primary"
							disabled={state?.busy || panelAction.kind === 'unavailable'}
							onClick={() => machine.open(selectedOrgSlug)}
						>
							{panelAction.label}
						</Button>
					) : null}
					{canReadLogs || canUpdate || canManage || canForget ? (
						<Menu>
							<MenuTrigger
								render={
									<Button
										variant="secondary"
										iconOnly
										aria-label="More actions for this machine"
										data-testid="desktop-machine-more"
									/>
								}
							>
								{renderIcon('dots-horizontal', { size: '1.25rem' })}
							</MenuTrigger>
							<MenuContent
								align="end"
								aria-label="Machine actions"
								css={{ minWidth: '14rem' }}
							>
								{canReadLogs ? (
									<MenuItem
										disabled={routingBusy}
										onClick={() => void daemon('logs')}
										data-testid="desktop-machine-logs"
									>
										{logLines ? 'Refresh runner log' : 'Show runner log'}
									</MenuItem>
								) : null}
								{canUpdate ? (
									<MenuItem
										disabled={state?.busy || routingBusy}
										onClick={() => void daemon('update')}
										data-testid="desktop-machine-update"
									>
										Update runner now
									</MenuItem>
								) : null}
								{canManage ? (
									<MenuItem
										disabled={state?.busy}
										onClick={() => machine.open(selectedOrgSlug)}
									>
										{panelAction.label}
									</MenuItem>
								) : null}
								{canForget ? (
									<>
										{canReadLogs || canUpdate || canManage ? (
											<MenuSeparator />
										) : null}
										<MenuItem
											tone="danger"
											disabled={state?.busy}
											onClick={machine.forget}
											data-testid="desktop-machine-forget"
										>
											Forget this machine…
										</MenuItem>
									</>
								) : null}
							</MenuContent>
						</Menu>
					) : null}
				</div>
			</div>
			{showRouting || showCommands || showAutoUpdate ? (
				<div css={{ borderTop: `1px solid ${colors.borderSubtle}` }}>
					{showRouting ? (
						<SettingRow
							id="desktop-machine-routing-label"
							label="Accept new executes"
							description={
								pausedInKody ? (
									<span data-testid="desktop-machine-paused">
										Paused in Kody
										{pausedInKody.reason ? `: ${pausedInKody.reason}` : ''}.
										Chains skip this machine and host commands are refused until
										it is resumed. The runner stays connected.
									</span>
								) : (
									'Turn off to stop routing work here without stopping the runner.'
								)
							}
						>
							<Switch
								aria-labelledby="desktop-machine-routing-label"
								aria-busy={routingBusy}
								checked={!pausedInKody}
								disabled={!canRoute || state?.busy || routingBusy}
								onCheckedChange={() =>
									void daemon(pausedInKody ? 'resume' : 'pause')
								}
								data-testid="desktop-machine-routing"
							/>
						</SettingRow>
					) : null}
					{showCommands && state ? (
						<SettingRow
							id="desktop-machine-commands-label"
							label="Host commands"
							description={`Let packages run commands directly on this ${platformNoun(state.platform)}.`}
						>
							<Switch
								aria-labelledby="desktop-machine-commands-label"
								checked={state.commandsEnabled === true}
								disabled={state.busy || state.commandsEnabled === null}
								onCheckedChange={() =>
									void machine.commands(state.commandsEnabled ? 'off' : 'on')
								}
								data-testid="desktop-machine-commands"
							/>
						</SettingRow>
					) : null}
					{showAutoUpdate && state ? (
						<SettingRow
							id="desktop-machine-auto-update-label"
							label="Automatic updates"
							description={autoUpdateCopy(
								state.autoUpdate === true,
								serverContext,
							)}
						>
							{canUpdate ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={state.busy || routingBusy}
									onClick={() => void daemon('update')}
									data-testid="desktop-machine-update-now"
								>
									Update now
								</Button>
							) : null}
							<Switch
								aria-labelledby="desktop-machine-auto-update-label"
								checked={state.autoUpdate === true}
								disabled={state.busy}
								onCheckedChange={(enabled) =>
									void machine.autoUpdate?.(enabled)
								}
								data-testid="desktop-machine-auto-update"
							/>
						</SettingRow>
					) : null}
				</div>
			) : null}
			{(ready && panelAction.kind === 'unavailable') ||
			notice ||
			logLines ||
			machine.error ||
			routingError ? (
				<div
					css={{
						display: 'grid',
						gap: spacing.sm,
						padding: `${spacing.md} ${spacing.lg}`,
						borderTop: `1px solid ${colors.borderSubtle}`,
						'& > p': { margin: 0 },
					}}
				>
					{ready && panelAction.kind === 'unavailable' ? (
						<p
							data-testid="desktop-setup-unavailable"
							css={{ color: colors.textMuted }}
						>
							{panelAction.reason}
						</p>
					) : null}
					{notice ? <p role="status">{notice}</p> : null}
					{logLines ? (
						<pre
							data-testid="desktop-machine-log"
							css={{
								margin: 0,
								maxHeight: '16rem',
								overflow: 'auto',
								padding: spacing.sm,
								background: colors.background,
								border: `1px solid ${colors.border}`,
								borderRadius: radius.sm,
								fontSize: '0.8125rem',
								whiteSpace: 'pre-wrap',
							}}
						>
							{logLines.length ? logLines.join('\n') : 'No log lines yet.'}
						</pre>
					) : null}
					{machine.error ? <p role="alert">{machine.error}</p> : null}
					{routingError ? <p role="alert">{routingError}</p> : null}
				</div>
			) : null}
			{showFooter ? (
				<p data-testid="desktop-machine-runner-note" css={footerCss}>
					{runnerMode === 'external' ? (
						<>
							{oneRunnerCopy} It was started with <code>kody daemon</code>{' '}
							outside this app.
						</>
					) : (
						<>
							Runs as a background service installed by{' '}
							<code>kody daemon install</code>. This app controls it, so there's
							only one runner per machine.
						</>
					)}
				</p>
			) : null}
		</section>
	)
}

type StatusTone = 'ok' | 'warning' | 'idle'

function machineStatus(
	state: DesktopExecutionState | undefined,
	pausedInKody: { by?: string | null } | null,
): { label: string; tone: StatusTone | null } {
	if (!state) return { label: 'Checking this machine…', tone: null }
	if (!state.supported)
		return {
			label: 'Local execution is not available on this platform.',
			tone: null,
		}
	if (state.blocked)
		return {
			label:
				'This app manages a registration for another workspace. Switch to that account to manage it.',
			tone: null,
		}
	if (state.contextId) {
		if (pausedInKody)
			return {
				label: `Paused in Kody${pausedInKody.by ? ` by @${pausedInKody.by}` : ''}`,
				tone: 'warning',
			}
		if (state.running)
			return {
				label:
					state.runner?.mode === 'service' || state.runner?.mode === 'external'
						? 'Running · shared with the kody CLI'
						: 'Running',
				tone: 'ok',
			}
		return { label: state.runner?.label || 'Runner paused', tone: 'idle' }
	}
	if (state.existingContext)
		return { label: 'Registered with the kody CLI', tone: 'idle' }
	if (state.cliReady)
		return { label: 'Signed in · Setup incomplete', tone: 'idle' }
	return { label: 'Not set up', tone: 'idle' }
}

function platformNoun(platform: string) {
	if (platform === 'darwin') return 'Mac'
	if (platform === 'win32') return 'PC'
	return 'machine'
}

function autoUpdateCopy(
	enabled: boolean,
	context: {
		client?: {
			version?: string | null
			outdated?: boolean
			latestVersion?: string | null
		} | null
	} | null,
) {
	const client = context?.client
	if (client?.outdated && client.latestVersion)
		return `Outdated: ${client.latestVersion} is out.`
	if (client?.version)
		return client.latestVersion
			? 'Runner is up to date.'
			: "Couldn't check for updates."
	return `Automatic runner updates are ${enabled ? 'on' : 'off'}.`
}

function SettingRow({
	id,
	label,
	description,
	children,
}: {
	id: string
	label: string
	description: ReactNode
	children: ReactNode
}) {
	return (
		<div
			css={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: spacing.md,
				padding: `${spacing.md} ${spacing.lg}`,
				'& + &': { borderTop: `1px solid ${colors.borderSubtle}` },
			}}
		>
			<div css={{ minWidth: 0 }}>
				<p id={id} css={{ margin: 0, fontWeight: 600 }}>
					{label}
				</p>
				<p
					css={{
						margin: 0,
						color: colors.textMuted,
						fontSize: typography.fontSize.sm,
					}}
				>
					{description}
				</p>
			</div>
			<div
				css={{
					display: 'flex',
					alignItems: 'center',
					gap: spacing.md,
					flex: 'none',
				}}
			>
				{children}
			</div>
		</div>
	)
}

const headCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.md,
	padding: `${spacing.lg} ${spacing.lg} ${spacing.md}`,
})

const iconWellCss = css({
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flex: 'none',
	width: '2.5rem',
	height: '2.5rem',
	borderRadius: radius.md,
	background: colors.primarySoft,
	color: colors.primaryText,
})

const nameCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'center',
	gap: spacing.sm,
	margin: 0,
	fontSize: typography.fontSize.lg,
	overflowWrap: 'anywhere',
})

const statusCss = css({
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	margin: '0.2rem 0 0',
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
})

const toneColor: Record<StatusTone, string> = {
	ok: colors.primary,
	warning: colors.warning,
	idle: colors.textMuted,
}

function dotCss(tone: StatusTone) {
	return css({
		flex: 'none',
		width: '0.5rem',
		height: '0.5rem',
		borderRadius: radius.full,
		background: toneColor[tone],
		boxShadow: `0 0 0 3px color-mix(in srgb, ${toneColor[tone]} 20%, transparent)`,
	})
}

const actionsCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'center',
	gap: spacing.sm,
})

const footerCss = css({
	margin: 0,
	padding: `${spacing.md} ${spacing.lg}`,
	borderTop: `1px solid ${colors.borderSubtle}`,
	background: colors.background,
	borderRadius: `0 0 ${radius.lg} ${radius.lg}`,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
})
