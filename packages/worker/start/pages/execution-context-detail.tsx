/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useQuery } from '@tanstack/react-query'
import { useRefreshExecutionContextsPage } from '../execution-contexts-query.ts'
import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { orgResourcePath } from '#universal/org-pages.ts'
import {
	cancelExecutionContextRun,
	deleteExecutionContext,
	dismissExecutionContextNotice,
	loadExecutionContextAudit,
	previewExecutionContextShare,
	loadExecutionContextRuns,
	optIntoExecutionContext,
	optOutOfExecutionContext,
	removeExecutionContextShare,
	runExecutionContextDaemonAction,
	setExecutionChain,
	shareExecutionContext,
	turnOffExecutionContextCommands,
} from '#start/server/execution-contexts'
import {
	optInCopy,
	presetLabels,
	shareCopy,
	stopSharingConfirm,
} from '#universal/execution-context-trust-copy.ts'
import {
	type ExecutionChain,
	type ExecutionContextAuditPage,
	type ExecutionContextListItem,
	type ExecutionContextPreset,
	type ExecutionContextRunPage,
	type ExecutionContextShareGrant,
	auditEventLabel,
	canOptIntoContext,
	chainEntryInputs,
	chainHasCloud,
	chainIsFull,
	chainPosition,
	commandAuditSummary,
	contextDisplayStatus,
	daemonRunsAsLabel,
	displayStatusLabel,
	durationLabel,
	grantSummaryDetail,
	insertBeforeCloud,
	loginPredatesPermissionsMessage,
	ordinal,
	runFallbackLabel,
	runOutcomeLabels,
	sharingSummary,
	unusableReasonCopy,
} from '#universal/execution-contexts.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
import { UndoToast } from '../components/undo-toast.tsx'
import { useUndoableAction } from '../components/use-undoable-action.ts'
import {
	AccountManagementMessage,
	accountInputCss,
} from './account-management-components.tsx'
import { selectCss } from './package-collaborators-parts.tsx'
import { recordBodyCss } from './record-table.tsx'
import {
	formatTimestamp,
	formatTimestampDate,
} from '../components/local-timestamp.tsx'

const sectionCss = css({ display: 'grid', gap: spacing.sm })
const mutedCss = css({ color: colors.textMuted, margin: 0 })
const dlCss = css({
	display: 'grid',
	gridTemplateColumns: 'max-content minmax(0, 1fr)',
	gap: `${spacing.xs} ${spacing.md}`,
	margin: 0,
	'& dd': { margin: 0, overflowWrap: 'anywhere' },
	'@container (max-width: 480px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
})
const dialogCss = css({
	maxWidth: 'min(36rem, calc(100vw - 2rem))',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	background: colors.surface,
	color: colors.text,
	padding: spacing.lg,
	'&::backdrop': { background: 'rgba(0, 0, 0, 0.45)' },
})
const tableCss = css({
	width: '100%',
	borderCollapse: 'collapse',
	'& th, & td': {
		textAlign: 'left',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.borderSubtle}`,
	},
})
const target = css({ minHeight: 44 })

type Failure = { ok: false; error: string; message: string }

const unexpectedErrorText = 'Something went wrong. Try again.'
const unexpectedFailure: Failure = {
	ok: false,
	error: 'unexpected',
	message: unexpectedErrorText,
}

function failureText(result: Failure) {
	return result.error === 'credential_scope'
		? loginPredatesPermissionsMessage
		: result.message
}

const allMembersKey = 'all-members'

function subjectLabel(grant: ExecutionContextShareGrant) {
	return grant.subject.kind === 'user'
		? `@${grant.subject.handle}`
		: `team ${grant.subject.slug}`
}

export function ExecutionContextDetail(props: {
	orgSlug: string
	context: ExecutionContextListItem
	chain: ExecutionChain
	contexts: ReadonlyArray<ExecutionContextListItem>
}) {
	const { context, orgSlug } = props
	const refresh = useRefreshExecutionContextsPage()
	const status = contextDisplayStatus(context)
	const position = chainPosition(props.chain.entries, context.id)
	const nameForId = (id: string) =>
		props.contexts.find((item) => item.id === id)?.name
	return (
		<div
			data-testid="execution-context-detail"
			css={{
				...recordBodyCss,
				display: 'grid',
				gap: spacing.lg,
				containerType: 'inline-size',
			}}
		>
			<dl css={dlCss}>
				<dt>Status</dt>
				<dd data-testid="context-status">
					{displayStatusLabel(status)}
					{context.status === 'revoked' && context.revokedAt ? (
						<>, {formatTimestampDate(context.revokedAt)}</>
					) : context.lastSeenAt && status === 'offline' ? (
						<>, last seen {formatTimestamp(context.lastSeenAt)}</>
					) : null}
				</dd>
				<dt>Operator</dt>
				<dd>{context.isOperator ? 'You' : `@${context.operator.handle}`}</dd>
				<dt>Owned by</dt>
				<dd>@{context.ownerOrg.slug}</dd>
				<dt>Chains</dt>
				<dd data-testid="context-chain-usage">
					{context.chainUsage.chainCount === 0
						? 'Not in any chain'
						: position !== null
							? `${ordinal(position)} in your chain`
							: 'Not in your chain'}
				</dd>
				<dt>Exposes</dt>
				<dd>{grantSummaryDetail(context.grantSummary)}</dd>
				{context.client?.version ? (
					<>
						<dt>Daemon</dt>
						<dd data-testid="context-daemon-version">
							{context.client.name} {context.client.version}
							{context.client.outdated && context.client.latestVersion ? (
								<span css={outdatedCss} data-testid="context-daemon-outdated">
									Outdated: {context.client.latestVersion} is out. Run{' '}
									<code>kody update</code> on the machine
								</span>
							) : null}
						</dd>
						<dt>Auto-update</dt>
						<dd data-testid="context-daemon-auto-update">
							{context.capabilities?.autoUpdate === 'on'
								? 'On'
								: context.capabilities?.autoUpdate === 'off'
									? 'Off'
									: 'Not reported'}
							{context.isOperator && context.status !== 'revoked' ? (
								<span css={hintCss}>
									{context.capabilities?.autoUpdate === 'on' ? (
										<>
											Moves onto new CLI versions after runs finish. Turn it off
											on the machine with{' '}
											<code>kody daemon auto-update off</code>
										</>
									) : context.capabilities?.autoUpdate === 'off' ? (
										<>
											Turn it on on the machine with{' '}
											<code>kody daemon auto-update on</code>
										</>
									) : (
										<>
											This daemon predates auto-update. Restart it once (or run{' '}
											<code>kody update</code>) and it stays current
										</>
									)}
								</span>
							) : null}
						</dd>
						<dt>Runs as</dt>
						<dd data-testid="context-daemon-service">
							{daemonRunsAsLabel(context.capabilities?.service, context.status)}
							{context.isOperator &&
							!context.capabilities?.service &&
							context.status !== 'revoked' ? (
								<span css={hintCss}>
									{context.status === 'offline' ? (
										<>
											Run{' '}
											<code>kody daemon install --context {context.id}</code> to
											keep it running
										</>
									) : (
										<>
											To keep it running, wait for in-flight runs to finish,
											stop the terminal daemon (Ctrl+C), then run:
											<br />
											<code>kody daemon install --context {context.id}</code>
										</>
									)}
								</span>
							) : null}
						</dd>
					</>
				) : null}
				{context.sharing ? (
					<>
						<dt>Shared with</dt>
						<dd>{sharingSummary(context.sharing, context.ownerOrg.slug)}</dd>
					</>
				) : null}
			</dl>
			{!context.usable && context.unusableReason ? (
				<AccountManagementMessage>
					{unusableReasonCopy({
						reason: context.unusableReason,
						name: context.name,
						operator: context.operator.handle,
						orgSlug,
					})}
				</AccountManagementMessage>
			) : null}
			<NoticesPanel orgSlug={orgSlug} context={context} onChanged={refresh} />
			<DaemonPanel orgSlug={orgSlug} context={context} onChanged={refresh} />
			<CommandsPanel orgSlug={orgSlug} context={context} onChanged={refresh} />
			<OptInControls {...props} onChanged={refresh} />
			{context.sharing ? <SharingPanel {...props} onChanged={refresh} /> : null}
			<RunHistory orgSlug={orgSlug} context={context} nameForId={nameForId} />
			<AuditLog orgSlug={orgSlug} context={context} />
			<DeleteControls orgSlug={orgSlug} context={context} onDeleted={refresh} />
		</div>
	)
}

function DeleteControls(props: {
	orgSlug: string
	context: ExecutionContextListItem
	onDeleted: () => void
}) {
	const { context } = props
	const router = useRouter()
	const dialog = useRef<HTMLDialogElement>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const ownedHere = context.ownerOrg.slug === props.orgSlug
	if (context.status !== 'revoked' || !context.canAddShares || !ownedHere) {
		return null
	}

	async function remove() {
		setBusy(true)
		setError(null)
		const result = (await deleteExecutionContext({
			data: { orgSlug: props.orgSlug, contextId: context.id },
		}).catch(() => unexpectedFailure)) as { ok: true } | Failure
		setBusy(false)
		if (!result.ok) return setError(failureText(result))
		dialog.current?.close()
		await router.navigate({
			to: orgResourcePath(props.orgSlug, 'execution-contexts'),
			resetScroll: false,
		})
		props.onDeleted()
	}

	return (
		<section
			css={sectionCss}
			aria-labelledby="context-delete-title"
			data-testid="context-delete"
		>
			<h3 id="context-delete-title" css={{ margin: 0 }}>
				Delete
			</h3>
			<p css={mutedCss}>
				This context is revoked. Deleting it removes it from this list for good.
				Past runs keep its name in their history.
			</p>
			<div>
				<button
					type="button"
					data-testid="context-delete-open"
					css={[getDangerPillCss({ size: 'sm' }), target]}
					onClick={() => {
						setError(null)
						dialog.current?.showModal()
					}}
				>
					Delete context
				</button>
			</div>
			<dialog
				ref={dialog}
				css={dialogCss}
				aria-labelledby="context-delete-dialog-title"
				data-testid="context-delete-dialog"
			>
				<h2 id="context-delete-dialog-title" css={{ marginTop: 0 }}>
					Delete {context.name}?
				</h2>
				<p>
					This permanently deletes {context.name} and removes it from every
					chain, share and org it was in. You cannot undo this. Past runs still
					show it in their history.
				</p>
				{error ? (
					<AccountManagementMessage tone="error">
						{error}
					</AccountManagementMessage>
				) : null}
				<div css={{ display: 'flex', gap: spacing.sm, justifyContent: 'end' }}>
					<button
						type="button"
						css={[getGhostButtonCss({ size: 'sm' }), target]}
						onClick={() => dialog.current?.close()}
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="context-delete-confirm"
						css={[getDangerPillCss({ size: 'sm' }), target]}
						disabled={busy}
						onClick={() => void remove()}
					>
						{busy ? 'Deleting…' : 'Delete permanently'}
					</button>
				</div>
			</dialog>
		</section>
	)
}

/** Host commands (ADR 0093): shows the machine opt-in and the off switch. */
const misconfigurationText: Record<string, string> = {
	operator_left:
		'The person who runs this machine left the org, so it takes no one else’s runs.',
	login_stale:
		'The login on this machine was revoked or expired. Log the machine in again.',
	profile_inactive:
		'The agent profile this machine is logged in as is revoked or expired.',
	team_deleted: 'The team this machine is for was deleted.',
	personal_login_on_team_context:
		'This machine is for a team but is logged in with a personal account.',
	profile_not_assigned_to_team:
		'This machine is for a team, but its agent profile is not assigned to that team.',
}

function entryText(entry: { permission: string; resource: string | null }) {
	if (entry.permission === 'owner') return 'everything (an org Owner)'
	return entry.resource
		? `${entry.permission} on ${entry.resource}`
		: entry.permission
}

function NoticesPanel(props: {
	orgSlug: string
	context: ExecutionContextListItem
	onChanged: () => void
}) {
	const { context } = props
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const elevation =
		context.elevation && !context.elevation.dismissed ? context.elevation : null
	const misconfigurations = context.misconfigurations ?? []
	const review = context.accessReview ?? []
	if (!elevation && misconfigurations.length === 0 && review.length === 0) {
		return null
	}

	async function dismiss(fingerprint: string) {
		setBusy(true)
		setError(null)
		const result = (await dismissExecutionContextNotice({
			data: { orgSlug: props.orgSlug, contextId: context.id, fingerprint },
		}).catch(() => unexpectedFailure)) as { ok: true } | Failure
		setBusy(false)
		if (!result.ok) return setError(failureText(result))
		props.onChanged()
	}

	return (
		<section
			css={sectionCss}
			data-testid="context-notices"
			aria-label="Notices"
		>
			{misconfigurations.length > 0 ? (
				<div role="alert" data-testid="context-misconfigured">
					<strong>This machine needs fixing</strong>
					<ul css={{ margin: 0 }}>
						{misconfigurations.map((code) => (
							<li key={code}>{misconfigurationText[code] ?? code}</li>
						))}
					</ul>
				</div>
			) : null}
			{elevation ? (
				<div role="status" data-testid="context-elevation">
					<p css={{ margin: 0 }}>
						<strong>
							{context.name} can do {elevation.entries.length} thing
							{elevation.entries.length === 1 ? '' : 's'} you can't.
						</strong>{' '}
						Your runs here use only your own access, but anyone with host access
						on this machine acts with its login.
					</p>
					<ul css={{ margin: 0 }}>
						{elevation.entries.map((entry) => (
							<li key={entryText(entry)}>{entryText(entry)}</li>
						))}
					</ul>
					<button
						type="button"
						css={[getPillButtonCss({ size: 'sm' }), target]}
						disabled={busy}
						onClick={() => void dismiss(elevation.fingerprint)}
					>
						Dismiss
					</button>
				</div>
			) : null}
			{review.length > 0 ? (
				<details data-testid="context-access-review">
					<summary>
						Access review: {review.length}{' '}
						{review.length === 1 ? 'person has' : 'people have'} less access
						than this machine's login
					</summary>
					<ul css={{ margin: 0 }}>
						{review.map((person, index) => (
							<li key={person.handle ?? index}>
								@{person.handle ?? 'unknown'}:{' '}
								{person.entries.map(entryText).join(', ')}
							</li>
						))}
					</ul>
				</details>
			) : null}
			{error ? <p role="alert">{error}</p> : null}
		</section>
	)
}

type DaemonAction = 'pause' | 'resume' | 'restart' | 'update'

const daemonActionBusyLabel: Record<DaemonAction, string> = {
	pause: 'Pausing…',
	resume: 'Resuming…',
	restart: 'Restarting…',
	update: 'Checking…',
}

function DaemonPanel(props: {
	orgSlug: string
	context: ExecutionContextListItem
	onChanged: () => void
}) {
	const { context } = props
	const [busy, setBusy] = useState<DaemonAction | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [confirmingPause, setConfirmingPause] = useState(false)
	const [reason, setReason] = useState('')
	if (context.status === 'revoked') return null
	const canPause = context.canPause === true
	const canResume = context.canResume === true
	const canControl = context.canControlDaemon === true
	if (!canPause && !canResume && !canControl && !context.paused) return null
	const paused = context.paused ?? null
	const online = context.status === 'online'
	const serviceManaged = Boolean(context.capabilities?.service)

	async function run(action: DaemonAction) {
		setBusy(action)
		setError(null)
		setNotice(null)
		try {
			const result = (await runExecutionContextDaemonAction({
				data: {
					orgSlug: props.orgSlug,
					contextId: context.id,
					action,
					...(action === 'pause' && reason.trim()
						? { reason: reason.trim() }
						: {}),
				},
			})) as { ok: true; message: string | null } | Failure
			if (!result.ok) {
				setError(failureText(result))
				return
			}
			setConfirmingPause(false)
			setReason('')
			setNotice(
				action === 'restart'
					? `${context.name} is restarting. It reconnects in a few seconds.`
					: action === 'update'
						? (result.message ?? 'Update check sent.')
						: null,
			)
			props.onChanged()
		} catch {
			setError(unexpectedErrorText)
		} finally {
			setBusy(null)
		}
	}

	const rowCss = css({
		display: 'flex',
		flexWrap: 'wrap',
		gap: spacing.sm,
		alignItems: 'center',
	})
	return (
		<section
			css={[
				sectionCss,
				{
					border: `1px solid ${paused ? colors.warning : colors.border}`,
					borderRadius: radius.lg,
					padding: spacing.md,
				},
			]}
			aria-labelledby="context-daemon-title"
			data-testid="context-daemon"
		>
			<div css={[rowCss, { justifyContent: 'space-between' }]}>
				<h2 id="context-daemon-title" css={{ margin: 0, fontSize: '1rem' }}>
					Daemon
				</h2>
				<span
					data-testid="context-daemon-state"
					css={{
						display: 'inline-flex',
						alignItems: 'center',
						gap: spacing.xs,
						fontWeight: 600,
						color: paused || !online ? colors.textMuted : colors.text,
					}}
				>
					<span
						aria-hidden
						css={{
							width: 8,
							height: 8,
							borderRadius: 999,
							background: paused
								? colors.warning
								: online
									? colors.primary
									: colors.borderSubtle,
						}}
					/>
					{paused ? 'Paused' : online ? 'Running' : 'Offline'}
				</span>
			</div>
			{paused ? (
				<p css={mutedCss} data-testid="context-daemon-paused">
					Paused {formatTimestamp(paused.at)}
					{paused.by ? ` by @${paused.by}` : ''}
					{paused.reason ? `: ${paused.reason}` : ''}. Chains skip{' '}
					{context.name}, queued runs fail and host commands are refused until
					it is resumed. The daemon stays connected.
					{!canResume && canPause
						? ` Only ${context.isOperator ? 'you' : `@${context.operator.handle}`} or someone with Manage on it can resume it.`
						: ''}
				</p>
			) : (
				<p css={mutedCss}>
					{online
						? `${context.name} takes runs from chains it is in.`
						: `${context.name} is offline, so chains skip it. Start it on the machine with `}
					{online ? null : <code>kody daemon start</code>}
					{online ? null : '.'} Pause it to stop routing runs to it from
					anywhere, even while it is offline.
				</p>
			)}
			{error ? (
				<AccountManagementMessage tone="error">{error}</AccountManagementMessage>
			) : null}
			{notice ? <AccountManagementMessage>{notice}</AccountManagementMessage> : null}
			{confirmingPause ? (
				<div css={rowCss}>
					<label css={{ display: 'grid', gap: spacing.xs, flex: '1 1 16rem' }}>
						<span>Reason (optional, shown on the context)</span>
						<input
							css={[accountInputCss, target]}
							value={reason}
							maxLength={200}
							onChange={(event) => setReason(event.target.value)}
							data-testid="context-daemon-pause-reason"
						/>
					</label>
					<button
						type="button"
						css={[getDangerPillCss({ size: 'sm' }), target]}
						disabled={busy !== null}
						onClick={() => void run('pause')}
						data-testid="context-daemon-pause-confirm"
					>
						{busy === 'pause' ? daemonActionBusyLabel.pause : 'Pause'}
					</button>
					<button
						type="button"
						css={[getGhostButtonCss({ size: 'sm' }), target]}
						disabled={busy !== null}
						onClick={() => setConfirmingPause(false)}
					>
						Cancel
					</button>
				</div>
			) : (
				<div css={rowCss}>
					{paused && canResume ? (
						<button
							type="button"
							css={[getPillButtonCss({ size: 'sm' }), target]}
							disabled={busy !== null}
							onClick={() => void run('resume')}
							data-testid="context-daemon-resume"
						>
							{busy === 'resume' ? daemonActionBusyLabel.resume : 'Resume'}
						</button>
					) : null}
					{!paused && canPause ? (
						<button
							type="button"
							css={[getGhostButtonCss({ size: 'sm' }), target]}
							disabled={busy !== null}
							onClick={() => setConfirmingPause(true)}
							data-testid="context-daemon-pause"
						>
							Pause
						</button>
					) : null}
					{canControl ? (
						<>
							<button
								type="button"
								css={[getGhostButtonCss({ size: 'sm' }), target]}
								disabled={busy !== null || !online || !serviceManaged}
								title={
									!online
										? 'The daemon is offline'
										: !serviceManaged
											? 'Runs in a terminal: restart it there, or install it as a service'
											: undefined
								}
								onClick={() => void run('restart')}
								data-testid="context-daemon-restart"
							>
								{busy === 'restart' ? daemonActionBusyLabel.restart : 'Restart'}
							</button>
							<button
								type="button"
								css={[getGhostButtonCss({ size: 'sm' }), target]}
								disabled={busy !== null || !online || !serviceManaged}
								title={!online ? 'The daemon is offline' : undefined}
								onClick={() => void run('update')}
								data-testid="context-daemon-update"
							>
								{busy === 'update' ? daemonActionBusyLabel.update : 'Update now'}
							</button>
						</>
					) : null}
				</div>
			)}
			{context.canReadDaemonLogs ? (
				<p css={mutedCss}>
					Logs: <code>kody daemon logs --context {context.name}</code>
				</p>
			) : null}
		</section>
	)
}

function CommandsPanel(props: {
	orgSlug: string
	context: ExecutionContextListItem
	onChanged: () => void
}) {
	const { context } = props
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [confirming, setConfirming] = useState(false)
	if (context.status === 'revoked') return null
	const on = context.grantSummary.commands === true
	const canTurnOff =
		context.isOperator || context.myPermissions.includes('write')
	const canRun = context.myPermissions.includes('command')

	async function turnOff() {
		setBusy(true)
		setError(null)
		try {
			const result = (await turnOffExecutionContextCommands({
				data: { orgSlug: props.orgSlug, contextId: context.id },
			})) as { ok: true } | Failure
			if (!result.ok) {
				setError(failureText(result))
				return
			}
			setConfirming(false)
			props.onChanged()
		} catch {
			setError(unexpectedErrorText)
		} finally {
			setBusy(false)
		}
	}

	return (
		<section
			css={[
				sectionCss,
				{
					border: `1px solid ${colors.border}`,
					borderRadius: radius.lg,
					padding: spacing.md,
				},
			]}
			aria-labelledby="context-commands-title"
			data-testid="context-commands"
		>
			<div
				css={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'center',
					justifyContent: 'space-between',
				}}
			>
				<h2 id="context-commands-title" css={{ margin: 0, fontSize: '1rem' }}>
					Host commands
				</h2>
				<span
					role="switch"
					aria-checked={on}
					aria-readonly
					aria-labelledby="context-commands-title"
					data-testid="context-commands-state"
					css={{
						display: 'inline-flex',
						alignItems: 'center',
						gap: spacing.xs,
						fontWeight: 600,
						color: on ? colors.text : colors.textMuted,
					}}
				>
					<span
						aria-hidden
						css={{
							width: 36,
							height: 20,
							borderRadius: 999,
							background: on ? colors.primary : colors.borderSubtle,
							border: `1px solid ${on ? colors.primary : colors.border}`,
							position: 'relative',
							'&::after': {
								content: '""',
								position: 'absolute',
								top: 2,
								left: on ? 18 : 2,
								width: 14,
								height: 14,
								borderRadius: 999,
								background: colors.surface,
							},
						}}
					/>
					{on ? 'On' : 'Off'}
				</span>
			</div>
			{on ? (
				<p css={mutedCss}>
					Runs on {context.name} that have the command grant can run any shell
					command as{' '}
					{context.isOperator ? 'your' : `@${context.operator.handle}'s`} user
					account on that machine, with no approval per command. Every command
					is recorded in the audit log below.{' '}
					{canRun
						? 'You have the command grant here.'
						: 'You do not have the command grant here.'}
				</p>
			) : (
				<p css={mutedCss}>
					Runs on {context.name} cannot run shell commands.
					{context.isOperator ? (
						<>
							{' '}
							Only the machine can turn them on: run{' '}
							<code>
								kody context commands on --context {context.name}
							</code>{' '}
							there, or choose Machine › Allow commands in the Kody desktop app.
						</>
					) : null}
				</p>
			)}
			{error ? (
				<AccountManagementMessage tone="error">
					{error}
				</AccountManagementMessage>
			) : null}
			{on && canTurnOff ? (
				confirming ? (
					<div
						css={{
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.sm,
							alignItems: 'center',
						}}
					>
						<span>
							Turn off commands? Background commands stop right away. Turning
							them back on needs the machine.
						</span>
						<button
							type="button"
							css={[getDangerPillCss({ size: 'sm' }), target]}
							disabled={busy}
							onClick={() => void turnOff()}
							data-testid="context-commands-off-confirm"
						>
							{busy ? 'Turning off…' : 'Turn off'}
						</button>
						<button
							type="button"
							css={[getGhostButtonCss({ size: 'sm' }), target]}
							disabled={busy}
							onClick={() => setConfirming(false)}
						>
							Cancel
						</button>
					</div>
				) : (
					<div>
						<button
							type="button"
							css={[getDangerPillCss({ size: 'sm' }), target]}
							onClick={() => setConfirming(true)}
							data-testid="context-commands-off"
						>
							Turn off commands
						</button>
					</div>
				)
			) : null}
		</section>
	)
}

function OptInControls(props: {
	orgSlug: string
	context: ExecutionContextListItem
	chain: ExecutionChain
	onChanged: () => void
}) {
	const { context } = props
	const dialog = useRef<HTMLDialogElement>(null)
	const [addToChain, setAddToChain] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [confirmLeave, setConfirmLeave] = useState(false)
	const [leftLocally, setLeftLocally] = useState(false)
	const undoable = useUndoableAction()
	const full = chainIsFull(props.chain.entries)
	const inChain = chainPosition(props.chain.entries, context.id) !== null
	if (context.isOperator) return null
	const copy = optInCopy({
		name: context.name,
		operator: context.operator.handle,
		grant: context.grantSummary,
	})

	async function optIn() {
		setBusy(true)
		setError(null)
		try {
			// Opting back in during the undo window cancels the pending leave.
			await undoable.undo()
			await optInAndChain()
		} catch {
			setError(unexpectedErrorText)
		} finally {
			setBusy(false)
		}
	}

	async function optInAndChain() {
		const result = (await optIntoExecutionContext({
			data: { orgSlug: props.orgSlug, contextId: context.id },
		})) as { ok: true } | Failure
		if (!result.ok) {
			setError(failureText(result))
			return
		}
		setLeftLocally(false)
		if (addToChain && !full) {
			const chained = (await setExecutionChain({
				data: {
					orgSlug: props.orgSlug,
					entries: insertBeforeCloud(
						chainEntryInputs(props.chain.entries),
						context.id,
					),
					strict: !chainHasCloud(props.chain.entries),
					ifMatch: props.chain.updatedAt ?? null,
				},
			})) as { ok: true } | Failure
			if (!chained.ok) {
				props.onChanged()
				setError(
					`You opted in, but ${context.name} was not added to your chain. ${failureText(chained)}`,
				)
				return
			}
		}
		dialog.current?.close()
		props.onChanged()
	}

	function optOut() {
		setConfirmLeave(false)
		setLeftLocally(true)
		void undoable.start({
			message: `You left ${context.name}.`,
			onCommit: async () => {
				const result = (await optOutOfExecutionContext({
					data: { orgSlug: props.orgSlug, contextId: context.id },
				}).catch(() => unexpectedFailure)) as { ok: true } | Failure
				if (!result.ok) {
					setLeftLocally(false)
					setError(failureText(result))
					return
				}
				props.onChanged()
			},
			onUndo: () => setLeftLocally(false),
		})
	}

	const optedIn = context.optedIn && !leftLocally
	return (
		<section css={sectionCss} aria-label="Your access">
			{error ? (
				<AccountManagementMessage tone="error">
					{error}
				</AccountManagementMessage>
			) : null}
			{optedIn ? (
				<div
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
					}}
				>
					<span>You are opted in.</span>
					{confirmLeave ? (
						<>
							<span css={mutedCss}>
								{inChain
									? 'This also removes it from your chain.'
									: 'Your runs stop using it.'}
							</span>
							<button
								type="button"
								css={[getDangerPillCss({ size: 'sm' }), target]}
								onClick={optOut}
							>
								Confirm leave
							</button>
							<button
								type="button"
								css={[getGhostButtonCss({ size: 'sm' }), target]}
								onClick={() => setConfirmLeave(false)}
							>
								Cancel
							</button>
						</>
					) : (
						<button
							type="button"
							css={[getGhostButtonCss({ size: 'sm' }), target]}
							onClick={() => (inChain ? setConfirmLeave(true) : optOut())}
						>
							Leave
						</button>
					)}
				</div>
			) : leftLocally && context.optedIn && !undoable.pending ? (
				<p css={mutedCss} role="status">
					Leaving {context.name}…
				</p>
			) : canOptIntoContext({ ...context, optedIn }) ? (
				<div>
					<button
						type="button"
						data-testid="context-opt-in"
						css={[getPillButtonCss({ size: 'sm' }), target]}
						onClick={() => {
							setAddToChain(false)
							setError(null)
							dialog.current?.showModal()
						}}
					>
						Opt in
					</button>
				</div>
			) : null}
			<dialog
				ref={dialog}
				css={dialogCss}
				aria-labelledby="opt-in-title"
				data-testid="opt-in-dialog"
			>
				<h2 id="opt-in-title" css={{ marginTop: 0 }}>
					{copy.title}
				</h2>
				{copy.paragraphs.map((paragraph) => (
					<p key={paragraph}>{paragraph}</p>
				))}
				{copy.lan ? <p data-testid="opt-in-lan">{copy.lan}</p> : null}
				<p css={mutedCss}>{copy.managersNote}</p>
				<label
					css={{
						display: 'flex',
						gap: spacing.sm,
						alignItems: 'center',
						minHeight: 44,
					}}
				>
					<input
						type="checkbox"
						checked={addToChain && !full}
						disabled={full}
						onChange={(event) => setAddToChain(event.target.checked)}
					/>
					{copy.checkboxLabel}
				</label>
				{full ? <p css={mutedCss}>{copy.chainFullNote}</p> : null}
				{error ? (
					<AccountManagementMessage tone="error">
						{error}
					</AccountManagementMessage>
				) : null}
				<div css={{ display: 'flex', gap: spacing.sm, justifyContent: 'end' }}>
					<button
						type="button"
						css={[getGhostButtonCss({ size: 'sm' }), target]}
						onClick={() => dialog.current?.close()}
					>
						Cancel
					</button>
					<button
						type="button"
						css={[getPillButtonCss({ size: 'sm' }), target]}
						disabled={busy}
						onClick={() => void optIn()}
					>
						{busy ? 'Opting in…' : 'Opt in'}
					</button>
				</div>
			</dialog>
			{undoable.pending ? (
				<UndoToast
					message={undoable.pending.message}
					undoLabel={undoable.pending.undoLabel}
					onUndo={() => void undoable.undo()}
				/>
			) : null}
		</section>
	)
}

function SharingPanel(props: {
	orgSlug: string
	context: ExecutionContextListItem
	onChanged: () => void
}) {
	const { context } = props
	const sharing = context.sharing!
	const copy = shareCopy({
		name: context.name,
		operator: context.operator.handle,
		viewerIsOperator: context.isOperator,
		grant: context.grantSummary,
	})
	const canAdd = context.canAddShares ?? context.isOperator
	const [kind, setKind] = useState<'user' | 'team' | 'org'>('user')
	const [value, setValue] = useState('')
	const [preset, setPreset] = useState<ExecutionContextPreset>('use')
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [excessWarning, setExcessWarning] = useState<string | null>(null)

	async function share() {
		setBusy(true)
		setError(null)
		const subjectKey = `${kind}:${value}`
		if (excessWarning !== subjectKey) {
			const preview = (await previewExecutionContextShare({
				data: {
					orgSlug: props.orgSlug,
					contextId: context.id,
					subject:
						kind === 'user'
							? { kind, username: value }
							: kind === 'team'
								? { kind, slug: value }
								: { kind },
				},
			}).catch(() => unexpectedFailure)) as
				| { ok: true; excessCount: number; people: number }
				| Failure
			if (!preview.ok) {
				setBusy(false)
				return setError(failureText(preview))
			}
			if (preview.excessCount > 0) {
				setBusy(false)
				setExcessWarning(subjectKey)
				return
			}
		}
		setExcessWarning(null)
		const result = (await shareExecutionContext({
			data: {
				orgSlug: props.orgSlug,
				contextId: context.id,
				subject:
					kind === 'user'
						? { kind, username: value }
						: kind === 'team'
							? { kind, slug: value }
							: { kind },
				preset,
			},
		}).catch(() => unexpectedFailure)) as { ok: true } | Failure
		setBusy(false)
		if (!result.ok) return setError(failureText(result))
		setValue('')
		props.onChanged()
	}

	async function stopSharingWithEveryone() {
		setConfirmRemove(null)
		const result = (await shareExecutionContext({
			data: {
				orgSlug: props.orgSlug,
				contextId: context.id,
				subject: { kind: 'org', enabled: false },
				preset: 'use',
			},
		}).catch(() => unexpectedFailure)) as { ok: true } | Failure
		if (!result.ok) return setError(failureText(result))
		props.onChanged()
	}

	async function remove(grantId: string) {
		setConfirmRemove(null)
		const result = (await removeExecutionContextShare({
			data: { orgSlug: props.orgSlug, contextId: context.id, grantId },
		}).catch(() => unexpectedFailure)) as { ok: true } | Failure
		if (!result.ok) return setError(failureText(result))
		props.onChanged()
	}

	return (
		<section
			css={sectionCss}
			aria-labelledby="context-sharing-title"
			data-testid="context-sharing"
		>
			<h3 id="context-sharing-title" css={{ margin: 0 }}>
				Sharing
			</h3>
			<p css={mutedCss}>{sharingSummary(sharing, context.ownerOrg.slug)}</p>
			{error ? (
				<AccountManagementMessage tone="error">
					{error}
				</AccountManagementMessage>
			) : null}
			{sharing.allMembers ? (
				<p css={{ margin: 0 }}>
					Everyone in @{context.ownerOrg.slug}, {presetLabels.use}{' '}
					{!canAdd ? null : confirmRemove === allMembersKey ? (
						<>
							<span css={mutedCss}>
								{stopSharingConfirm(`everyone in @${context.ownerOrg.slug}`)}
							</span>{' '}
							<button
								type="button"
								css={[getDangerPillCss({ size: 'sm' }), target]}
								onClick={() => void stopSharingWithEveryone()}
							>
								Stop sharing
							</button>{' '}
							<button
								type="button"
								css={[getGhostButtonCss({ size: 'sm' }), target]}
								onClick={() => setConfirmRemove(null)}
							>
								Cancel
							</button>
						</>
					) : (
						<button
							type="button"
							css={[getGhostButtonCss({ size: 'sm' }), target]}
							onClick={() => setConfirmRemove(allMembersKey)}
						>
							Remove
						</button>
					)}
				</p>
			) : null}
			{sharing.grants.length > 0 ? (
				<ul
					css={{
						margin: 0,
						paddingLeft: '1.2rem',
						display: 'grid',
						gap: spacing.xs,
					}}
				>
					{sharing.grants.map((grant) => (
						<li key={grant.grantId}>
							{subjectLabel(grant)}, {presetLabels[grant.preset]}
							{grant.commands ? ' (host commands off: operator only)' : ''}{' '}
							{confirmRemove === grant.grantId ? (
								<>
									<span css={mutedCss}>
										{stopSharingConfirm(subjectLabel(grant))}
									</span>{' '}
									<button
										type="button"
										css={[getDangerPillCss({ size: 'sm' }), target]}
										onClick={() => void remove(grant.grantId)}
									>
										Stop sharing
									</button>{' '}
									<button
										type="button"
										css={[getGhostButtonCss({ size: 'sm' }), target]}
										onClick={() => setConfirmRemove(null)}
									>
										Cancel
									</button>
								</>
							) : (
								<button
									type="button"
									css={[getGhostButtonCss({ size: 'sm' }), target]}
									onClick={() => setConfirmRemove(grant.grantId)}
								>
									Remove
								</button>
							)}
						</li>
					))}
				</ul>
			) : null}
			{canAdd ? (
				<form
					css={{ display: 'grid', gap: spacing.sm }}
					onSubmit={(event) => {
						event.preventDefault()
						void share()
					}}
				>
					{copy.paragraphs.map((paragraph) => (
						<p key={paragraph} css={{ margin: 0 }}>
							{paragraph}
						</p>
					))}
					{copy.lan ? <p css={{ margin: 0 }}>{copy.lan}</p> : null}
					{sharing.grants.length === 0 ? (
						<p css={mutedCss}>{copy.firstShareRuntimeNote}</p>
					) : null}
					<p css={mutedCss}>{copy.noInviteLinksNote}</p>
					<div
						css={{
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.sm,
							alignItems: 'end',
						}}
					>
						<label css={{ display: 'grid', gap: 2 }}>
							Share with
							<select
								value={kind}
								css={[target, selectCss]}
								onChange={(event) => setKind(event.target.value as typeof kind)}
							>
								<option value="user">A person</option>
								<option value="team">A team</option>
								<option value="org">
									Everyone in @{context.ownerOrg.slug}
								</option>
							</select>
						</label>
						{kind === 'org' ? null : (
							<label css={{ display: 'grid', gap: 2 }}>
								{kind === 'user' ? 'Username' : 'Team slug'}
								<input
									value={value}
									required
									css={[target, accountInputCss]}
									onChange={(event) => setValue(event.target.value)}
								/>
							</label>
						)}
						<label css={{ display: 'grid', gap: 2 }}>
							Access
							<select
								value={preset}
								css={[target, selectCss]}
								onChange={(event) =>
									setPreset(event.target.value as ExecutionContextPreset)
								}
							>
								{(['use', 'contribute', 'manage'] as const).map((item) => (
									<option key={item} value={item}>
										{presetLabels[item]}
									</option>
								))}
							</select>
						</label>
						<button
							type="submit"
							css={[getPillButtonCss({ size: 'sm' }), target]}
							disabled={busy}
						>
							{excessWarning === `${kind}:${value}` ? 'Share anyway' : 'Share'}
						</button>
					</div>
					{excessWarning === `${kind}:${value}` ? (
						<p
							role="alert"
							data-testid="context-share-excess-warning"
							css={{ margin: 0 }}
						>
							{context.name} is logged in as an account that can do things{' '}
							{kind === 'team' ? 'some members of this team' : 'this person'}{' '}
							can't do with their own access. Their runs still use only their
							own access, but anyone with host access on the machine acts with
							its login. See the{' '}
							<a href="/docs/execution-contexts#shared-box-best-practices">
								shared-box best practices
							</a>
							.
						</p>
					) : null}
				</form>
			) : (
				<p css={mutedCss}>{copy.ownerWithoutManageNote}</p>
			)}
		</section>
	)
}

function RunHistory(props: {
	orgSlug: string
	context: ExecutionContextListItem
	nameForId: (id: string) => string | undefined
}) {
	const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
	const [requester, setRequester] = useState('')
	const [requesterDraft, setRequesterDraft] = useState('')
	function applyRequester() {
		const next = requesterDraft.trim()
		if (next === requester) return
		setRequester(next)
		setCursors([undefined])
	}
	const [outcome, setOutcome] = useState('')
	const pages = useQuery({
		queryKey: [
			'execution-context-runs',
			props.orgSlug,
			props.context.id,
			requester,
			outcome,
			cursors,
		],
		queryFn: async () => {
			const results = await Promise.all(
				cursors.map((cursor) =>
					loadExecutionContextRuns({
						data: {
							orgSlug: props.orgSlug,
							contextId: props.context.id,
							...(cursor ? { cursor } : {}),
							...(requester ? { requester } : {}),
							...(outcome ? { outcome } : {}),
						},
					}),
				),
			)
			return results as Array<
				{ ok: true; page: ExecutionContextRunPage } | Failure
			>
		},
	})
	const ok = (pages.data ?? []).flatMap((result) =>
		result.ok ? [result.page] : [],
	)
	const failed = (pages.data ?? []).find((result) => !result.ok) as
		| Failure
		| undefined
	const runs = ok.flatMap((page) => page.runs)
	const last = ok.at(-1)
	const manager = ok[0]?.scope === 'all'
	const [confirmCancel, setConfirmCancel] = useState<string | null>(null)
	const [cancelling, setCancelling] = useState<string | null>(null)
	const [cancelError, setCancelError] = useState<string | null>(null)
	async function cancelRun(runId: string) {
		setConfirmCancel(null)
		setCancelling(runId)
		setCancelError(null)
		const result = (await cancelExecutionContextRun({
			data: { orgSlug: props.orgSlug, contextId: props.context.id, runId },
		}).catch(() => unexpectedFailure)) as { ok: true } | Failure
		setCancelling(null)
		if (!result.ok) setCancelError(failureText(result))
		await pages.refetch()
	}
	return (
		<section
			css={sectionCss}
			aria-labelledby="context-runs-title"
			data-testid="context-runs"
		>
			<h3 id="context-runs-title" css={{ margin: 0 }}>
				Runs
			</h3>
			{manager ? (
				<div css={{ display: 'flex', flexWrap: 'wrap', gap: spacing.sm }}>
					<label css={{ display: 'grid', gap: 2 }}>
						Requester
						<input
							value={requesterDraft}
							placeholder="username"
							css={[target, accountInputCss]}
							onChange={(event) => setRequesterDraft(event.target.value)}
							onBlur={applyRequester}
							onKeyDown={(event) => {
								if (event.key === 'Enter') applyRequester()
							}}
						/>
					</label>
					<label css={{ display: 'grid', gap: 2 }}>
						Outcome
						<select
							value={outcome}
							css={[target, selectCss]}
							onChange={(event) => {
								setOutcome(event.target.value)
								setCursors([undefined])
							}}
						>
							<option value="">Any</option>
							{Object.entries(runOutcomeLabels).map(([key, label]) => (
								<option key={key} value={key}>
									{label}
								</option>
							))}
						</select>
					</label>
				</div>
			) : ok.length > 0 ? (
				<p css={mutedCss}>You see your own runs on this context.</p>
			) : null}
			{failed?.error === 'not_granted' ? (
				<p css={mutedCss}>{failureText(failed)}</p>
			) : failed ? (
				<AccountManagementMessage tone="error">
					{failureText(failed)}
				</AccountManagementMessage>
			) : null}
			{cancelError ? (
				<AccountManagementMessage tone="error">
					{cancelError}
				</AccountManagementMessage>
			) : null}
			{pages.isPending ? (
				<p css={mutedCss}>Loading runs…</p>
			) : runs.length === 0 && !failed ? (
				<p css={mutedCss}>No runs yet.</p>
			) : runs.length > 0 ? (
				<div css={{ overflowX: 'auto' }}>
					<table css={tableCss}>
						<thead>
							<tr>
								<th scope="col">When</th>
								<th scope="col">Requester</th>
								<th scope="col">Duration</th>
								<th scope="col">Outcome</th>
								<th scope="col">Fallback</th>
							</tr>
						</thead>
						<tbody>
							{runs.map((run) => (
								<tr key={`${run.runId}:${run.dispatchedAt}`}>
									<td>{formatTimestamp(run.dispatchedAt)}</td>
									<td>@{run.requester.handle}</td>
									<td>{durationLabel(run.durationMs)}</td>
									<td>
										{run.outcome ? (
											runOutcomeLabels[run.outcome]
										) : (
											<span
												css={{
													display: 'flex',
													flexWrap: 'wrap',
													alignItems: 'center',
													gap: spacing.sm,
												}}
											>
												In progress
												<RunCancelControl
													runId={run.runId}
													cancelling={cancelling === run.runId}
													confirming={confirmCancel === run.runId}
													onAsk={() => setConfirmCancel(run.runId)}
													onConfirm={() => void cancelRun(run.runId)}
													onKeep={() => setConfirmCancel(null)}
												/>
											</span>
										)}
									</td>
									<td>
										{runFallbackLabel({
											run,
											contextId: props.context.id,
											nameForId: props.nameForId,
										})}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			{last?.nextCursor ? (
				<div>
					<button
						type="button"
						css={[getGhostButtonCss({ size: 'sm' }), target]}
						onClick={() =>
							setCursors([...cursors, last.nextCursor ?? undefined])
						}
					>
						Load more
					</button>
				</div>
			) : null}
		</section>
	)
}

/** Cancel for an in-progress run, with a confirm step before it stops. */
export function RunCancelControl(props: {
	runId: string
	cancelling: boolean
	confirming: boolean
	onAsk: () => void
	onConfirm: () => void
	onKeep: () => void
}) {
	if (props.cancelling) return <span css={mutedCss}>Cancelling…</span>
	if (props.confirming) {
		return (
			<>
				<button
					type="button"
					css={[getGhostButtonCss({ size: 'sm' }), target]}
					onClick={props.onConfirm}
				>
					Stop run
				</button>
				<button
					type="button"
					css={[getGhostButtonCss({ size: 'sm' }), target]}
					onClick={props.onKeep}
				>
					Keep running
				</button>
			</>
		)
	}
	return (
		<button
			type="button"
			css={[getGhostButtonCss({ size: 'sm' }), target]}
			aria-label={`Cancel run ${props.runId}`}
			onClick={props.onAsk}
		>
			Cancel
		</button>
	)
}

function AuditLog(props: {
	orgSlug: string
	context: ExecutionContextListItem
}) {
	const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
	const pages = useQuery({
		queryKey: [
			'execution-context-audit',
			props.orgSlug,
			props.context.id,
			cursors,
		],
		queryFn: async () =>
			(await Promise.all(
				cursors.map((cursor) =>
					loadExecutionContextAudit({
						data: {
							orgSlug: props.orgSlug,
							contextId: props.context.id,
							...(cursor ? { cursor } : {}),
						},
					}),
				),
			)) as Array<{ ok: true; page: ExecutionContextAuditPage } | Failure>,
	})
	const ok = (pages.data ?? []).flatMap((result) =>
		result.ok ? [result.page] : [],
	)
	const failed = (pages.data ?? []).find((result) => !result.ok) as
		| Failure
		| undefined
	const events = ok.flatMap((page) => page.events)
	const last = ok.at(-1)
	return (
		<section
			css={sectionCss}
			aria-labelledby="context-audit-title"
			data-testid="context-audit"
		>
			<h3 id="context-audit-title" css={{ margin: 0 }}>
				Audit log
			</h3>
			{failed?.error === 'not_granted' ? (
				<p css={mutedCss}>{failureText(failed)}</p>
			) : failed ? (
				<AccountManagementMessage tone="error">
					{failureText(failed)}
				</AccountManagementMessage>
			) : null}
			{pages.isPending ? (
				<p css={mutedCss}>Loading audit log…</p>
			) : events.length === 0 && !failed ? (
				<p css={mutedCss}>No audit events yet.</p>
			) : (
				<ul
					css={{
						margin: 0,
						paddingLeft: '1.2rem',
						display: 'grid',
						gap: spacing.xs,
					}}
				>
					{events.map((event) => (
						<li key={event.id}>
							{auditEventLabel(event.action)}
							{event.actor ? ` by ${event.actor.label}` : ''},{' '}
							<time dateTime={event.at}>{formatTimestamp(event.at)}</time>
							{commandAuditSummary(event.detail) ? (
								<>
									{': '}
									<code css={{ overflowWrap: 'anywhere' }}>
										{commandAuditSummary(event.detail)}
									</code>
								</>
							) : null}
						</li>
					))}
				</ul>
			)}
			{last?.nextCursor ? (
				<div>
					<button
						type="button"
						css={[getGhostButtonCss({ size: 'sm' }), target]}
						onClick={() =>
							setCursors([...cursors, last.nextCursor ?? undefined])
						}
					>
						Load more
					</button>
				</div>
			) : null}
		</section>
	)
}

const outdatedCss = css({
	display: 'block',
	marginTop: spacing.xs,
	color: colors.warningText,
	fontWeight: 600,
})

const hintCss = css({
	display: 'block',
	marginTop: spacing.xs,
	color: colors.textMuted,
})
