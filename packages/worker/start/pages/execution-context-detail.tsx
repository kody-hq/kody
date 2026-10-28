/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useQuery } from '@tanstack/react-query'
import { useRefreshExecutionContextsPage } from '../execution-contexts-query.ts'
import { useRef, useState } from 'react'
import {
	loadExecutionContextAudit,
	loadExecutionContextRuns,
	optIntoExecutionContext,
	optOutOfExecutionContext,
	removeExecutionContextShare,
	setExecutionChain,
	shareExecutionContext,
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
	contextDisplayStatus,
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
	getDangerButtonCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSecondaryButtonCss,
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
					{context.status === 'revoked' && context.revokedAt
						? `, ${new Date(context.revokedAt).toLocaleDateString()}`
						: context.lastSeenAt && status === 'offline'
							? `, last seen ${new Date(context.lastSeenAt).toLocaleString()}`
							: null}
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
				{context.client ? (
					<>
						<dt>Client</dt>
						<dd>
							{context.client.name} {context.client.version}
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
			<OptInControls {...props} onChanged={refresh} />
			{context.sharing ? <SharingPanel {...props} onChanged={refresh} /> : null}
			<RunHistory orgSlug={orgSlug} context={context} nameForId={nameForId} />
			<AuditLog orgSlug={orgSlug} context={context} />
		</div>
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
								css={[getDangerButtonCss(), target]}
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
							css={[getSecondaryButtonCss(), target]}
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

	async function share() {
		setBusy(true)
		setError(null)
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
								css={[getDangerButtonCss(), target]}
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
							{subjectLabel(grant)}, {presetLabels[grant.preset]}{' '}
							{confirmRemove === grant.grantId ? (
								<>
									<span css={mutedCss}>
										{stopSharingConfirm(subjectLabel(grant))}
									</span>{' '}
									<button
										type="button"
										css={[getDangerButtonCss(), target]}
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
							Share
						</button>
					</div>
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
									<td>{new Date(run.dispatchedAt).toLocaleString()}</td>
									<td>@{run.requester.handle}</td>
									<td>{durationLabel(run.durationMs)}</td>
									<td>
										{run.outcome
											? runOutcomeLabels[run.outcome]
											: 'In progress'}
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
						css={[getSecondaryButtonCss(), target]}
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
							<time dateTime={event.at}>
								{new Date(event.at).toLocaleString()}
							</time>
						</li>
					))}
				</ul>
			)}
			{last?.nextCursor ? (
				<div>
					<button
						type="button"
						css={[getSecondaryButtonCss(), target]}
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
