/** @jsxImportSource @emotion/react */
import { mergeCss } from './merge-css.ts'
import { SiteLink } from './site-link.tsx'
import { type CSSObject } from '@emotion/react'
import { type ReactNode } from 'react'
import { CopyTextButton } from './copy-text-button.tsx'
import { routes } from '#universal/routes.ts'

import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getSurfaceCardCss,
	packageDetailPageCss,
	proseCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { type CommunityInstallOutcome } from '../community-types.ts'

export function renderMissingListing(title: string, message: string) {
	return (
		<article css={detailArticleCss}>
			<SiteLink href={routes.community.href()} css={backLinkCss}>
				← Public packages
			</SiteLink>
			<header css={missingHeadCss}>
				<h1>{title}</h1>
				<p>{message}</p>
			</header>
		</article>
	)
}

export type InstallStripProps = {
	installMessage: string | null
	installOutcome: CommunityInstallOutcome | null
}

export function renderInstallStrip(props: InstallStripProps) {
	const installAnnouncement = props.installOutcome
		? props.installOutcome.status === 'installed'
			? `Installed as ${props.installOutcome.targetName}.`
			: `Forked as ${props.installOutcome.targetName}; it needs adaptation before it can run.`
		: ''
	return (
		<div data-testid="community-install" css={installStripCss}>
			<p role="status" css={visuallyHiddenCss}>
				{installAnnouncement}
			</p>
			{props.installOutcome ? (
				<div data-testid="community-install-next-steps" css={nextStepsCardCss}>
					<p css={{ margin: 0 }} aria-hidden="true">
						{installAnnouncement}
					</p>
					{props.installOutcome.status === 'installed' ? (
						<div css={buttonRowCss}>
							<CopyTextButton
								value={props.installOutcome.agentPrompt}
								idleLabel="Use in agent"
								variant="ghost"
								size="sm"
							/>
						</div>
					) : null}
				</div>
			) : null}
			{props.installMessage ? (
				<p css={errorTextCss} role="alert">
					{props.installMessage}
				</p>
			) : null}
		</div>
	)
}

function renderReadmeHeading(agentsDocsHref?: string | null) {
	return (
		<div css={readmeHeadingRowCss}>
			<h2 id="readme-title">README</h2>
			{agentsDocsHref ? (
				<SiteLink
					href={agentsDocsHref}
					data-testid="community-agents-docs-link"
					css={agentsDocsLinkCss}
				>
					Agent docs
				</SiteLink>
			) : null}
		</div>
	)
}

export function renderReadmeSection(
	readme: Array<ReactNode>,
	agentsDocsHref?: string | null,
) {
	return (
		<section aria-labelledby="readme-title" css={readmeSectionCss}>
			{renderReadmeHeading(agentsDocsHref)}
			<div data-testid="community-readme" css={readmeProseCss}>
				{readme}
			</div>
		</section>
	)
}

export function renderEmptyReadme(agentsDocsHref?: string | null) {
	return (
		<section aria-labelledby="readme-title" css={readmeSectionCss}>
			{renderReadmeHeading(agentsDocsHref)}
			<p data-testid="community-readme-empty" css={mutedTextCss}>
				This package has no README yet.
			</p>
		</section>
	)
}

export type AdminFeatureSectionProps = {
	featured: boolean
	featureState: 'idle' | 'submitting' | 'error'
	featureMessage: string | null
	onToggleFeature: () => void
}

export function renderAdminFeatureSection(props: AdminFeatureSectionProps) {
	return (
		<section
			aria-labelledby="admin-feature-title"
			css={detailSectionCss}
			data-testid="community-admin-feature"
		>
			<h2 id="admin-feature-title">Admin: onboarding</h2>
			<p>
				{props.featured
					? 'This listing is featured as an onboarding starter package. Removing it hides it from onboarding immediately.'
					: 'Featuring offers this listing during onboarding. Featured is editorial placement, not a safety review.'}
			</p>
			<div css={sectionActionCss}>
				<button
					disabled={props.featureState === 'submitting'}
					css={smallGhostButtonCss}
					onClick={props.onToggleFeature}
				>
					{props.featureState === 'submitting'
						? 'Saving…'
						: props.featured
							? 'Remove from onboarding'
							: 'Feature in onboarding'}
				</button>
			</div>
			{props.featureMessage ? (
				<p css={errorTextCss} role="alert">
					{props.featureMessage}
				</p>
			) : null}
		</section>
	)
}

export type ReportDisclosureProps = {
	loggedIn: boolean
	reportReason: string
	reportState: 'idle' | 'submitting' | 'success' | 'error'
	reportMessage: string | null
	onReasonInput: (value: string) => void
	onSubmitReport: () => void
}

export function renderReportDisclosure(props: ReportDisclosureProps) {
	return (
		<details id="report" css={reportDisclosureCss}>
			<summary>Report this listing</summary>
			{props.loggedIn ? (
				<div css={reportFormCss}>
					<label css={reportFieldCss}>
						<span>Reason</span>
						<textarea
							value={props.reportReason}
							rows={4}
							maxLength={2000}
							placeholder="Describe why this listing should be reviewed."
							css={reportTextareaCss}
							onChange={(event) =>
								props.onReasonInput(event.currentTarget.value)
							}
						/>
					</label>
					<button
						disabled={
							props.reportState === 'submitting' || !props.reportReason.trim()
						}
						css={smallGhostButtonCss}
						onClick={props.onSubmitReport}
					>
						{props.reportState === 'submitting'
							? 'Submitting…'
							: 'Submit report'}
					</button>
					{props.reportMessage ? (
						<p
							css={props.reportState === 'error' ? errorTextCss : mutedTextCss}
							role={props.reportState === 'error' ? 'alert' : 'status'}
						>
							{props.reportMessage}
						</p>
					) : null}
				</div>
			) : (
				<p css={reportLoginNoteCss}>
					<SiteLink href="/login" css={inlineLinkCss}>
						Log in
					</SiteLink>{' '}
					to report this listing.
				</p>
			)}
		</details>
	)
}

/* 46rem article measure mirroring the blog post; the route owns its gutters
   (the app shell leaves redesigned marketing paths unpadded). The shirt-
   pattern whisper anchors to the article in rem, not to the short icon-row
   head in percentages, so it renders at the same scale and position as the
   blog post head's fabric. */
export const detailArticleCss = packageDetailPageCss

const backLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.4rem',
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
} satisfies CSSObject

const missingHeadCss = {
	marginTop: '1.8rem',
	'& h1': {
		margin: 0,
		fontSize: 'clamp(1.7rem, 4vw, 2.4rem)',
		fontWeight: 760,
		letterSpacing: '-0.024em',
		lineHeight: 1.05,
	},
	'& p': {
		margin: '0.9rem 0 0',
		color: colors.textMuted,
	},
} satisfies CSSObject

/* Quiet sections in the `.pkg-fork` voice: display-face h2, muted lede. */
export const detailSectionCss = {
	marginTop: 'clamp(2.4rem, 5vw, 3.2rem)',
	'& h2': {
		margin: 0,
		fontSize: 'clamp(1.4rem, 2.4vw, 1.65rem)',
		fontWeight: 720,
		letterSpacing: '-0.016em',
	},
	'& > p': {
		margin: '0.6rem 0 0',
		color: colors.textMuted,
		fontSize: '0.98rem',
		maxWidth: '56ch',
		textWrap: 'balance' as const,
	},
	// Error lines must out-rank the muted `& > p` default above.
	'& > p[role="alert"]': {
		color: colors.error,
	},
} satisfies CSSObject

const sectionActionCss = {
	marginTop: '1.1rem',
} satisfies CSSObject

const installStripCss = {
	display: 'grid',
	gap: '0.75rem',
} satisfies CSSObject

/* The prototype's smaller `.account-form .button` sizing. */
const smallGhostButtonCss = mergeCss(getGhostButtonCss(), {
	fontSize: '0.95rem',
	padding: '0.75rem 1.3rem',
})

const nextStepsCardCss = mergeCss(getSurfaceCardCss(), {
	marginTop: '1.2rem',
	padding: '1.1rem 1.3rem',
	display: 'grid',
	gap: '0.9rem',
	'& p': {
		fontSize: '0.95rem',
	},
})

const buttonRowCss = {
	display: 'flex',
	gap: '0.5rem',
	flexWrap: 'wrap' as const,
} satisfies CSSObject

const inlineLinkCss = {
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
} satisfies CSSObject

const errorTextCss = {
	margin: '0.8rem 0 0',
	color: colors.error,
	fontSize: '0.95rem',
} satisfies CSSObject

const mutedTextCss = {
	margin: '0.8rem 0 0',
	color: colors.textMuted,
	fontSize: '0.95rem',
} satisfies CSSObject

/* README as real prose (no scroll box), h3 subheads per DESIGN.md. */
const readmeSectionCss = {
	marginTop: 'clamp(2.4rem, 5vw, 3.2rem)',
} satisfies CSSObject

const readmeHeadingRowCss = {
	display: 'flex',
	alignItems: 'baseline',
	justifyContent: 'space-between',
	gap: '1rem',
	paddingBottom: '0.9rem',
	borderBottom: `1px solid ${colors.border}`,
	'& > h2': {
		margin: 0,
		fontSize: 'clamp(1.4rem, 2.4vw, 1.65rem)',
		fontWeight: 720,
		letterSpacing: '-0.016em',
	},
} satisfies CSSObject

const agentsDocsLinkCss = {
	color: colors.textMuted,
	fontSize: '0.95rem',
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
	flexShrink: 0,
} satisfies CSSObject

const readmeProseCss = mergeCss(proseCss, {
	marginTop: '1.4rem',
	'& h3': {
		margin: '1.8rem 0 0',
		fontSize: '1.15rem',
		fontWeight: 720,
		letterSpacing: '-0.01em',
	},
})

/* "Report this listing" tucked in a details disclosure. */
const reportDisclosureCss = {
	marginTop: 'clamp(2.4rem, 5vw, 3.2rem)',
	'& summary': {
		cursor: 'pointer',
		fontWeight: 600,
		color: colors.textMuted,
		width: 'fit-content',
		transition: `color ${transitions.fast}`,
	},
	'& summary:hover': {
		color: colors.text,
	},
	'&[open] summary': {
		color: colors.text,
	},
	'& > :not(summary)': {
		'@media (prefers-reduced-motion: no-preference)': {
			transition: `opacity 200ms ${transitions.easeOut}, translate 200ms ${transitions.easeOut}`,
		},
		'@starting-style': {
			opacity: 0,
			translate: '0 4px',
		},
	},
} satisfies CSSObject

const reportFormCss = {
	marginTop: '1.3rem',
	maxWidth: '34rem',
	display: 'grid',
	gap: '1rem',
	justifyItems: 'start',
} satisfies CSSObject

const reportFieldCss = {
	width: '100%',
	display: 'grid',
	gap: '0.45rem',
	'& > span': {
		fontSize: '0.92rem',
		fontWeight: 600,
		color: colors.text,
	},
} satisfies CSSObject

const reportTextareaCss = {
	font: `400 1rem/1.5 ${typography.fontFamilyBody}`,
	color: colors.text,
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '12px',
	padding: '0.85rem 1.05rem',
	width: '100%',
	minHeight: '6.5rem',
	resize: 'vertical' as const,
	boxSizing: 'border-box' as const,
	'&::placeholder': {
		color: colors.textMuted,
		opacity: 1,
	},
	'&:focus': {
		outline: 'none',
		borderColor: colors.primary,
		boxShadow: `0 0 0 3px oklch(from ${colors.primary} l c h / 0.25)`,
	},
} satisfies CSSObject

const reportLoginNoteCss = {
	margin: '1.3rem 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
} satisfies CSSObject
