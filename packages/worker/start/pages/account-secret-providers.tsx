/** @jsxImportSource @emotion/react */
import {
	bindSecretProvider,
	unbindSecretProvider,
	grantSecretProvider,
	revokeSecretProvider,
} from '#start/server/account-mutations'
import { type AccountSecretProvidersLoaderData } from '#universal/loader-data.ts'
import { relocateAccountHref } from '#universal/org-pages.ts'
import {
	fieldCss,
	fieldLabelCss,
	getAccentCalloutCss,
	getDangerPillCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	pageDescriptionCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { secretMutationOptions } from '../secret-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountInputCss,
} from './account-management-components.tsx'

export function AccountSecretProvidersPage({
	payload,
	currentHref,
}: {
	payload: AccountSecretProvidersLoaderData
	currentHref: string
}) {
	const queryClient = useQueryClient()
	const { actorKey, orgSlug } = useMatchedPageScope()
	const router = useRouter()
	const [revokeArmed, setRevokeArmed] = useState<string | null>(null)

	const [message, setMessage] = useState<string | null>(null)
	const [bindProvider, setBindProvider] = useState('1password')
	const [bindPackageId, setBindPackageId] = useState('')
	const [bindDoorSecret, setBindDoorSecret] = useState('')
	const [bindConfig, setBindConfig] = useState('')
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	function grantKey(grant: {
		provider: string
		canonicalRef: string
		packageId: string
	}) {
		return `${grant.provider}:${grant.canonicalRef}:${grant.packageId}`
	}

	const capture = useSubmitterScope()
	const bind = useMutation(
		secretMutationOptions(
			queryClient,
			actorKey,
			orgSlug,
			mutationResources,
			bindSecretProvider,
		),
	)
	const unbind = useMutation(
		secretMutationOptions(
			queryClient,
			actorKey,
			orgSlug,
			mutationResources,
			unbindSecretProvider,
		),
	)
	const grant = useMutation(
		secretMutationOptions(
			queryClient,
			actorKey,
			orgSlug,
			mutationResources,
			grantSecretProvider,
		),
	)
	const revoke = useMutation(
		secretMutationOptions(
			queryClient,
			actorKey,
			orgSlug,
			mutationResources,
			revokeSecretProvider,
		),
	)
	const status =
		bind.isPending || unbind.isPending || grant.isPending || revoke.isPending
			? 'saving'
			: 'idle'
	async function submit(run: () => Promise<unknown>, successHref: string) {
		if (status === 'saving') return
		const isCurrent = capture()
		setMessage(null)
		try {
			await run()
			if (!isCurrent()) return
			bind.reset()
			unbind.reset()
			grant.reset()
			revoke.reset()
			setRevokeArmed(null)
			await router.navigate({ to: successHref })
		} catch (error) {
			if (isCurrent())
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to update secret providers.',
				)
		} finally {
			if (isCurrent()) {
				bind.reset()
				unbind.reset()
				grant.reset()
				revoke.reset()
			}
		}
	}

	const disabled = status === 'saving'

	const approval = payload.approval
	return (
		<AccountManagementShell
			currentHref={currentHref}
			busy={status === 'saving'}
		>
			<AccountPageHeader
				title="Secret providers"
				description="Bind a saved package to a provider id such as 1password, and grant other packages use of canonical item refs. Values never appear here."
				currentHref={currentHref}
			/>
			{message ? (
				<AccountManagementMessage tone="error">
					{message}
				</AccountManagementMessage>
			) : null}
			{approval ? (
				<section
					css={{
						...getAccentCalloutCss(),
						display: 'grid',
						gap: spacing.sm,
						padding: spacing.lg,
					}}
				>
					<h2
						css={{
							margin: 0,
							fontSize: typography.fontSize.lg,
							color: colors.text,
						}}
					>
						{approval.alreadyGranted
							? 'Package already granted'
							: 'Allow package access'}
					</h2>
					<p css={pageDescriptionCss}>
						Provider <strong>{approval.provider}</strong>, ref{' '}
						<code>{approval.canonicalRef}</code>, package{' '}
						<strong>{approval.kodyId}</strong>.
					</p>
					{approval.error ? (
						<p css={{ margin: 0, color: colors.error }}>{approval.error}</p>
					) : null}
					{approval.error ? null : approval.alreadyGranted ? (
						<button
							type="button"
							disabled={disabled}
							css={dangerButtonCss}
							onBlur={() => setRevokeArmed(null)}
							onClick={() => {
								if (revokeArmed !== grantKey(approval)) {
									setRevokeArmed(grantKey(approval))
									return
								}
								void submit(
									() =>
										revoke.mutateAsync({
											orgSlug: orgSlug ?? undefined,
											provider: approval.provider,
											ref: approval.canonicalRef,
											packageId: approval.packageId,
										}),
									relocateAccountHref('/account/secret-providers', currentHref),
								)
							}}
						>
							{revokeArmed === grantKey(approval) ? 'Revoke now' : 'Revoke'}
						</button>
					) : (
						<button
							type="button"
							disabled={disabled}
							onClick={() => {
								void submit(
									() =>
										grant.mutateAsync({
											orgSlug: orgSlug ?? undefined,
											provider: approval.provider,
											ref: approval.canonicalRef,
											packageId: approval.packageId,
										}),
									relocateAccountHref('/account/secret-providers', currentHref),
								)
							}}
							css={getPrimaryButtonCss()}
						>
							Allow
						</button>
					)}
				</section>
			) : null}
			<AccountManagementPanel title="Bindings">
				{payload.bindings.length === 0 ? (
					<p css={pageDescriptionCss}>No providers are bound yet.</p>
				) : (
					<ul
						css={{
							listStyle: 'none',
							margin: 0,
							padding: 0,
							display: 'grid',
							gap: spacing.md,
						}}
					>
						{payload.bindings.map((binding) => (
							<li
								key={binding.provider}
								css={{
									display: 'grid',
									gap: spacing.xs,
								}}
							>
								<strong css={{ color: colors.text }}>{binding.provider}</strong>
								<p css={pageDescriptionCss}>
									Package {binding.kodyId}. Door key {binding.doorSecretName}.
								</p>
								<button
									type="button"
									disabled={disabled}
									onClick={() => {
										void submit(
											() =>
												unbind.mutateAsync({
													orgSlug: orgSlug ?? undefined,
													provider: binding.provider,
												}),
											relocateAccountHref(
												'/account/secret-providers',
												currentHref,
											),
										)
									}}
									css={getSecondaryButtonCss()}
								>
									Unbind
								</button>
							</li>
						))}
					</ul>
				)}
			</AccountManagementPanel>
			<AccountManagementPanel title="Package grants">
				{payload.grants.length === 0 ? (
					<p css={pageDescriptionCss}>
						No package grants yet. Allow a package from an approval link.
					</p>
				) : (
					<ul
						css={{
							listStyle: 'none',
							margin: 0,
							padding: 0,
							display: 'grid',
							gap: spacing.md,
						}}
					>
						{payload.grants.map((grant) => (
							<li
								key={grantKey(grant)}
								css={{
									display: 'grid',
									gap: spacing.xs,
								}}
							>
								<strong css={{ color: colors.text }}>{grant.provider}</strong>
								<p css={pageDescriptionCss}>
									<code>{grant.canonicalRef}</code> · package {grant.kodyId}
								</p>
								<button
									type="button"
									disabled={disabled}
									css={dangerButtonCss}
									onBlur={() => setRevokeArmed(null)}
									onClick={() => {
										if (revokeArmed !== grantKey(grant)) {
											setRevokeArmed(grantKey(grant))
											return
										}
										void submit(
											() =>
												revoke.mutateAsync({
													orgSlug: orgSlug ?? undefined,
													provider: grant.provider,
													ref: grant.canonicalRef,
													packageId: grant.packageId,
												}),
											relocateAccountHref(
												'/account/secret-providers',
												currentHref,
											),
										)
									}}
								>
									{revokeArmed === grantKey(grant) ? 'Revoke now' : 'Revoke'}
								</button>
							</li>
						))}
					</ul>
				)}
			</AccountManagementPanel>
			<AccountManagementPanel title="Bind a provider">
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Provider id</span>
					<input
						onInput={(event) => {
							setBindProvider(event.currentTarget.value)
						}}
						css={accountInputCss}
						value={bindProvider}
						disabled={disabled}
					/>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Package</span>
					<select
						onChange={(event) => {
							setBindPackageId(event.currentTarget.value)
						}}
						css={accountInputCss}
						value={bindPackageId}
						disabled={disabled}
					>
						<option value="">Select a package</option>
						{payload.packages.map((savedPackage) => (
							<option key={savedPackage.id} value={savedPackage.id}>
								{savedPackage.kodyId}
							</option>
						))}
					</select>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Door-key secret</span>
					<select
						onChange={(event) => {
							setBindDoorSecret(event.currentTarget.value)
						}}
						css={accountInputCss}
						value={bindDoorSecret}
						disabled={disabled}
					>
						<option value="">Select a user secret</option>
						{payload.doorSecrets.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>
						Optional config JSON (non-secret, for example a Connect base URL)
					</span>
					<input
						onInput={(event) => {
							setBindConfig(event.currentTarget.value)
						}}
						css={accountInputCss}
						value={bindConfig}
						disabled={disabled}
					/>
				</label>
				<button
					type="button"
					disabled={disabled}
					onClick={() => {
						let config: Record<string, string> = {}
						if (bindConfig.trim()) {
							try {
								const parsed: unknown = JSON.parse(bindConfig)
								if (
									!parsed ||
									typeof parsed !== 'object' ||
									Array.isArray(parsed)
								) {
									throw new Error('Config must be a JSON object.')
								}
								for (const [key, value] of Object.entries(parsed)) {
									if (typeof value === 'string') config[key] = value
								}
							} catch (error) {
								setMessage(
									error instanceof Error
										? error.message
										: 'Config must be a JSON object of strings.',
								)
								return
							}
						}
						void submit(
							() =>
								bind.mutateAsync({
									orgSlug: orgSlug ?? undefined,
									provider: bindProvider,
									packageId: bindPackageId,
									doorSecretName: bindDoorSecret,
									config,
								}),
							relocateAccountHref('/account/secret-providers', currentHref),
						)
					}}
					css={getPrimaryButtonCss()}
				>
					Bind provider
				</button>
			</AccountManagementPanel>
		</AccountManagementShell>
	)
}

const mutationResources = [
	'loadSecretProvidersPage',
	'loadSecretsPage',
] as const
