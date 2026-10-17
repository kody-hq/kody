/** @jsxImportSource @emotion/react */
import {
	addOrganizationDomain,
	syncOrganizationDomain,
	deleteOrganizationDomain,
} from '#start/server/org-settings-mutations'
import { type CSSObject } from '@emotion/react'
import { useState } from 'react'
import { orgDomainMutationOptions } from './org-domain-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { type OrgSettingsLoaderData } from '#universal/loader-data.ts'
import {
	AccountManagementPanel,
	accountFieldCss,
	accountActionsCss,
	accountFieldNoteCss,
	accountFieldLabelCss,
	accountInputCss,
} from './account-management-components.tsx'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

/** The organization settings query owns domain state and refreshes after writes. */
export function OrgSettingsCustomDomains({
	data,
	queryKey,
	onMessage,
}: {
	data: OrgSettingsLoaderData
	queryKey: QueryKey
	onMessage: (message: string, tone: 'info' | 'error') => void
}) {
	const client = useQueryClient()
	const capture = useSubmitterScope()
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
		try {
			await run()
			if (!isCurrent()) return
			onSuccess?.()
			onMessage(message, 'info')
		} catch (error) {
			if (isCurrent())
				onMessage(
					error instanceof Error
						? error.message
						: 'Unable to update custom domains.',
					'error',
				)
		}
	}
	const domains = data.customDomains
	if (!domains) return null
	return (
		<AccountManagementPanel title="Custom domains">
			<p css={accountFieldNoteCss}>
				Point a CNAME at{' '}
				<code css={handleValueCss}>
					{domains.dnsTarget ?? 'domains.<package-app host>'}
				</code>
				, publish any ownership and SSL validation records shown per domain,
				then sync until hostname and certificate are both active. Prefer TXT SSL
				validation so the cert can issue before traffic switches (ADR 0071).
			</p>
			{domains.hostnames.length ? (
				<ul data-testid="org-custom-hostnames" css={hostnameListCss}>
					{domains.hostnames.map((row) => {
						const verified =
							row.hostnameStatus === 'active' && row.sslStatus === 'active'
						const records = [
							...(row.ownershipVerification ? [row.ownershipVerification] : []),
							...row.sslValidationRecords,
						]
						return (
							<li key={row.id} css={hostnameRowCss}>
								<div css={hostnameMetaCss}>
									<strong css={handleValueCss}>{row.hostname}</strong>
									<span css={identityDetailCss}>
										{row.bindingKind === 'app' ? 'App' : 'Org'} · host{' '}
										{row.hostnameStatus} · ssl {row.sslStatus}
										{verified ? ' · verified' : ''}
									</span>
									{!verified && records.length ? (
										<ul
											css={verificationListCss}
											data-testid={`org-custom-hostname-verification-${row.id}`}
										>
											{records.map((record) => (
												<li
													css={verificationRowCss}
													key={`${record.type}:${record.name}:${record.value}`}
												>
													<span css={identityDetailCss}>
														{record.type.toUpperCase()}
													</span>
													<code css={handleValueCss}>{record.name}</code>
													<code css={handleValueCss}>{record.value}</code>
												</li>
											))}
										</ul>
									) : null}
								</div>
								{data.canManage ? (
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
			{data.canManage ? (
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
							'Custom domain registered. Publish the verification records below, then sync.',
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

const verificationListCss: CSSObject = {
	listStyle: 'none',
	margin: `${spacing.sm} 0 0`,
	padding: 0,
	display: 'grid',
	gap: spacing.xs,
}

const verificationRowCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	fontSize: typography.fontSize.sm,
}
