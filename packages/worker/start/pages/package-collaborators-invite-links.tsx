/** @jsxImportSource @emotion/react */
import { useState, type FormEvent } from 'react'
import { useInviteHandoff } from '../use-invite-handoff.ts'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
	loadPackageInviteLinks,
	createPackageInviteLink,
	revokePackageInviteLink,
} from '#start/server/invite-links'
import { useSubmitterScope } from '../use-submitter-scope.ts'

import { formatTimestampDate } from '../components/local-timestamp.tsx'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'
import { renderIcon } from '../components/icon.tsx'
import { type ScopedInviteLinkView } from '#universal/loader-data.ts'
import {
	type PackageCollaboratorPreset,
	packageCollaboratorPresetDescription,
} from '#universal/package-collaborators.ts'

import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	formCss,
	iconWellCss,
	listCss,
	mutedCopyCss,
	readPreset,
	renderPresetOptions,
	rowActionsCss,
	rowCss,
	rowDetailCss,
	rowNameCss,
	rowTextCss,
	selectCss,
} from './package-collaborators-parts.tsx'

type CreatedLink = { id: string; url: string }

function creatorLabel(link: ScopedInviteLinkView) {
	if (link.createdByDisplayName?.trim()) return link.createdByDisplayName.trim()
	if (link.createdByUsername) return `@${link.createdByUsername}`
	return 'Someone'
}

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		return false
	}
}

/**
 * Create, list, and revoke links that give one package's access to whoever
 * accepts. Works for personal and team orgs alike; the recipient becomes an
 * outside collaborator unless they already belong to the org.
 */
export function PackageInviteLinksPanel(props: {
	username: string
	kodyId: string
	orgSlug: string
	personal: boolean
	actorKey: string | null
}) {
	return (
		<PackageInviteLinksContent
			key={JSON.stringify([props.actorKey, props.username, props.kodyId])}
			{...props}
		/>
	)
}
function PackageInviteLinksContent({
	username,
	kodyId,
	orgSlug,
	personal,
	actorKey,
}: {
	username: string
	kodyId: string
	orgSlug: string
	personal: boolean
	actorKey: string | null
}) {
	const client = useQueryClient()
	const capture = useSubmitterScope()
	const page = { username, kodyId }
	const queryKey = ['packageInviteLinks', actorKey, page] as const
	const query = useQuery({
		queryKey,
		meta: { actorKey },
		queryFn: async ({ signal }) => {
			const result = await loadPackageInviteLinks({ data: page, signal })
			return result.links
		},
		staleTime: 0,
		retry: false,
	})
	const links = query.data ?? []
	const loadError = query.error?.message
	const [preset, setPreset] = useState<PackageCollaboratorPreset>('use')
	const [maxUses, setMaxUses] = useState('1')
	const [expiresInDays, setExpiresInDays] = useState('7')
	const [created, setCreated] = useInviteHandoff<CreatedLink>(query.data)
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	const createdUrl = created?.url
	const lifecycle = {
		retry: false,
		gcTime: 0,
		onMutate: async () => {
			await client.cancelQueries({ queryKey })
			return { queryKey }
		},
		onSettled: async (
			_result: unknown,
			_error: unknown,
			_input: unknown,
			context: { queryKey: typeof queryKey } | undefined,
		) => {
			if (!context) return
			await client.cancelQueries({
				queryKey: context.queryKey,
				exact: true,
				predicate: (query) => query.state.data !== undefined,
			})
			await client.invalidateQueries({
				queryKey: context.queryKey,
				exact: true,
			})
		},
	}
	const createMutation = useMutation({
		...lifecycle,
		mutationFn: (input: {
			preset: PackageCollaboratorPreset
			maxUses: string | null
			expiresInDays: string
		}) => createPackageInviteLink({ data: { ...page, ...input } }),
	})
	const revokeMutation = useMutation({
		...lifecycle,
		mutationFn: (linkId: string) =>
			revokePackageInviteLink({ data: { ...page, linkId } }),
	})
	const busy = createMutation.isPending
		? 'create'
		: revokeMutation.isPending
			? `revoke:${revokeMutation.variables}`
			: null
	async function create(event: FormEvent) {
		event.preventDefault()
		if (busy) return
		const active = capture()
		setMessage(null)
		try {
			const result = await createMutation.mutateAsync({
				preset,
				maxUses: maxUses.trim() || null,
				expiresInDays: expiresInDays.trim() || '7',
			})
			createMutation.reset()
			if (!active()) return
			const link = result.inviteLink
			setCreated(link)
			const copied = await copyText(link.url)
			if (!active()) return
			setMessage(
				copied
					? 'Invite link copied to clipboard.'
					: 'Invite link created. Copy it below; it is shown only once.',
			)
			setMessageTone('info')
		} catch (error) {
			if (active()) {
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to create invite link.',
				)
				setMessageTone('error')
			}
		}
	}
	async function revoke(linkId: string) {
		if (busy) return
		const active = capture()
		setMessage(null)
		try {
			await revokeMutation.mutateAsync(linkId)
			if (!active()) return
			if (created?.id === linkId) setCreated(null)
			setMessage('Invite link revoked.')
			setMessageTone('info')
		} catch (error) {
			if (active()) {
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to revoke invite link.',
				)
				setMessageTone('error')
			}
		}
	}
	async function copyAgain() {
		if (!createdUrl) return
		const active = capture()
		const copied = await copyText(createdUrl)
		if (active()) {
			setMessage(
				copied
					? 'Invite link copied to clipboard.'
					: 'Could not copy the link. Select it manually.',
			)
			setMessageTone(copied ? 'info' : 'error')
		}
	}

	function renderLink(link: ScopedInviteLinkView) {
		return (
			<li key={link.id} css={rowCss} data-testid="package-invite-link">
				<span aria-hidden="true" css={iconWellCss}>
					{renderIcon('link', { size: '1.25rem' })}
				</span>
				<span css={rowTextCss}>
					<span css={rowNameCss}>{link.label} link</span>
					<span css={rowDetailCss}>
						{[
							`${link.useCount}${link.maxUses != null ? ` / ${link.maxUses}` : ''} uses`,
							`Expires ${formatTimestampDate(link.expiresAt)}`,
							`Created by ${creatorLabel(link)}`,
						].join(' · ')}
					</span>
				</span>
				<span css={rowActionsCss}>
					<button
						type="button"
						disabled={busy !== null}
						css={getDangerPillCss({ size: 'sm' })}
						onClick={() => revoke(link.id)}
					>
						{busy === `revoke:${link.id}` ? 'Revoking…' : 'Revoke'}
					</button>
				</span>
			</li>
		)
	}

	return (
		<AccountManagementPanel
			title="Share with a link"
			description={
				personal
					? 'Anyone who accepts the link gets this access to the package as an outside collaborator.'
					: `Anyone who accepts the link gets this access to the package. People who are not members of @${orgSlug} become outside collaborators; the link never adds anyone to the organization.`
			}
		>
			<form
				data-testid="package-invite-link-form"
				css={formCss}
				onSubmit={create}
			>
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Access</span>
					<select
						aria-label="Access for the invite link"
						value={preset}
						css={selectCss}
						onChange={(event) => {
							const next = readPreset(event)
							if (next) setPreset(next)
						}}
					>
						{renderPresetOptions(preset)}
					</select>
					<p css={accountFieldNoteCss}>
						{packageCollaboratorPresetDescription(preset)}.
					</p>
				</label>
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Max uses</span>
					<input
						value={maxUses}
						data-field-ring
						inputMode="numeric"
						autoComplete="off"
						placeholder="Unlimited"
						aria-label="Max uses"
						css={accountInputCss}
						onChange={(event) => setMaxUses(event.currentTarget.value)}
					/>
					<p css={accountFieldNoteCss}>
						One person per use. Leave blank to let anyone with the link accept.
					</p>
				</label>
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Expires in days</span>
					<input
						value={expiresInDays}
						data-field-ring
						inputMode="numeric"
						autoComplete="off"
						aria-label="Expires in days"
						css={accountInputCss}
						onChange={(event) => setExpiresInDays(event.currentTarget.value)}
					/>
				</label>
				<div css={accountActionsCss}>
					<button
						type="submit"
						disabled={busy !== null}
						data-testid="package-invite-link-create"
						css={getPillButtonCss({ size: 'sm' })}
					>
						{renderIcon('link', { size: '1.05rem' })}
						{busy === 'create' ? 'Creating…' : 'Create invite link'}
					</button>
				</div>
			</form>
			{message ? (
				<p
					role={messageTone === 'error' ? 'alert' : 'status'}
					css={messageTone === 'error' ? errorCss : statusCss}
				>
					{message}
				</p>
			) : null}
			{createdUrl ? (
				<div css={createdCss} data-testid="package-invite-link-url">
					<code css={createdCodeCss}>{createdUrl}</code>
					<button
						type="button"
						css={getPillButtonCss({ size: 'sm' })}
						onClick={() => void copyAgain()}
					>
						{renderIcon('copy', { size: '1.05rem' })}
						Copy again
					</button>
				</div>
			) : null}
			{loadError ? (
				<p role="alert" css={errorCss}>
					{loadError}
				</p>
			) : query.isPending ? (
				<p role="status" css={linksEmptyCss}>
					Loading invite links…
				</p>
			) : links.length > 0 ? (
				<ul css={linksListCss} data-testid="package-invite-links">
					{links.map(renderLink)}
				</ul>
			) : (
				<p css={linksEmptyCss}>No active invite links.</p>
			)}
		</AccountManagementPanel>
	)
}

const statusCss = {
	margin: `${spacing.md} 0 0`,
	color: colors.text,
}

const errorCss = {
	margin: `${spacing.md} 0 0`,
	color: colors.danger,
}

const createdCss = {
	display: 'grid',
	gap: spacing.sm,
	marginTop: spacing.lg,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const createdCodeCss = {
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
	color: colors.text,
}

const linksListCss = {
	...listCss,
	marginTop: spacing.lg,
}

const linksEmptyCss = {
	...mutedCopyCss,
	marginTop: spacing.lg,
}
