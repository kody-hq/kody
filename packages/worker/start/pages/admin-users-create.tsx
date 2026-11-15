/** @jsxImportSource @emotion/react */
import { Button } from '../components/button.tsx'
import { SiteLink } from '../components/site-link.tsx'
import type { FormEvent } from 'react'
import { formatNullableTimestamp } from '../components/local-timestamp.tsx'
import { colors, mq, spacing } from '#universal/styles/tokens.ts'
import { fieldCss, fieldLabelCss } from '#universal/styles/style-primitives.ts'
import type { AdminCreatedUserSetup } from '#universal/loader-data.ts'
import {
	AccountManagementPanel,
	noticeCardCss,
} from './account-management-components.tsx'
import type { AdminUsersActionState } from './admin-users-detail.tsx'
import { Input } from '../components/input.tsx'
export function AdminCreateUserPanel(input: {
	actionState: AdminUsersActionState
	createdUser: AdminCreatedUserSetup | null
	isMutating: boolean
	onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
	return (
		<AccountManagementPanel
			title="Create user"
			description="Create a verified account with no usable password, then copy the setup link into a manual email."
			asForm
			onSubmit={input.onSubmit}
		>
			<div
				css={{
					display: 'grid',
					gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
					gap: spacing.md,
					alignItems: 'end',
					[mq.mobile]: {
						gridTemplateColumns: 'minmax(0, 1fr)',
						alignItems: 'stretch',
					},
				}}
			>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>User email</span>
					<Input
						name="email"
						type="email"
						required
						placeholder="person@example.com"
						disabled={input.isMutating}
					/>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Username (optional)</span>
					<Input
						name="username"
						type="text"
						placeholder="Auto-generated from email"
						disabled={input.isMutating}
					/>
				</label>
				<Button type="submit" disabled={input.isMutating} variant="primary">
					{input.actionState === 'creatingUser' ? 'Creating…' : 'Create user'}
				</Button>
			</div>
			{input.createdUser ? (
				<div css={noticeCardCss}>
					<p css={{ margin: 0 }}>
						Setup link for <strong>{input.createdUser.email}</strong>:
					</p>
					<Input
						readOnly
						aria-label="Password setup link"
						value={input.createdUser.setupLink}
					/>
					<SiteLink
						href={input.createdUser.setupLink}
						css={{ color: colors.primary }}
					>
						Open setup link
					</SiteLink>
					<p css={{ margin: 0, color: colors.textMuted }}>
						Expires{' '}
						{formatNullableTimestamp(
							new Date(input.createdUser.setupTokenExpiresAt).toISOString(),
						)}
						.
					</p>
				</div>
			) : null}
		</AccountManagementPanel>
	)
}
