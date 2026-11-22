/** @jsxImportSource @emotion/react */
import { Field } from '../components/field.tsx'
import { Button } from '../components/button.tsx'
import {
	bindSecretProvider,
	unbindSecretProvider,
	grantSecretProvider,
	revokeSecretProvider,
	saveVaultItemCredential,
} from '#start/server/account-mutations'
import type { AccountSecretProvidersLoaderData } from '#universal/loader-data.ts'
import { relocateAccountHref } from '#universal/org-pages.ts'
import {
	getAccentCalloutCss,
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
} from './account-management-components.tsx'
import { Input, Select } from '../components/input.tsx'

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
	const saveVaultItem = useMutation(
		secretMutationOptions(
			queryClient,
			actorKey,
			orgSlug,
			mutationResources,
			saveVaultItemCredential,
		),
	)
	const status =
		bind.isPending ||
		unbind.isPending ||
		grant.isPending ||
		revoke.isPending ||
		saveVaultItem.isPending
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
			layout="detail"
			currentHref={currentHref}
			busy={status === 'saving'}
		>
			<AccountPageHeader
				entity="secret-providers"
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
						<Button
							type="button"
							disabled={disabled}
							variant="danger"
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
						</Button>
					) : (
						<Button
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
							variant="primary"
							size="md"
						>
							Allow
						</Button>
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
								<Button
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
									variant="secondary"
									size="md"
								>
									Unbind
								</Button>
							</li>
						))}
					</ul>
				)}
			</AccountManagementPanel>
			{payload.bindings.length ? (
				<AccountManagementPanel title="Create a vault-backed Key">
					<p css={pageDescriptionCss}>
						Choose a binding and enter the vault item ID and field. The saved
						Key can be mapped by ID; each package also needs a grant for the
						item field.
					</p>
					<form
						css={{ display: 'grid', gap: spacing.md }}
						onSubmit={(event) => {
							event.preventDefault()
							const form = event.currentTarget
							const data = new FormData(form)
							const get = (name: string) => String(data.get(name) ?? '').trim()
							void submit(
								async () => {
									await saveVaultItem.mutateAsync({
										orgSlug: orgSlug ?? undefined,
										bindingId: get('binding'),
										itemId: get('item'),
										field: get('field'),
										name: get('keyName'),
										hosts: get('hosts')
											.split(',')
											.map((host) => host.trim())
											.filter(Boolean),
										provider: get('provider') || undefined,
									})
									form.reset()
								},
								relocateAccountHref('/account/credentials', currentHref),
							)
						}}
					>
						<Field label="Provider binding">
							<Select name="binding" required>
								{payload.bindings.map((binding) => (
									<option key={binding.id} value={binding.id}>
										{binding.provider}
									</option>
								))}
							</Select>
						</Field>
						<Field label="Vault item ID">
							<Input name="item" required />
						</Field>
						<Field label="Item field">
							<Input name="field" required />
						</Field>
						<Field label="Key label">
							<Input name="keyName" required />
						</Field>
						<Field label="Approved hosts (comma-separated)">
							<Input name="hosts" required />
						</Field>
						<Field label="API provider slug (optional)">
							<Input name="provider" />
						</Field>
						<Button type="submit" disabled={disabled}>
							Create Key
						</Button>
					</form>
				</AccountManagementPanel>
			) : null}
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
								<Button
									type="button"
									disabled={disabled}
									variant="danger"
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
								</Button>
							</li>
						))}
					</ul>
				)}
			</AccountManagementPanel>
			<AccountManagementPanel title="Bind a provider">
				<Field label="Provider id">
					<Input
						onInput={(event) => {
							setBindProvider(event.currentTarget.value)
						}}
						value={bindProvider}
						disabled={disabled}
					/>
				</Field>
				<Field label="Package">
					<Select
						onChange={(event) => {
							setBindPackageId(event.currentTarget.value)
						}}
						value={bindPackageId}
						disabled={disabled}
					>
						<option value="">Select a package</option>
						{payload.packages.map((savedPackage) => (
							<option key={savedPackage.id} value={savedPackage.id}>
								{savedPackage.kodyId}
							</option>
						))}
					</Select>
				</Field>
				<Field label="Door-key secret">
					<Select
						onChange={(event) => {
							setBindDoorSecret(event.currentTarget.value)
						}}
						value={bindDoorSecret}
						disabled={disabled}
					>
						<option value="">Select a user secret</option>
						{payload.doorSecrets.map(({ id, name }) => (
							<option key={id} value={id}>
								{name}
							</option>
						))}
					</Select>
				</Field>
				<Field label="Optional config JSON (non-secret, for example a Connect base URL)">
					<Input
						onInput={(event) => {
							setBindConfig(event.currentTarget.value)
						}}
						value={bindConfig}
						disabled={disabled}
					/>
				</Field>
				<Button
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
									doorCredentialId: bindDoorSecret,
									config,
								}),
							relocateAccountHref('/account/secret-providers', currentHref),
						)
					}}
					variant="primary"
					size="md"
					mobileFullWidth
					css={{ justifySelf: 'start' }}
				>
					Bind provider
				</Button>
			</AccountManagementPanel>
		</AccountManagementShell>
	)
}

const mutationResources = [
	'loadSecretProvidersPage',
	'loadSecretsPage',
] as const
