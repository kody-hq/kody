/** @jsxImportSource @emotion/react */
import {
	IdValue,
	MetadataGrid,
	accountDisclosureCss,
} from './account-management-components.tsx'
import { auditedLabel } from './package-security-audit-field.tsx'
import { packageSecurityAuditAnchor } from '#universal/package-security-audit-prompt.ts'
import { useState, useRef, type ReactNode } from 'react'
import { type CSSObject } from '@emotion/react'
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { decideApprovalBundle } from '#start/server/approval-bundles'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { permissionsMutationOptions } from '../permissions-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { SiteLink } from '../components/site-link.tsx'
import { NotFoundPage } from '../components/not-found-page.tsx'
import {
	approvalItemsAwaitingDecision,
	approvalItemsReadyToApprove,
	approvalItemStatusLabel,
	approveAllLabel,
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
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
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

const approveAllButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const approveButtonCss = getPrimaryButtonCss({ size: 'md' })
const denyButtonCss = getSecondaryButtonCss({ size: 'md' })
const denyConfirmButtonCss = getDangerButtonCss({ size: 'md' })
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
		done: number
		total: number
	} | null>(null)
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
			const matches = { queryKey, exact: true }
			await client.cancelQueries(matches)
			client.setQueryData<ApprovalBundleLoaderData>(queryKey, (old) =>
				old?.ok
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
					: old,
			)
		},
	})
	async function decide(
		path: BundlePath,
		item: ApprovalItemView,
		action: 'approve' | 'deny',
		fromBatch = false,
	): Promise<boolean> {
		if (batch.current && !fromBatch) return false
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
			(item) => !claims.current.has(item.key),
		)
		if (queue.length === 0) return
		batch.current = true
		setApproveAll({ done: 0, total: queue.length })
		setSummary(null)
		const isCurrent = capture()
		let approved = 0
		try {
			for (const [index, item] of queue.entries()) {
				if (!isCurrent()) break
				if (await decide(path, item, 'approve', true)) approved += 1
				if (isCurrent()) setApproveAll({ done: index + 1, total: queue.length })
			}
			const failed = queue.length - approved
			if (isCurrent())
				setSummary(
					failed === 0
						? `Approved ${approved} of ${queue.length}.`
						: `Approved ${approved} of ${queue.length}. ${failed} need${failed === 1 ? 's' : ''} another look; see the message on ${failed === 1 ? 'it' : 'each'}.`,
				)
		} finally {
			batch.current = false
			if (isCurrent()) setApproveAll(null)
			void client.invalidateQueries({
				queryKey,
				exact: true,
			})
		}
	}

	function renderItem(path: BundlePath, item: ApprovalItemView): ReactNode {
		const isBusy = busy.has(item.key)
		const locked = isBusy || approveAll !== null
		const error = errors.get(item.key) ?? null
		const decided = item.status !== 'pending'
		return (
			<li
				key={item.key}
				data-testid="approval-bundle-item"
				data-item={item.key}
				data-status={item.status}
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
							color: statusColor(item.status),
							padding: `0 ${spacing.sm}`,
							borderRadius: radius.full,
							border: `1px solid currentColor`,
						}}
					>
						{approvalItemStatusLabel(item.status)}
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
						<button
							type="button"
							data-testid="approval-bundle-approve"
							disabled={locked}
							css={approveButtonCss}
							onClick={() => void decide(path, item, 'approve')}
						>
							{isBusy ? 'Working…' : 'Approve'}
						</button>
					) : null}
					{!decided && item.canDeny ? (
						confirmingDeny === item.key ? (
							<>
								<button
									type="button"
									data-testid="approval-bundle-deny-confirm"
									disabled={locked}
									css={denyConfirmButtonCss}
									onClick={() => {
										setConfirmingDeny(null)
										void decide(path, item, 'deny')
									}}
								>
									{item.type === 'publish' ? 'Deny and drop it' : 'Deny'}
								</button>
								<button
									type="button"
									disabled={locked}
									css={denyButtonCss}
									onClick={() => {
										setConfirmingDeny(null)
									}}
								>
									Keep
								</button>
							</>
						) : (
							<button
								type="button"
								data-testid="approval-bundle-deny"
								disabled={locked}
								css={denyButtonCss}
								onClick={() => {
									setConfirmingDeny(item.key)
								}}
							>
								Deny
							</button>
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
		if (payload.reason === 'not-found') return <NotFoundPage />

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
			aria-busy={busy.size > 0 ? 'true' : undefined}
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
					<button
						type="button"
						data-testid="approval-bundle-approve-all"
						disabled={ready === 0 || approveAll !== null}
						css={approveAllButtonCss}
						onClick={() => void runApproveAll(path, view)}
					>
						{approveAll
							? `Approving ${Math.min(approveAll.done + 1, approveAll.total)} of ${approveAll.total}…`
							: approveAllLabel(ready, remaining)}
					</button>
					{approveAll ? (
						<p css={smallMutedCss}>
							Publishes can take a moment each. Keep this page open.
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
