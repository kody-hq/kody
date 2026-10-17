/** @jsxImportSource @emotion/react */
import {
	addAdminReservedUsernames,
	removeAdminReservedUsernames,
} from '#start/server/admin-mutations'
import { type AdminReservedUsernamesLoaderData } from '#universal/loader-data.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	IdValue,
	accountInputCss,
	accountTextareaCss,
} from './account-management-components.tsx'
type ActionState = 'idle' | 'adding' | 'removing'
export function AdminReservedUsernamesPage(props: {
	payload: AdminReservedUsernamesLoaderData
	currentHref: string
}) {
	const { builtIn, added, removed, conflicts } = props.payload
	const captureSubmitter = useSubmitterScope()
	const invalidate = usePageInvalidation(['loadAdminReservedUsernames'])
	const addMutation = useMutation({
		gcTime: 0,
		mutationFn: addAdminReservedUsernames,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const removeMutation = useMutation({
		gcTime: 0,
		mutationFn: removeAdminReservedUsernames,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const [builtInQuery, setBuiltInQuery] = useState('')
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	const actionState: ActionState = addMutation.isPending
		? 'adding'
		: removeMutation.isPending
			? 'removing'
			: 'idle'

	async function submitAdminAction(
		submit: () => Promise<unknown>,
		nextState: 'adding' | 'removing',
	) {
		if (actionState !== 'idle') return false
		const isCurrent = captureSubmitter()
		setMessage(null)
		setMessageTone('info')
		try {
			await submit()
			if (!isCurrent()) return false
			setMessage(
				nextState === 'adding'
					? 'Reserved usernames updated.'
					: 'Reserved username removed.',
			)
			setMessageTone('info')
			return true
		} catch (error) {
			if (!isCurrent()) return false
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to update reserved usernames.',
			)
			setMessageTone('error')
			return false
		}
	}
	async function handleAddSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget
		const formData = new FormData(form)
		const saved = await submitAdminAction(
			() =>
				addMutation.mutateAsync({
					data: {
						usernames: [String(formData.get('usernames') ?? '')],
					},
				}),
			'adding',
		)
		if (saved) form.reset()
	}
	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const currentHref = props.currentHref
	const pending = false
	const status: string = 'ready'
	const isMutating = actionState !== 'idle'
	const normalizedQuery = builtInQuery.trim().toLowerCase()
	const visibleBuiltIn = normalizedQuery
		? builtIn.filter((name) => name.includes(normalizedQuery))
		: builtIn
	return (
		<AccountManagementShell currentHref={currentHref} busy={pending}>
			<AdminPageHeader
				title="Reserved usernames"
				description="Usernames become {username}.kody.run subdomains and {username}@ mail locals. Built-in names stay locked unless explicitly unreserved; system-email locals and kody-prefixed names cannot be unreserved."
				currentHref={currentHref}
			/>
			{status === 'loading' ? (
				<p css={{ color: colors.textMuted, margin: 0 }}>
					Loading reserved usernames…
				</p>
			) : null}
			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}
			<AccountManagementPanel
				title="Add reserved names"
				description="Enter one or more DNS-safe labels, separated by commas or new lines."
				asForm
				onSubmit={handleAddSubmit}
			>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Usernames</span>
					<textarea
						data-field-ring
						name="usernames"
						rows={4}
						placeholder="autodiscover, mta-sts"
						disabled={isMutating}
						css={accountTextareaCss}
					/>
				</label>
				<button type="submit" disabled={isMutating} css={primaryButtonCss}>
					{actionState === 'adding' ? 'Adding…' : 'Add'}
				</button>
			</AccountManagementPanel>
			<section css={cardCss}>
				<h2
					css={{
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						margin: 0,
					}}
				>
					Conflicts
				</h2>
				<p css={descriptionCss}>
					Registered accounts whose username is in the effective reserved set.
					Resolve these in production before expanding the built-in list.
				</p>
				{status === 'ready' && conflicts.length === 0 ? (
					<p css={{ color: colors.textMuted, margin: 0 }}>
						No registered usernames collide with the effective reserved set.
					</p>
				) : null}
				<div css={{ display: 'grid', gap: spacing.sm }}>
					{conflicts.map((conflict) => (
						<div
							key={conflict.stableUserId}
							css={{
								display: 'flex',
								justifyContent: 'space-between',
								gap: spacing.md,
								flexWrap: 'wrap',
							}}
						>
							<strong>{conflict.username}</strong>
							<IdValue value={conflict.stableUserId} label="stable user id" />
						</div>
					))}
				</div>
			</section>
			<section css={cardCss}>
				<h2
					css={{
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						margin: 0,
					}}
				>
					Custom additions
				</h2>
				<p css={descriptionCss}>
					Runtime names stored in platform KV. Removing one makes it available
					again.
				</p>
				{status === 'ready' && added.length === 0 ? (
					<p css={{ color: colors.textMuted, margin: 0 }}>
						No custom reserved usernames.
					</p>
				) : null}
				<div css={{ display: 'grid', gap: spacing.sm }}>
					{added.map((username) => (
						<div
							key={username}
							css={{
								display: 'flex',
								justifyContent: 'space-between',
								alignItems: 'center',
								gap: spacing.md,
							}}
						>
							<code>{username}</code>
							<button
								type="button"
								disabled={isMutating}
								onClick={() =>
									void submitAdminAction(
										() =>
											removeMutation.mutateAsync({
												data: {
													usernames: [username],
												},
											}),
										'removing',
									)
								}
								css={secondaryButtonCss}
							>
								{actionState === 'removing' ? 'Removing…' : 'Remove'}
							</button>
						</div>
					))}
				</div>
			</section>
			<section css={cardCss}>
				<h2
					css={{
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						margin: 0,
					}}
				>
					Unreserved built-ins
				</h2>
				<p css={descriptionCss}>
					Built-in names that operators have explicitly made available. Restore
					puts them back on the reserved list.
				</p>
				{status === 'ready' && removed.length === 0 ? (
					<p css={{ color: colors.textMuted, margin: 0 }}>
						No built-in names are currently unreserved.
					</p>
				) : null}
				<div css={{ display: 'grid', gap: spacing.sm }}>
					{removed.map((username) => (
						<div
							key={username}
							css={{
								display: 'flex',
								justifyContent: 'space-between',
								alignItems: 'center',
								gap: spacing.md,
							}}
						>
							<code>{username}</code>
							<button
								type="button"
								disabled={isMutating}
								onClick={() =>
									void submitAdminAction(
										() =>
											addMutation.mutateAsync({
												data: {
													usernames: [username],
												},
											}),
										'adding',
									)
								}
								css={primaryButtonCss}
							>
								Restore
							</button>
						</div>
					))}
				</div>
			</section>
			<section css={cardCss}>
				<h2
					css={{
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						margin: 0,
					}}
				>
					Built-in names
				</h2>
				<p css={descriptionCss}>
					Code-defined denylist. Search to filter. These stay reserved unless
					moved to Unreserved built-ins.
				</p>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Search</span>
					<input
						data-field-ring
						type="text"
						role="searchbox"
						inputMode="search"
						autoComplete="off"
						placeholder="autodiscover"
						onInput={(event) => {
							if (!(event.currentTarget instanceof HTMLInputElement)) return
							setBuiltInQuery(event.currentTarget.value)
						}}
						css={accountInputCss}
					/>
				</label>
				<p css={{ color: colors.textMuted, margin: 0 }}>
					{visibleBuiltIn.length} of {builtIn.length} names
				</p>
				<ul
					css={{
						display: 'grid',
						gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
						gap: spacing.sm,
						listStyle: 'none',
						margin: 0,
						padding: 0,
						[mq.tablet]: {
							gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
						},
						[mq.mobile]: {
							gridTemplateColumns: 'minmax(0, 1fr)',
						},
					}}
				>
					{visibleBuiltIn.map((username) => (
						<li key={username}>
							<code>{username}</code>
						</li>
					))}
				</ul>
			</section>
		</AccountManagementShell>
	)
}
