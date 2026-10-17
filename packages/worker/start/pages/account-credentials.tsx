/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { validateCredentialSearch } from '../credentials-query.ts'
import { docHref } from '#universal/docs-nav.ts'
import { SiteLink } from '../components/site-link.tsx'

import { css } from '@emotion/react'
import { useRouter } from '@tanstack/react-router'
import { Combobox, type ComboboxOption } from '../components/combobox.tsx'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { renderCredentialDetail } from './account-credential-detail.tsx'
import {
	credentialManageHref,
	credentialsRoute,
} from '#client/routes/account-credentials-shared.ts'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordCellClamp,
} from './record-table.tsx'
import {
	type CredentialListFilters,
	type CredentialListItem,
	orgCredentialCreatePath,
	credentialKinds,
	isCredentialKind,
} from '#universal/credential-contracts.ts'
import {
	type AccountCredentialsResponse,
	type CredentialProviderBindingItem,
	credentialKindLabel,
	credentialStatusLabel,
	filterCredentialList,
	readCredentialListFilters,
	writeCredentialListQuery,
} from '#universal/credentials-list.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
const clampedCellCss = css(recordCellClamp(26))
const packageFilterSlotCss = {
	flex: '0 1 15rem',
	minWidth: '9rem',
	'@container (max-width: 620px)': { flex: '1 1 100%' },
}
const headerActionsCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.sm,
})
function credentialsAgentPrompt(input: { pageUrl: string; message: string }) {
	return [
		`I opened my credentials on Kody: ${input.pageUrl}`,
		`Kody said: ${input.message}`,
		'Help me find out why. Do not ask me to paste any credential value into chat.',
	].join('\n')
}
function renderCredentialsError(input: { pageUrl: string; message: string }) {
	return (
		<div
			data-testid="credentials-error"
			css={{ display: 'grid', justifyItems: 'start', gap: spacing.sm }}
		>
			<AccountManagementMessage tone="error">
				{input.message}
			</AccountManagementMessage>
			<CopyTextButton
				value={credentialsAgentPrompt(input)}
				idleLabel="Copy prompt for your agent"
			/>
		</div>
	)
}
function scopeLabel(credential: CredentialListItem) {
	return credential.scope === 'personal' ? 'Personal' : 'Org'
}
function statusColor(credential: CredentialListItem) {
	switch (credential.status) {
		case 'ok':
			return colors.text
		case 'expired':
		case 'needs_attention':
			return colors.error
		case 'disabled':
			return colors.textMuted
		default: {
			const exhaustive: never = credential.status
			return exhaustive
		}
	}
}
/** The kind, with its provider when that adds something. */
function kindCellLabel(credential: CredentialListItem) {
	const kind = credentialKindLabel(credential.kind)
	const provider = credential.provider
	return provider && provider !== credential.name
		? `${kind} · ${provider}`
		: kind
}
function hostsLabel(hosts: ReadonlyArray<string>) {
	if (hosts.length === 0) return '—'
	const [first, ...rest] = hosts
	return rest.length > 0 ? `${first} +${rest.length}` : (first ?? '—')
}
function packageLabel(
	credential: CredentialListItem,
	packagesById: ReadonlyMap<
		string,
		{
			kodyId: string
		}
	>,
) {
	const name = (id: string) => packagesById.get(id)?.kodyId ?? id
	if (credential.packageId)
		return `Package value · ${name(credential.packageId)}`
	const [first, ...rest] = credential.lockedToPackageIds
	if (!first) return '—'
	return rest.length > 0
		? `Locked to ${name(first)} +${rest.length}`
		: `Locked to ${name(first)}`
}
/**
 * Vault bindings are not a credential kind, so kind, owner, and package-scope
 * filters hide them; a chosen package keeps the vault it unlocks.
 */
function filterProviderBindings(
	providers: ReadonlyArray<CredentialProviderBindingItem>,
	filters: CredentialListFilters,
) {
	if (
		filters.kinds?.length ||
		filters.scope ||
		filters.packageScoped !== undefined ||
		filters.locked === true
	) {
		return []
	}
	const query = filters.q?.toLowerCase() ?? ''
	return providers.filter(
		(binding) =>
			(typeof filters.locked !== 'string' ||
				binding.packageId === filters.locked) &&
			(!query ||
				[binding.providerId, binding.provider ?? ''].some((text) =>
					text.toLowerCase().includes(query),
				)),
	)
}
const packageScopeOptions = ['any', 'scoped', 'unscoped', 'locked'] as const
type PackageScopeOption = (typeof packageScopeOptions)[number]
function packageScopeOption(
	filters: CredentialListFilters,
): PackageScopeOption {
	if (filters.packageScoped === true) return 'scoped'
	if (filters.packageScoped === false) return 'unscoped'
	if (filters.locked === true) return 'locked'
	return 'any'
}
/** Package-scope choice as filters. A chosen package (`locked: id`) stays. */
function packageScopeFilters(
	option: PackageScopeOption,
	current: CredentialListFilters,
): CredentialListFilters {
	const lockedPackage =
		typeof current.locked === 'string' ? current.locked : undefined
	switch (option) {
		case 'any':
			return { ...current, packageScoped: undefined, locked: lockedPackage }
		case 'scoped':
			return { ...current, packageScoped: true, locked: lockedPackage }
		case 'unscoped':
			return { ...current, packageScoped: false, locked: lockedPackage }
		case 'locked':
			return { ...current, packageScoped: undefined, locked: true }
		default: {
			const exhaustive: never = option
			return exhaustive
		}
	}
}
function isPackageScopeOption(value: string): value is PackageScopeOption {
	return (packageScopeOptions as ReadonlyArray<string>).includes(value)
}
/**
 * `/@slug/-/credentials`: every credential the org holds, whatever its kind
 * (Key, OAuth, MCP server, URL, login, signing, vault), in one searchable
 * list. Metadata only; values never reach this page.
 */
export function AccountCredentialsRoute({
	payload,
	currentHref,
	selectedId,
}: {
	payload: AccountCredentialsResponse
	selectedId: string | null
	currentHref: string
}) {
	const router = useRouter()
	const { pageLocation } = useMatchedPageScope()
	function readFilters(search: Record<string, unknown>) {
		const params = new URLSearchParams()
		for (const [key, value] of Object.entries(search)) {
			for (const item of Array.isArray(value) ? value : [value]) {
				if (item !== undefined && item !== null)
					params.append(key, String(item))
			}
		}
		return readCredentialListFilters(params)
	}
	function updateFilters(
		next: (current: CredentialListFilters) => CredentialListFilters,
	) {
		const matchedUrl = pageLocation
		const pathname: string = matchedUrl.pathname
		const samePage = router.latestLocation.pathname === matchedUrl.pathname
		return router.navigate({
			to: pathname,
			replace: true,
			resetScroll: false,
			search: (previous: Record<string, unknown>) => {
				// Consecutive edits compose before navigation commits, but a retained
				// toolbar cannot inherit another page's pending search or organization.
				const search: Record<string, unknown> = samePage
					? { ...previous }
					: { ...router.options.parseSearch!(matchedUrl.searchStr) }
				const params = new URLSearchParams()
				writeCredentialListQuery(
					params,
					next({
						...readFilters(search),
						q: typeof search.q === 'string' ? search.q : undefined,
					}),
				)
				for (const key of ['q', 'kind', 'scope', 'packageScoped', 'locked']) {
					const values = params.getAll(key)
					if (!values.length) delete search[key]
					else search[key] = values.length === 1 ? values[0] : values
				}
				return search
			},
		})
	}

	const pageUrl =
		typeof window === 'undefined'
			? currentHref
			: new URL(currentHref, window.location.origin).href
	const credentials = payload?.credentials ?? []
	const packages = payload?.packages ?? []
	const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]))
	const filters = readFilters(pageLocation.search)
	const filtered = filterCredentialList(credentials, filters)
	const orgSlug = payload?.orgSlug ?? ''
	const teamOrg = payload?.teamOrg ?? false
	const search = pageLocation.searchStr
	const selectedItem =
		credentials.find((item) => item.id === selectedId) ?? null
	const selectedDetail =
		payload?.selected && payload.selected.id === selectedId
			? payload.selected
			: null
	const personalOrgSlug = payload?.personalOrgSlug ?? null
	// The open row stays visible so its pane can render under any filter.
	const shown =
		selectedItem && !filtered.includes(selectedItem)
			? [selectedItem, ...filtered]
			: filtered
	const selectedMissing = selectedId !== null && !selectedItem
	const lockedPackageId =
		typeof filters.locked === 'string' ? filters.locked : ''
	const shownProviders = filterProviderBindings(
		payload?.providers ?? [],
		filters,
	)
	const packageOptions: Array<ComboboxOption> = [
		{ id: '', label: 'Any package' },
		...packages.map((pkg) => ({
			id: pkg.id,
			label: pkg.kodyId,
			keywords: [pkg.id, pkg.name],
		})),
	]
	return (
		<AccountManagementShell currentHref={currentHref}>
			<AccountPageHeader
				entity="credentials"
				title="Credentials"
				description="Keys, OAuth connections, MCP servers, and every other way Kody reaches a service for you. Kody places each value at the network boundary; values never appear here."
				currentHref={currentHref}
				actions={
					<div css={headerActionsCss}>
						{orgSlug ? (
							<>
								<SiteLink
									href={orgCredentialCreatePath(orgSlug)}
									css={getPillButtonCss({ size: 'sm' })}
								>
									Add credential
								</SiteLink>
								<SiteLink
									href={orgResourcePath(orgSlug, 'secret-providers')}
									css={getGhostButtonCss({ size: 'sm' })}
								>
									Secret providers
								</SiteLink>
							</>
						) : null}
						<SiteLink
							href={docHref('credentials')}
							css={getGhostButtonCss({ size: 'sm' })}
						>
							How credentials work
						</SiteLink>
					</div>
				}
			/>

			{selectedMissing
				? renderCredentialsError({
						message:
							'That credential was not found in this org. It may have been deleted, or it belongs to another org.',
						pageUrl,
					})
				: null}

			<RecordTable
				mode="expand"
				ariaLabel="Credentials"
				selectedId={selectedItem ? selectedItem.id : null}
				recordLoading={false}
				record={
					selectedItem
						? renderCredentialDetail({
								credential: selectedItem,
								detail: selectedDetail,
								manageHref: credentialManageHref(selectedItem, {
									orgSlug,
									personalOrgSlug,
								}),
								teamOrg,
								packagesById,
								orgSlug,
							})
						: undefined
				}
				countLabel={`${shown.length} of ${credentials.length} shown`}
				emptyLabel={
					credentials.length === 0
						? shownProviders.length > 0
							? 'No keys, OAuth connections, or MCP servers yet. Your custom secret providers are listed below.'
							: 'No credentials yet. Add a key, connect an OAuth service, or add an MCP server to get started.'
						: 'No credentials match the current filters.'
				}
				toolbar={
					<>
						<RecordTableSearch
							label="Search credentials"
							placeholder="Search credentials"
							value={validateCredentialSearch(pageLocation.search).q ?? ''}
							onInput={(q) =>
								updateFilters((current) => ({
									...current,
									q: q || undefined,
								}))
							}
						/>
						<RecordTableSelect
							label="Filter credentials by kind"
							value={
								filters.kinds?.length === 1
									? (filters.kinds[0] ?? 'all')
									: 'all'
							}
							onChange={(value) =>
								updateFilters((current) => ({
									...current,
									kinds: isCredentialKind(value) ? [value] : undefined,
								}))
							}
						>
							<option value="all">All kinds</option>
							{credentialKinds.map((kind) => (
								<option key={kind} value={kind}>
									{credentialKindLabel(kind)}
								</option>
							))}
						</RecordTableSelect>
						{teamOrg ? (
							<RecordTableSelect
								label="Filter credentials by owner"
								value={filters.scope ?? 'all'}
								onChange={(value) =>
									updateFilters((current) => ({
										...current,
										scope:
											value === 'org' || value === 'personal'
												? value
												: undefined,
									}))
								}
							>
								<option value="all">Org and personal</option>
								<option value="org">Org</option>
								<option value="personal">Personal</option>
							</RecordTableSelect>
						) : null}
						<RecordTableSelect
							label="Filter credentials by package scope"
							value={packageScopeOption(filters)}
							onChange={(value) =>
								updateFilters((current) =>
									packageScopeFilters(
										isPackageScopeOption(value) ? value : 'any',
										current,
									),
								)
							}
						>
							<option value="any">Any package scope</option>
							<option value="scoped">Package-scoped keys</option>
							<option value="unscoped">Not package-scoped</option>
							<option value="locked">Locked to a package</option>
						</RecordTableSelect>
						{packages.length > 0 ? (
							<span css={packageFilterSlotCss}>
								<Combobox
									key={`credential-package-filter:${lockedPackageId}`}
									id="credential-package-filter"
									label="Filter credentials locked to a package"
									hideLabel
									placeholder="Any package"
									value={lockedPackageId}
									options={packageOptions}
									onChange={(packageId) =>
										updateFilters((current) => ({
											...current,
											locked: packageId || undefined,
										}))
									}
								/>
							</span>
						) : null}
					</>
				}
				columns={[
					{ key: 'name', label: 'Credential', primary: true },
					{ key: 'kind', label: 'Kind' },
					...(teamOrg
						? [{ key: 'owner', label: 'Owner', drop: 2 as const }]
						: []),
					{ key: 'hosts', label: 'Hosts', drop: 1 },
					{ key: 'package', label: 'Packages', drop: 2 },
					{ key: 'status', label: 'Status' },
				]}
				rows={shown.map((credential) => ({
					id: credential.id,
					href:
						credential.id === selectedId
							? credentialsRoute.buildListHref(search, currentHref)
							: credentialsRoute.buildDetailHref(
									credential.id,
									search,
									currentHref,
								),
					cells: {
						name: <span css={clampedCellCss}>{credential.name}</span>,
						kind: <span css={clampedCellCss}>{kindCellLabel(credential)}</span>,
						owner: scopeLabel(credential),
						hosts: (
							<span css={clampedCellCss}>{hostsLabel(credential.hosts)}</span>
						),
						package: (
							<span css={clampedCellCss}>
								{packageLabel(credential, packagesById)}
							</span>
						),
						status: (
							<span
								title={credential.statusMessage ?? undefined}
								css={{ color: statusColor(credential) }}
							>
								{credentialStatusLabel(credential.status)}
							</span>
						),
					},
				}))}
			/>

			{shownProviders.length > 0 ? (
				<AccountManagementPanel
					title="Custom secret providers"
					description="Vaults (like 1Password) that resolve secret references when a run needs them. Each is unlocked by a door secret stored in a package."
				>
					<RecordTable
						mode="none"
						ariaLabel="Custom secret providers"
						countLabel={`${shownProviders.length} connected`}
						columns={[
							{ key: 'provider', label: 'Secret provider', primary: true },
							{ key: 'package', label: 'Unlocked by', drop: 1 },
						]}
						rows={shownProviders.map((binding) => ({
							id: binding.id,
							href: orgResourcePath(orgSlug, 'secret-providers'),
							cells: {
								provider: (
									<span css={clampedCellCss}>
										{binding.provider ?? binding.providerId}
									</span>
								),
								package: (
									<span css={clampedCellCss}>
										{`${binding.doorSecretName} in ${
											packagesById.get(binding.packageId)?.kodyId ??
											binding.packageId
										}`}
									</span>
								),
							},
						}))}
					/>
				</AccountManagementPanel>
			) : null}
		</AccountManagementShell>
	)
}
