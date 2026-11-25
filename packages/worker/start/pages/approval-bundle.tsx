/** @jsxImportSource @emotion/react */
import { Button } from '../components/button.tsx'
import {
	IdValue,
	MetadataGrid,
	accountDisclosureCss,
} from './account-management-components.tsx'
import { auditedLabel } from './package-security-audit-field.tsx'
import { packageSecurityAuditAnchor } from '#universal/package-security-audit-prompt.ts'
import { useState, useRef, type ReactNode } from 'react'
import type { CSSObject } from '@emotion/react'
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import {
	approveAllApprovalBundle,
	decideApprovalBundle,
} from '#start/server/approval-bundles'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { permissionsMutationOptions } from '../permissions-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { SiteLink } from '../components/site-link.tsx'
import {
	approvalItemsAwaitingDecision,
	approvalItemsReadyToApprove,
	approvalItemStatusLabel,
	approveAllLabel,
	approveAllProgress,
	approveAllSummary,
	approvingAllLabel,
	type ApprovalBundleLoaderData,
	type ApprovalBundlePackageGroup,
	type ApprovalBundleView,
	type ApprovalGrantLine,
	type ApprovalItemStatus,
	type ApprovalItemView,
} from '#universal/approval-bundles.ts'
import {
	cardCss,
	cardTitleCss,
	insetCardCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
const mutedCss = { margin: 0, color: colors.textMuted }
const smallMutedCss = { ...mutedCss, fontSize: typography.fontSize.sm }
const listCss: CSSObject = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.sm,
}

type BundlePath = { orgSlug: string; bundleId: string }

/** Where an item stands inside a running Approve all. */
type BatchItemState = 'queued' | 'approving'

function replaceItem(
	old: ApprovalBundleLoaderData | undefined,
	item: ApprovalItemView,
): ApprovalBundleLoaderData | undefined {
	return old?.ok
		? {
				...old,
				view: {
					...old.view,
					groups: old.view.groups.map((group) => ({
						...group,
						items: group.items.map((previous) =>
							previous.key === item.key ? item : previous,
						),
					})),
				},
			}
		: old
}

function statusColor(status: ApprovalItemStatus) {
	switch (status) {
		case 'pending':
			return colors.warningText
		case 'approved':
			return colors.primary
		case 'denied':
			return colors.danger
		case 'resolved':
		case 'unavailable':
			return colors.textMuted
		default: {
			const exhaustive: never = status
			throw new Error(`Unknown approval status: ${String(exhaustive)}`)
		}
	}
}

function changeLabel(change: ApprovalGrantLine['change']) {
	switch (change) {
		case 'added':
			return 'New'
		case 'changed':
			return 'Changed'
		case 'removed':
			return 'Removed'
		default: {
			const exhaustive: never = change
			throw new Error(`Unknown grant change: ${String(exhaustive)}`)
		}
	}
}

function renderGrant(grant: ApprovalGrantLine, index: number) {
	const facts = [
		grant.kind,
		grant.provider ? `provider ${grant.provider}` : null,
		grant.hosts.length > 0 ? `reaches ${grant.hosts.join(', ')}` : null,
	].filter(Boolean)
	return (
		<li
			key={index}
			data-testid="approval-bundle-grant"
			css={{ ...insetCardCss, display: 'grid', gap: spacing.xs }}
		>
			<div
				css={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'baseline',
				}}
			>
				<span
					css={{
						fontSize: typography.fontSize.xs,
						fontWeight: typography.fontWeight.semibold,
						textTransform: 'uppercase',
						letterSpacing: '0.04em',
						color:
							grant.change === 'removed'
								? colors.textMuted
								: colors.warningText,
					}}
				>
					{changeLabel(grant.change)}
				</span>
				<strong>{grant.label}</strong>
				{grant.where ? <span css={smallMutedCss}>{grant.where}</span> : null}
			</div>
			{facts.length > 0 ? <p css={smallMutedCss}>{facts.join(' · ')}</p> : null}
			{grant.before || grant.after ? (
				<dl
					css={{
						margin: 0,
						display: 'grid',
						gridTemplateColumns: 'max-content 1fr',
						columnGap: spacing.sm,
						rowGap: spacing.xs,
						'& dt': { color: colors.textMuted },
						'& dd': { margin: 0 },
					}}
				>
					<dt>Approved before</dt>
					<dd>{grant.before ?? 'Nothing'}</dd>
					<dt>After</dt>
					<dd>
						<strong>{grant.after ?? 'Removed'}</strong>
					</dd>
				</dl>
			) : null}
			{grant.match ? <p css={{ margin: 0 }}>{grant.match}</p> : null}
		</li>
	)
}

export function ApprovalBundleRoute({
	payload,
	orgSlug,
	bundleId,
	queryKey,
}: {
	payload: ApprovalBundleLoaderData
	orgSlug: string
	bundleId: string
	queryKey: QueryKey
}) {
	const path = { orgSlug, bundleId }
	const client = useQueryClient()
	const { actorKey } = useMatchedPageScope()
	const capture = useSubmitterScope()
	const claims = useRef(new Set<string>())
	const batch = useRef(false)
	const [busy, setBusy] = useState(new Set<string>())
	const [errors, setErrors] = useState(new Map<string, string>())
	const [confirmingDeny, setConfirmingDeny] = useState<string | null>(null)
	const [approveAll, setApproveAll] = useState<{
		approved: number
		failed: number
		total: number
	} | null>(null)
	const [batchItems, setBatchItems] = useState(
		new Map<string, BatchItemState>(),
	)
	const [summary, setSummary] = useState<string | null>(null)
	const permissions = permissionsMutationOptions(client, actorKey)
	const mutation = useMutation({
		...permissions,
		onMutate: async () => ({ ...(await permissions.onMutate()), queryKey }),
		retry: false,
		gcTime: 0,
		mutationFn: decideApprovalBundle,
		onSuccess: async (result, _input, submitted) => {
			const queryKey = submitted.queryKey
			if (!result.item) return
			const item = result.item
			await client.cancelQueries({ queryKey, exact: true })
			client.setQueryData<ApprovalBundleLoaderData>(queryKey, (old) =>
				replaceItem(old, item),
			)
		},
	})
	const approveAllMutation = useMutation({
		...permissions,
		retry: false,
		gcTime: 0,
		mutationFn: async (input: {
			path: BundlePath
			queue: Array<ApprovalItemView>
			isCurrent: () => boolean
		}) => {
			const response = await approveAllApprovalBundle({
				data: {
					...input.path,
					items: input.queue.map((item) => ({
						item: item.key,
						fingerprint: item.fingerprint!,
					})),
				},
			})
			if (!response.ok) throw new Error(response.error)
			let approved = 0
			let failed = 0
			const settled = new Set<string>()
			for await (const event of response.events) {
				if (!input.isCurrent()) continue
				if (event.phase === 'approving') {
					setBatchItems((previous) =>
						new Map(previous).set(event.item, 'approving'),
					)
					continue
				}
				settled.add(event.item)
				const { result } = event
				if (result.ok) approved += 1
				else failed += 1
				setBatchItems((previous) => {
					const next = new Map(previous)
					next.delete(event.item)
					return next
				})
				if (!result.ok)
					setErrors((previous) =>
						new Map(previous).set(event.item, result.error),
					)
				const item = result.item
				if (item) {
					await client.cancelQueries({ queryKey, exact: true })
					client.setQueryData<ApprovalBundleLoaderData>(queryKey, (old) =>
						replaceItem(old, item),
					)
				}
				setApproveAll({ approved, failed, total: input.queue.length })
			}
			return { approved, settled }
		},
	})
	async function decide(
		path: BundlePath,
		item: ApprovalItemView,
		action: 'approve' | 'deny',
	): Promise<boolean> {
		if (batch.current) return false
		if (claims.current.has(item.key) || !item.fingerprint) return false
		claims.current.add(item.key)
		setBusy(new Set(claims.current))
		setErrors((previous) => {
			const next = new Map(previous)
			next.delete(item.key)
			return next
		})
		const isCurrent = capture()
		try {
			const result = await mutation.mutateAsync({
				data: {
					...path,
					action,
					item: item.key,
					fingerprint: item.fingerprint,
				},
			})
			if (!result.ok && isCurrent())
				setErrors((previous) => new Map(previous).set(item.key, result.error))
			return result.ok
		} catch (error) {
			if (isCurrent())
				setErrors((previous) =>
					new Map(previous).set(
						item.key,
						error instanceof Error
							? error.message
							: 'Kody could not be reached. Try again.',
					),
				)
			return false
		} finally {
			claims.current.delete(item.key)
			if (isCurrent()) setBusy(new Set(claims.current))
			if (claims.current.size === 0 && !batch.current)
				void client.invalidateQueries({
					queryKey,
					exact: true,
				})
		}
	}
	async function runApproveAll(path: BundlePath, view: ApprovalBundleView) {
		if (batch.current) return
		const queue = approvalItemsReadyToApprove(view).filter(
			(item) => !claims.current.has(item.key) && item.fingerprint,
		)
		if (queue.length === 0) return
		batch.current = true
		setApproveAll({ approved: 0, failed: 0, total: queue.length })
		setBatchItems(new Map(queue.map((item) => [item.key, 'queued'])))
		setSummary(null)
		setErrors((previous) => {
			const next = new Map(previous)
			for (const item of queue) next.delete(item.key)
			return next
		})
		const isCurrent = capture()
		try {
			const { approved, settled } = await approveAllMutation.mutateAsync({
				path,
				queue,
				isCurrent,
			})
			if (!isCurrent()) return
			const lost = queue.filter((item) => !settled.has(item.key))
			if (lost.length > 0)
				setErrors((previous) => {
					const next = new Map(previous)
					for (const item of lost)
						next.set(
							item.key,
							'Kody stopped reporting on this approval. Reload to see whether it finished.',
						)
					return next
				})
			setSummary(approveAllSummary({ approved, total: queue.length }))
		} catch (error) {
			if (isCurrent())
				setSummary(
					error instanceof Error
						? error.message
						: 'Kody could not be reached. Try again.',
				)
		} finally {
			batch.current = false
			if (isCurrent()) {
				setApproveAll(null)
				setBatchItems(new Map())
			}
			void client.invalidateQueries({
				queryKey,
				exact: true,
			})
		}
	}

	function renderItem(path: BundlePath, item: ApprovalItemView): ReactNode {
		const batchState = batchItems.get(item.key) ?? null
		const isBusy = busy.has(item.key) || batchState === 'approving'
		const locked = isBusy || approveAll !== null
		const error = errors.get(item.key) ?? null
		const decided = item.status !== 'pending'
		return (
			<li
				key={item.key}
				data-testid="approval-bundle-item"
				data-item={item.key}
				data-status={item.status}
				data-progress={batchState ?? undefined}
				css={{
					display: 'grid',
					gap: spacing.sm,
					paddingTop: spacing.md,
					borderTop: `1px solid ${colors.border}`,
				}}
			>
				<div
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'baseline',
						justifyContent: 'space-between',
					}}
				>
					<h3
						css={{
							margin: 0,
							fontSize: typography.fontSize.base,
							fontWeight: typography.fontWeight.semibold,
						}}
					>
						{item.title}
					</h3>
					<span
						data-testid="approval-bundle-item-status"
						css={{
							fontSize: typography.fontSize.sm,
							fontWeight: typography.fontWeight.semibold,
							color: batchState ? colors.textMuted : statusColor(item.status),
							padding: `0 ${spacing.sm}`,
							borderRadius: radius.full,
							border: `1px solid currentColor`,
						}}
					>
						{batchState === 'approving'
							? 'Approving…'
							: batchState === 'queued'
								? 'Queued'
								: approvalItemStatusLabel(item.status)}
					</span>
				</div>
				<p css={{ margin: 0, whiteSpace: 'pre-wrap' }}>{item.summary}</p>
				{item.grants.length > 0 ? (
					<ul css={listCss}>{item.grants.map(renderGrant)}</ul>
				) : null}
				{item.fingerprint && item.detailLabel ? (
					<details
						data-testid="approval-bundle-item-details"
						css={accountDisclosureCss}
					>
						<summary>Details</summary>
						<MetadataGrid
							items={[
								{
									key: 'id',
									label: item.detailLabel,
									value: (
										<IdValue
											value={item.fingerprint}
											label={item.detailLabel.toLowerCase()}
										/>
									),
								},
							]}
						/>
					</details>
				) : null}
				{item.statusMessage ? <p css={mutedCss}>{item.statusMessage}</p> : null}
				{item.securityAudit && item.reviewHref ? (
					<p data-testid="approval-bundle-security-audit" css={smallMutedCss}>
						Security audit:{' '}
						<SiteLink href={`${item.reviewHref}#${packageSecurityAuditAnchor}`}>
							{item.securityAudit.status === 'not_audited' ? (
								'No security audit performed'
							) : (
								<>
									{auditedLabel(item.securityAudit)} ·{' '}
									{item.securityAudit.verdict === 'pass' ? 'Pass' : 'Concerns'}
								</>
							)}
						</SiteLink>
					</p>
				) : null}
				{error ? (
					<p
						role="alert"
						data-testid="approval-bundle-item-error"
						css={{ margin: 0, color: colors.danger }}
					>
						{error}
					</p>
				) : null}
				<div
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
					}}
				>
					{!decided && item.canApprove ? (
						<Button
							type="button"
							data-testid="approval-bundle-approve"
							disabled={locked}
							variant="primary"
							size="md"
							onClick={() => void decide(path, item, 'approve')}
						>
							{isBusy ? 'Working…' : 'Approve'}
						</Button>
					) : null}
					{!decided && item.canDeny ? (
						confirmingDeny === item.key ? (
							<>
								<Button
									type="button"
									data-testid="approval-bundle-deny-confirm"
									disabled={locked}
									variant="danger"
									size="md"
									onClick={() => {
										setConfirmingDeny(null)
										void decide(path, item, 'deny')
									}}
								>
									{item.type === 'publish' ? 'Deny and drop it' : 'Deny'}
								</Button>
								<Button
									type="button"
									disabled={locked}
									variant="secondary"
									size="md"
									onClick={() => {
										setConfirmingDeny(null)
									}}
								>
									Keep
								</Button>
							</>
						) : (
							<Button
								type="button"
								data-testid="approval-bundle-deny"
								disabled={locked}
								variant="secondary"
								size="md"
								onClick={() => {
									setConfirmingDeny(item.key)
								}}
							>
								Deny
							</Button>
						)
					) : null}
					{item.reviewHref ? (
						<SiteLink href={item.reviewHref} css={smallMutedCss}>
							Open its own approval page
						</SiteLink>
					) : null}
				</div>
			</li>
		)
	}

	function renderGroup(
		path: BundlePath,
		group: ApprovalBundlePackageGroup,
		index: number,
	) {
		return (
			<section
				key={group.package?.id ?? `unavailable-${index}`}
				aria-label={group.package?.name ?? 'Unavailable items'}
				data-testid="approval-bundle-group"
				css={{ ...cardCss, gap: spacing.sm }}
			>
				<h2 css={cardTitleCss}>
					{group.package ? (
						<SiteLink href={group.package.href}>
							<code>{group.package.kodyId}</code>
						</SiteLink>
					) : (
						'No longer available'
					)}
				</h2>
				{group.package && group.package.name !== group.package.kodyId ? (
					<p css={smallMutedCss}>{group.package.name}</p>
				) : null}
				<ul css={listCss}>
					{group.items.map((item) => renderItem(path, item))}
				</ul>
			</section>
		)
	}

	if (!payload.ok) {
		if (payload.reason === 'unavailable') {
			return (
				<section css={stackedPageCss} data-testid="approval-bundle">
					<header css={pageHeaderCss}>
						<span css={pageEyebrowCss}>Review approvals</span>
						<h1 css={pageTitleCss}>Nothing here for you to approve</h1>
						<p css={pageDescriptionCss}>
							This approval link is not waiting on you in @{orgSlug}. It may be
							meant for someone else, already approved or denied, or withdrawn
							by the agent. Ask your agent for a new link to review whatever
							still waits.
						</p>
					</header>
				</section>
			)
		}

		return (
			<section css={stackedPageCss} data-testid="approval-bundle">
				<header css={pageHeaderCss}>
					<span css={pageEyebrowCss}>Review approvals</span>
					<h1 css={pageTitleCss}>This link expired</h1>
					<p css={pageDescriptionCss}>
						Approval links stop working after 30 days. Anything you already
						approved or denied from this link stays in effect. Ask your agent
						for a new link to review whatever still waits.
					</p>
				</header>
			</section>
		)
	}
	const view = payload.view
	const groups = view.groups
	const remaining = approvalItemsAwaitingDecision(view).length
	const ready = approvalItemsReadyToApprove(view).length

	const items = groups.flatMap((group) => group.items)
	const allDecided =
		items.length > 0 && items.every((item) => item.decision !== null)

	return (
		<section
			css={stackedPageCss}
			data-testid="approval-bundle"
			aria-busy={busy.size > 0 || approveAll ? 'true' : undefined}
		>
			<header css={pageHeaderCss}>
				<span css={pageEyebrowCss}>Review approvals</span>
				<h1 css={pageTitleCss}>
					{!view
						? 'Review approvals'
						: remaining > 0
							? remaining === 1
								? '1 change waits for you'
								: `${remaining} changes wait for you`
							: allDecided
								? `All ${items.length} ${items.length === 1 ? 'change is' : 'changes are'} decided`
								: 'Nothing here waits for you'}
				</h1>
				<p css={pageDescriptionCss}>
					An agent
					{view?.bundle.createdVia
						? ` using ${view.bundle.createdVia}`
						: ''}{' '}
					gathered these for <code>@{path.orgSlug}</code>. Nothing changes until
					you approve. Each approval does exactly what it would on the package’s
					own approval page. Credential values are never shown.
				</p>
			</header>

			{view?.bundle.note ? (
				<section
					aria-label="Note from your agent"
					data-testid="approval-bundle-note"
					css={{ ...cardCss, borderLeft: `4px solid ${colors.border}` }}
				>
					<p css={smallMutedCss}>
						Note from the agent that made this link (Kody did not write this):
					</p>
					<p css={{ margin: 0, whiteSpace: 'pre-wrap' }}>{view.bundle.note}</p>
				</section>
			) : null}

			{view ? (
				<section
					css={{
						display: 'grid',
						gap: spacing.sm,
						justifyItems: 'start',
					}}
				>
					<Button
						type="button"
						data-testid="approval-bundle-approve-all"
						disabled={ready === 0 || approveAll !== null}
						variant="primary"
						size="md"
						onClick={() => void runApproveAll(path, view)}
					>
						{approveAll
							? approvingAllLabel(approveAll.total)
							: approveAllLabel(ready, remaining)}
					</Button>
					{approveAll ? (
						<p
							role="status"
							data-testid="approval-bundle-progress"
							css={smallMutedCss}
						>
							{approveAllProgress(approveAll)}
						</p>
					) : null}
					{summary ? (
						<p
							role="status"
							data-testid="approval-bundle-summary"
							css={{ margin: 0 }}
						>
							{summary}
						</p>
					) : null}
				</section>
			) : null}

			{groups.map((group, index) => renderGroup(path, group, index))}
		</section>
	)
}
