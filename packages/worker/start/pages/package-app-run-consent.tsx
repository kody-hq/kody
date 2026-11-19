/** @jsxImportSource @emotion/react */
import { Button } from '../components/button.tsx'
import {
	AccountManagementHeader,
	AccountManagementShell,
	accountActionsCss,
} from './account-management-components.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export function PackageAppRunConsentPage({
	appName,
	publisherName,
	publisherUsername,
	viewerName,
	declined,
	packageId,
	publisherId,
	personId,
	formAction,
}: {
	appName: string
	publisherName: string
	publisherUsername: string
	viewerName: string
	declined: boolean
	packageId: string
	publisherId: string
	personId: string
	formAction: string
}) {
	return (
		<AccountManagementShell layout="form" maxWidth="40rem">
			<AccountManagementHeader
				title={declined ? `${appName} did not run` : `Run ${appName} as you?`}
				description={
					declined
						? `Nothing ran on your account. You can run ${appName} as you whenever you like.`
						: `${appName} is shared with you by ${publisherName}. It runs on your Kody account, so say yes once and you are in.`
				}
			/>
			<form
				action={formAction}
				method="post"
				data-testid="run-as-me"
				css={{ display: 'grid', gap: spacing.lg }}
			>
				<input type="hidden" name="packageId" value={packageId} />
				<input type="hidden" name="publisherId" value={publisherId} />
				<input type="hidden" name="personId" value={personId} />
				<div css={identityRowCss}>
					<span aria-hidden="true" css={iconFallbackCss}>
						{appName.slice(0, 1)}
					</span>
					<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
						<strong css={nameCss}>{appName}</strong>
						<p css={mutedCss}>
							Shared by {publisherName} (@{publisherUsername})
						</p>
						<p css={mutedCss}>Signed in as {viewerName}</p>
					</div>
				</div>
				{declined ? null : (
					<p css={mutedCss}>
						We will remember this for {appName}. You can change it anytime in
						Connected apps.
					</p>
				)}
				<div css={accountActionsCss}>
					<Button
						type="submit"
						name="decision"
						value="approve"
						data-testid="run-as-me-approve"
					>
						Run as me
					</Button>
					{declined ? (
						<Button
							href="/account"
							reloadDocument
							variant="secondary"
							data-testid="run-as-me-decline"
						>
							Back to Kody
						</Button>
					) : (
						<Button
							type="submit"
							name="decision"
							value="decline"
							variant="secondary"
							data-testid="run-as-me-decline"
						>
							Not now
						</Button>
					)}
				</div>
			</form>
		</AccountManagementShell>
	)
}

const identityRowCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	minWidth: 0,
}

const iconFallbackCss = {
	width: '3rem',
	height: '3rem',
	borderRadius: radius.md,
	flexShrink: 0,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

const nameCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
}

const mutedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
