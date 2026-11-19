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

const app = {
	name: 'Release Notes',
	publisher: 'Globex',
	publisherUsername: 'globex',
	viewer: 'Jane Doe',
}

/** Mockup only: the "run as me" confirmation before an app first runs on the visitor's account. */
export function RunAsMeMockPage({ declined }: { declined: boolean }) {
	return (
		<AccountManagementShell layout="form" maxWidth="40rem">
			<AccountManagementHeader
				title={declined ? `${app.name} did not run` : `Run ${app.name} as you?`}
				description={
					declined
						? `Nothing ran on your account. You can run ${app.name} as you whenever you like.`
						: `${app.name} is shared with you by ${app.publisher}. It runs on your Kody account, so say yes once and you are in.`
				}
			/>
			<section
				data-testid="run-as-me"
				css={{ display: 'grid', gap: spacing.lg }}
			>
				<div css={identityRowCss}>
					<span aria-hidden="true" css={iconFallbackCss}>
						{app.name.slice(0, 1)}
					</span>
					<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
						<strong css={nameCss}>{app.name}</strong>
						<p css={mutedCss}>
							Shared by {app.publisher} (@{app.publisherUsername})
						</p>
						<p css={mutedCss}>Signed in as {app.viewer}</p>
					</div>
				</div>
				{declined ? null : (
					<p css={mutedCss}>
						We will remember this for {app.name}. You can change it anytime in
						Connected apps.
					</p>
				)}
				<div css={accountActionsCss}>
					<Button type="button" data-testid="run-as-me-approve">
						Run as me
					</Button>
					<Button
						type="button"
						variant="secondary"
						data-testid="run-as-me-decline"
					>
						{declined ? 'Back to Kody' : 'Not now'}
					</Button>
				</div>
			</section>
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
