/** @jsxImportSource @emotion/react */
import {
	addOrganizationDomain,
	syncOrganizationDomain,
	deleteOrganizationDomain,
} from '#start/server/org-settings-mutations'
import { type CSSObject } from '@emotion/react'
import { useEffect, useRef, useState } from 'react'
import { orgDomainMutationOptions } from './org-domain-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { type OrgSettingsLoaderData } from '#universal/loader-data.ts'
import { orgBillingPath } from '#universal/org-pages.ts'
import {
	AccountManagementPanel,
	AccountManagementMessage,
	accountFieldCss,
	accountActionsCss,
	accountFieldNoteCss,
	accountFieldLabelCss,
	accountInputCss,
} from './account-management-components.tsx'
import {
	getGhostButtonCss,
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	CustomDomainRecords,
	CustomDomainStatusBadge,
} from '../components/custom-domain-status.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

/** The organization settings query owns domain state and refreshes after writes. */
export function OrgSettingsCustomDomains({
	data,
	queryKey,
}: {
	data: OrgSettingsLoaderData
	queryKey: QueryKey
}) {
	const client = useQueryClient()
	const capture = useSubmitterScope()
	const [notice, setNotice] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const noticeRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (notice) noticeRef.current?.scrollIntoView({ block: 'nearest' })
	}, [notice])
	const [hostname, setHostname] = useState('')
	const [bindingKind, setBindingKind] = useState<'org' | 'app'>('org')
	const [packageId, setPackageId] = useState('')
	const [sslMethod, setSslMethod] = useState<'http' | 'txt'>('txt')
	const add = useMutation(
		orgDomainMutationOptions(client, queryKey, addOrganizationDomain),
	)
	const sync = useMutation(
		orgDomainMutationOptions(client, queryKey, syncOrganizationDomain),
	)
	const remove = useMutation(
		orgDomainMutationOptions(client, queryKey, deleteOrganizationDomain),
	)
	const isPending = add.isPending || sync.isPending || remove.isPending
	async function submit(
		run: () => Promise<unknown>,
		message: string,
		onSuccess?: () => void,
	) {
		const isCurrent = capture()
		setNotice(null)
		try {
			await run()
			if (!isCurrent()) return
			onSuccess?.()
			setNotice({ text: message, tone: 'info' })
		} catch (error) {
			if (isCurrent())
				setNotice({
					text:
						error instanceof Error
							? error.message
							: 'Unable to update custom domains.',
					tone: 'error',
				})
		}
	}
	const domains = data.customDomains
	if (!domains) return null
	return (
		<AccountManagementPanel title="Custom domains">
			<p css={accountFieldNoteCss}>
				Add a hostname you own (not under Kody&apos;s own domains), then publish
				the DNS records shown for it at your DNS provider, set to DNS only. Kody
				checks pending domains every few minutes and emails org owners when one
				goes live. Sync checks right away.{' '}
				<a css={primaryLinkCss} href="/docs/package-app-custom-domains">
					Setup guide
				</a>
			</p>
			{domains.hostnames.length ? (
				<ul data-testid="org-custom-hostnames" css={hostnameListCss}>
					{domains.hostnames.map((row) => {
						const active = row.status.state === 'active'
						return (
							<li key={row.id} css={hostnameRowCss}>
								<div css={hostnameMetaCss}>
									<div css={hostnameHeadCss}>
										<strong css={handleValueCss}>{row.hostname}</strong>
										<CustomDomainStatusBadge status={row.status} />
									</div>
									<span css={identityDetailCss}>
										{row.bindingKind === 'app'
											? 'One public app at /'
											: 'Private apps at /packages/…'}
									</span>
									{row.status.reason ? (
										<span css={identityDetailCss}>{row.status.reason}</span>
									) : null}
									{active ? null : (
										<div
											data-testid={`org-custom-hostname-verification-${row.id}`}
										>
											<CustomDomainRecords records={row.setupRecords} />
										</div>
									)}
								</div>
								{data.canManageDomains ? (
									<div css={hostnameActionsCss}>
										<button
											type="button"
											css={getGhostButtonCss({ size: 'sm' })}
											disabled={isPending}
											onClick={() =>
												void submit(
													() =>
														sync.mutateAsync({
															orgSlug: data.org.slug,
															id: row.id,
														}),
													'Custom domain status refreshed from Cloudflare.',
												)
											}
										>
											{sync.isPending && sync.variables.id === row.id
												? 'Syncing…'
												: 'Sync'}
										</button>
										<button
											type="button"
											css={getGhostButtonCss({ size: 'sm' })}
											disabled={isPending}
											onClick={() =>
												void submit(
													() =>
														remove.mutateAsync({
															orgSlug: data.org.slug,
															id: row.id,
														}),
													'Custom domain removed.',
												)
											}
										>
											{remove.isPending && remove.variables.id === row.id
												? 'Removing…'
												: 'Remove'}
										</button>
									</div>
								) : null}
							</li>
						)
					})}
				</ul>
			) : (
				<p css={mutedCopyCss}>No custom domains yet.</p>
			)}
			{data.canManageDomains && !domains.canAdd ? (
				<p data-testid="org-custom-domains-paid-only" css={accountFieldNoteCss}>
					Custom domains need a paid plan.{' '}
					<a css={primaryLinkCss} href={orgBillingPath(data.org.slug)}>
						See plans
					</a>
				</p>
			) : null}
			{data.canManageDomains && domains.canAdd ? (
				<form
					css={formCss}
					onSubmit={(event) => {
						event.preventDefault()
						if (isPending) return
						void submit(
							() =>
								add.mutateAsync({
									orgSlug: data.org.slug,
									hostname,
									bindingKind,
									packageId: bindingKind === 'app' ? packageId : undefined,
									sslMethod,
								}),
							'Custom domain added. Publish the DNS records shown for it (DNS only). Kody checks automatically and emails org owners when it goes live.',
							() => {
								setHostname('')
								setPackageId('')
							},
						)
					}}
				>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Hostname</span>
						<input
							data-field-ring
							css={accountInputCss}
							required
							value={hostname}
							placeholder="apps.example.com"
							onChange={(event) => setHostname(event.currentTarget.value)}
						/>
					</label>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Binding</span>
						<select
							css={accountInputCss}
							value={bindingKind}
							onChange={(event) =>
								setBindingKind(
									event.currentTarget.value === 'app' ? 'app' : 'org',
								)
							}
						>
							<option value="org">Org (private apps at /packages/…)</option>
							<option value="app">
								App (one public internet-visible app at /)
							</option>
						</select>
					</label>
					{bindingKind === 'app' ? (
						<label css={accountFieldCss}>
							<span css={accountFieldLabelCss}>Package id</span>
							<input
								data-field-ring
								css={accountInputCss}
								required
								value={packageId}
								onChange={(event) => setPackageId(event.currentTarget.value)}
							/>
						</label>
					) : null}
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>SSL method</span>
						<select
							css={accountInputCss}
							value={sslMethod}
							onChange={(event) =>
								setSslMethod(
									event.currentTarget.value === 'http' ? 'http' : 'txt',
								)
							}
						>
							<option value="txt">TXT (pre-validate)</option>
							<option value="http">HTTP</option>
						</select>
					</label>
					<div css={accountActionsCss}>
						<button
							type="submit"
							css={getPillButtonCss({ size: 'sm' })}
							disabled={isPending}
						>
							{add.isPending ? 'Adding…' : 'Add domain'}
						</button>
					</div>
				</form>
			) : null}
			{notice ? (
				<div ref={noticeRef}>
					<AccountManagementMessage tone={notice.tone}>
						{notice.text}
					</AccountManagementMessage>
				</div>
			) : null}
		</AccountManagementPanel>
	)
}

const mutedCopyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
}

const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
	marginTop: spacing.md,
}

const handleValueCss: CSSObject = {
	margin: 0,
	fontFamily: typography.fontFamilyMono,
	color: colors.text,
}

const identityDetailCss: CSSObject = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const hostnameListCss: CSSObject = {
	listStyle: 'none',
	margin: `${spacing.md} 0 0`,
	padding: 0,
	display: 'grid',
	gap: spacing.md,
}

const hostnameRowCss: CSSObject = {
	display: 'grid',
	gap: spacing.sm,
	paddingBottom: spacing.md,
	borderBottom: `1px solid ${colors.border}`,
	'&:last-child': {
		borderBottom: 'none',
		paddingBottom: 0,
	},
}

const hostnameMetaCss: CSSObject = {
	display: 'grid',
	gap: '0.2rem',
	minWidth: 0,
}

const hostnameActionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}

const hostnameHeadCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
}
