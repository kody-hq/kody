/** @jsxImportSource @emotion/react */
import {
	DesktopMachinePanel,
	useDesktopMachine,
} from '../components/desktop-execution.tsx'
import { css } from '@emotion/react'
import { useRouter } from '@tanstack/react-router'
import { createListDetailLinks } from '#client/list-detail-route.ts'
import { registerCopy } from '#universal/execution-context-trust-copy.ts'
import {
	type ExecutionContextListItem,
	type ExecutionContextsPageData,
	contextAccessCell,
	contextDisplayStatus,
	displayStatusLabel,
	grantSummaryCell,
	ordinal,
	unutilizedNote,
} from '#universal/execution-contexts.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { ExperimentOptIn } from '../components/experiment-opt-in.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { routes } from '#universal/routes.ts'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { ExecutionChainPanel } from './execution-context-chain.tsx'
import { ExecutionContextDetail } from './execution-context-detail.tsx'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
} from './record-table.tsx'

const mutedCss = css({ color: colors.textMuted, margin: 0 })
const codeCss = css({
	margin: 0,
	padding: spacing.sm,
	borderRadius: radius.md,
	background: colors.background,
	border: `1px solid ${colors.borderSubtle}`,
	whiteSpace: 'pre-wrap',
	overflowWrap: 'anywhere',
	fontSize: '0.9rem',
})

const statusFilters = [
	{ id: '', label: 'Any status' },
	{ id: 'online', label: 'Online' },
	{ id: 'offline', label: 'Offline' },
	{ id: 'revoked', label: 'Revoked' },
	{ id: 'not-in-chain', label: 'Not in any chain' },
] as const

function accessLabel(
	context: ExecutionContextListItem,
	chain: Extract<ExecutionContextsPageData, { enabled: true }>['chain'],
) {
	const cell = contextAccessCell(context, chain)
	switch (cell.kind) {
		case 'in-chain':
			return `${ordinal(cell.position)} in your chain`
		case 'yours':
			return 'Yours'
		case 'opted-in':
			return 'Opted in'
		case 'opt-in':
			return 'Shared with you, opt in to use'
		case 'not-usable':
			return 'Not usable here'
		case 'unavailable':
			return 'Unavailable'
	}
}

function chainCell(context: ExecutionContextListItem) {
	if (context.status === 'revoked') return 'Revoked'
	if (context.chainUsage.chainCount === 0) return 'Not in any chain'
	return context.chainUsage.inMyChain ? 'In your chain' : 'Not in your chain'
}

export function ExecutionContextsRoute(props: {
	payload: ExecutionContextsPageData
	selectedId: string | null
	currentHref: string
}) {
	const { payload, currentHref } = props
	const desktop = useDesktopMachine()
	if (!payload.enabled) {
		return (
			<AccountManagementShell layout="list" currentHref={currentHref}>
				<AccountPageHeader
					entity="execution-contexts"
					title="Execution contexts"
					description="Run execute on your own machines and shared servers, in the order you choose."
					currentHref={currentHref}
				/>
				<DesktopMachinePanel />
				{!desktop ? (
					<AccountManagementPanel>
						<div
							data-testid="execution-contexts-flag-off"
							data-flag="execution-contexts"
						>
							<p css={{ margin: 0 }}>
								Execution contexts are an experiment. Turn them on and run{' '}
								<code>kody daemon</code> on a laptop or build server, and{' '}
								<code>execute</code> and automations can run there with the
								folders and local network you allow. Credentials stay in Kody
								cloud and never reach the machine. When the machine is offline
								or busy, runs fall back to Kody cloud.
							</p>
							<p css={{ margin: '0.5rem 0 0', color: colors.textMuted }}>
								Read the{' '}
								<SiteLink
									href={routes.docDetail.href({ slug: 'execution-contexts' })}
									css={primaryLinkCss}
								>
									execution contexts guide
								</SiteLink>
								, or manage every experiment on{' '}
								<SiteLink
									href={routes.accountExperiments.href()}
									css={primaryLinkCss}
								>
									Experiments
								</SiteLink>
								.
							</p>
							<ExperimentOptIn experiment="execution-contexts">
								Try execution contexts
							</ExperimentOptIn>
						</div>
					</AccountManagementPanel>
				) : null}
			</AccountManagementShell>
		)
	}
	return <EnabledPage {...props} payload={payload} />
}

function EnabledPage(props: {
	payload: Extract<ExecutionContextsPageData, { enabled: true }>
	selectedId: string | null
	currentHref: string
}) {
	const { payload, selectedId, currentHref } = props
	const desktop = useDesktopMachine()
	const router = useRouter()
	const { pageLocation } = useMatchedPageScope()
	const links = createListDetailLinks(
		orgResourcePath(payload.orgSlug, 'execution-contexts'),
	)
	const search = pageLocation.searchStr
	const searchParams = pageLocation.search as Record<string, unknown>
	const q = typeof searchParams.q === 'string' ? searchParams.q : ''
	const status =
		typeof searchParams.status === 'string' ? searchParams.status : ''
	const contexts = payload.contexts
	const filtered = contexts.filter((context) => {
		if (
			q &&
			!`${context.name} ${context.operator.handle}`
				.toLowerCase()
				.includes(q.toLowerCase())
		)
			return false
		if (status === 'not-in-chain') return context.chainUsage.chainCount === 0
		if (status === 'online')
			return ['online', 'busy'].includes(contextDisplayStatus(context))
		if (status) return context.status === status
		return true
	})
	const selected =
		(payload.selected && payload.selected.id === selectedId
			? payload.selected
			: contexts.find((context) => context.id === selectedId)) ?? null
	const shown =
		selected && !filtered.some((context) => context.id === selected.id)
			? [selected, ...filtered]
			: filtered
	const note = unutilizedNote(payload.unutilized)
	const register = registerCopy({
		orgSlug: payload.personalOrg ? null : payload.orgSlug,
	})

	function setSearch(key: 'q' | 'status', value: string) {
		return router.navigate({
			to: pageLocation.pathname,
			replace: true,
			resetScroll: false,
			search: (previous: Record<string, unknown>) => {
				const next = { ...previous }
				if (value) next[key] = value
				else delete next[key]
				return next
			},
		})
	}

	return (
		<AccountManagementShell layout="list" currentHref={currentHref}>
			<AccountPageHeader
				entity="execution-contexts"
				title="Execution contexts"
				description="Your machines and shared servers that run execute, and the order Kody tries them in."
				currentHref={currentHref}
			/>
			<DesktopMachinePanel />
			{note ? (
				<AccountManagementMessage>
					<span data-testid="execution-contexts-unutilized">{note}</span>
				</AccountManagementMessage>
			) : null}
			<AccountManagementPanel>
				<ExecutionChainPanel
					orgSlug={payload.orgSlug}
					chain={payload.chain}
					contexts={payload.contexts}
				/>
			</AccountManagementPanel>
			{props.selectedId && !selected ? (
				<AccountManagementMessage tone="error">
					That execution context does not exist or is not visible to you.
				</AccountManagementMessage>
			) : null}
			<RecordTable
				mode="expand"
				ariaLabel="Execution contexts"
				selectedId={selected ? selected.id : null}
				recordLoading={false}
				record={
					selected ? (
						<ExecutionContextDetail
							orgSlug={payload.orgSlug}
							context={selected}
							chain={payload.chain}
							contexts={payload.contexts}
						/>
					) : undefined
				}
				countLabel={`${shown.length} of ${contexts.length} shown`}
				emptyLabel={
					contexts.length === 0
						? desktop
							? 'No execution contexts yet. Set up this machine above.'
							: 'No execution contexts yet. Register a machine below.'
						: 'No execution contexts match these filters.'
				}
				toolbar={
					<>
						<RecordTableSearch
							label="Search execution contexts"
							placeholder="Search by name or operator"
							value={q}
							onInput={(value) => setSearch('q', value)}
						/>
						<RecordTableSelect
							label="Status"
							value={status}
							onChange={(value) => setSearch('status', value)}
						>
							{statusFilters.map((item) => (
								<option key={item.id} value={item.id}>
									{item.label}
								</option>
							))}
						</RecordTableSelect>
					</>
				}
				columns={[
					{ key: 'name', label: 'Name', primary: true },
					{ key: 'status', label: 'Status' },
					{ key: 'operator', label: 'Operator', drop: 2 },
					{ key: 'access', label: 'Your access', drop: 1 },
					{ key: 'chains', label: 'Chains', drop: 2 },
					{ key: 'exposes', label: 'Exposes', drop: 3 },
				]}
				rows={shown.map((context) => ({
					id: context.id,
					href:
						selected?.id === context.id
							? links.buildListHref(search, currentHref)
							: links.buildDetailHref(context.id, search, currentHref),
					cells: {
						name: context.name,
						status: displayStatusLabel(contextDisplayStatus(context)),
						operator: context.isOperator
							? 'You'
							: `@${context.operator.handle}`,
						access: accessLabel(context, payload.chain),
						chains: chainCell(context),
						exposes: grantSummaryCell(context.grantSummary),
					},
				}))}
			/>
			{!desktop ? (
				<AccountManagementPanel
					title="Register a machine"
					description={register.body}
				>
					<div
						data-testid="execution-contexts-register"
						css={{ display: 'grid', gap: spacing.sm }}
					>
						<pre css={codeCss}>
							<code>{register.commands.join('\n')}</code>
						</pre>
						<div>
							<CopyTextButton
								value={register.commands.join('\n')}
								idleLabel="Copy commands"
							/>
						</div>
						{register.trust.map((line) => (
							<p key={line} css={{ margin: 0 }}>
								{line}
							</p>
						))}
						<p css={mutedCss}>{register.after}</p>
						<p css={mutedCss}>{register.login}</p>
					</div>
				</AccountManagementPanel>
			) : null}
		</AccountManagementShell>
	)
}
