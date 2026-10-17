/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { type CSSObject } from '@emotion/react'
import { type ReactNode } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { colors, radius, typography } from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
	mutedLinkCss,
	nativeDisclosureCss,
} from '#universal/styles/style-primitives.ts'
import { renderHighlightedCode } from '../components/syntax-highlight.tsx'
import {
	highlightSnippetKey,
	plainHighlightedCode,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'

type CopyCardProps = {
	label: string
	value: string
	copyLabel: string
	variant?: 'pill' | 'ghost'
	lang?: string | null
	highlights?: Record<string, HighlightedCode>
	/** Connect-flow copies only. Prompt copies leave this unset. */
	signalsConnectAction?: boolean
}

/**
 * Config snippet, ported from the prototype's `.snippet`: a labeled well on
 * the page ground with an uppercase display-face label and its copy button in
 * the header row. `pill` maps to the redesign's green pill; `ghost` is the
 * default and stays the quiet bordered button for follow-up copies.
 */
export function CopyCard(props: CopyCardProps) {
	return (
		<div css={snippetCss}>
			<div css={snippetHeadCss}>
				<span css={snippetLabelCss}>{props.label}</span>
				<div css={snippetActionCss}>
					<CopyTextButton
						value={props.value}
						idleLabel={props.copyLabel}
						variant={props.variant ?? 'ghost'}
						signalsConnectAction={props.signalsConnectAction}
					/>
				</div>
			</div>
			<div css={snippetPreCss}>
				{renderHighlightedCode(
					props.highlights?.[
						highlightSnippetKey({
							code: props.value,
							lang: props.lang,
						})
					] ?? plainHighlightedCode(props.value, props.lang),
				)}
			</div>
		</div>
	)
}

type CopyCardDetailsProps = CopyCardProps & {
	summaryLead: string
	summaryCode?: string
}

type OnboardingManualDetailsProps = {
	summaryLead: string
	summaryCode?: string
	children: ReactNode
}

/**
 * Collapsed alternative install path. Closed unless the caller sets `open`
 * on `<details>`.
 */
export function OnboardingManualDetails(props: OnboardingManualDetailsProps) {
	return (
		<details data-testid="onboarding-mcp-manual-json" css={nativeDisclosureCss}>
			<summary>
				{props.summaryLead}
				{props.summaryCode ? (
					<>
						{' '}
						<code>{props.summaryCode}</code>
					</>
				) : null}
				:
			</summary>
			<div>{props.children}</div>
		</details>
	)
}

/**
 * Collapsed manual snippet: the lead sentence is the summary, the copy
 * well sits inside.
 */
export function CopyCardDetails(props: CopyCardDetailsProps) {
	return (
		<OnboardingManualDetails
			summaryLead={props.summaryLead}
			summaryCode={props.summaryCode}
		>
			<CopyCard
				highlights={props.highlights}
				label={props.label}
				value={props.value}
				copyLabel={props.copyLabel}
				lang={props.lang}
				variant={props.variant}
				signalsConnectAction={props.signalsConnectAction}
			/>
		</OnboardingManualDetails>
	)
}

type AppIconCardProps = {
	src: string
	downloadName: string
}

/**
 * ChatGPT wants a PNG you can upload. Render the icon so right-click /
 * long-press Save as works, and keep a same-origin download link.
 */
export function AppIconCard(props: AppIconCardProps) {
	return (
		<div data-testid="onboarding-mcp-app-icon" css={snippetCss}>
			<div css={appIconBodyCss}>
				<img
					src={publicAsset(props.src)}
					alt="Kody app icon"
					width={256}
					height={256}
					css={appIconImgCss}
				/>
				<SiteLink
					href={props.src}
					download={props.downloadName}
					css={mutedLinkCss}
				>
					Download App Icon
				</SiteLink>
				<p css={appIconHintCss}>
					Right-click the icon and choose Save as (on a phone, long-press), then
					upload it in ChatGPT. Icons over 10 KB are rejected.
				</p>
			</div>
		</div>
	)
}

type ClientWarningProps = {
	children: string
}

/** Quiet danger note — red accent, not the green authenticate well. */
export function ClientWarning(props: ClientWarningProps) {
	return (
		<p css={clientDangerCss} role="note" data-testid="onboarding-agent-warning">
			{props.children}
		</p>
	)
}

type ChatGptDeveloperModeWarningProps = {
	href: string
	linkLabel: string
}

/**
 * Amber caution for ChatGPT's developer-mode alternative. Same quiet
 * callout language as {@link ClientWarning}, warning tone instead of danger.
 */
export function ChatGptDeveloperModeWarning(
	props: ChatGptDeveloperModeWarningProps,
) {
	return (
		<p css={clientCautionCss} role="note">
			ChatGPT developer mode is required. See{' '}
			<SiteLink href={props.href} target="_blank" rel="noreferrer noopener">
				{props.linkLabel}
			</SiteLink>
			.
		</p>
	)
}

export function PrimaryActionLink(props: {
	href: string
	label: string
	external?: boolean
}) {
	return (
		<div css={deepLinkCss}>
			<SiteLink
				href={props.href}
				target={props.external ? '_blank' : undefined}
				rel={props.external ? 'noreferrer noopener' : undefined}
				data-onboarding-connect-action="true"
				css={deepLinkButtonCss}
			>
				{props.label}
			</SiteLink>
		</div>
	)
}

export function InstallDeepLink(props: {
	href: string
	label: 'Add to Cursor' | 'Add to VS Code'
}) {
	return (
		<div css={deepLinkCss}>
			<SiteLink
				href={props.href}
				data-onboarding-connect-action="true"
				css={deepLinkButtonCss}
			>
				{props.label}
			</SiteLink>
			<small css={deepLinkNoteCss}>
				Your client will still ask you to authorize access afterwards.
			</small>
		</div>
	)
}

export function PluginPrimaryInstall(props: {
	href: string
	label:
		| 'Add to Cursor'
		| 'Add to Cursor Local'
		| 'Add to Cursor Cloud'
		| 'Add to Grok Bot'
	alternativeValue?: string
	alternativeCopyLabel?: string
}) {
	return (
		<div data-testid="onboarding-mcp-plugin-primary" css={deepLinkCss}>
			<SiteLink
				href={props.href}
				data-onboarding-connect-action="true"
				css={deepLinkButtonCss}
			>
				{props.label}
			</SiteLink>
			{props.alternativeValue ? (
				<p
					data-testid="onboarding-mcp-plugin-alternative"
					css={pluginAlternativeCss}
				>
					Or do this: <code>{props.alternativeValue}</code>
					<CopyTextButton
						value={props.alternativeValue}
						idleLabel="Copy"
						variant="chip"
						ariaLabel={props.alternativeCopyLabel}
						signalsConnectAction
					/>
				</p>
			) : null}
			<small css={deepLinkNoteCss}>
				Your client will still ask you to authorize access afterwards.
			</small>
		</div>
	)
}

const deepLinkCss: CSSObject = {
	display: 'grid',
	gap: '0.45rem',
	justifyItems: 'start',
}

const deepLinkButtonCss = getPillButtonCss()

const deepLinkNoteCss: CSSObject = {
	color: colors.textMuted,
	fontSize: '0.88rem',
}

const pluginAlternativeCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: '0.35rem 0.5rem',
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
	maxWidth: '72ch',
	'& code': {
		overflowWrap: 'anywhere' as const,
	},
}

/* Config snippets: labeled wells with their copy button in the header. */
const snippetCss: CSSObject = {
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	backgroundColor: colors.background,
	overflow: 'hidden' as const,
	minWidth: 0,
	width: '100%',
}

const snippetHeadCss: CSSObject = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	gap: '0.6rem',
	padding: '0.5rem 0.6rem 0.5rem 1.1rem',
	borderBottom: `1px solid ${colors.border}`,
	'@media (max-width: 720px)': {
		flexWrap: 'wrap' as const,
	},
}

const snippetLabelCss: CSSObject = {
	font: `700 0.75rem/1 ${typography.fontFamilyDisplay}`,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.09em',
	color: colors.textMuted,
}

/* Header copy buttons run one size down from the standalone pills. */
const snippetActionCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'flex-end',
	gap: '0.4rem',
	'& > button, & > a': {
		fontSize: '0.88rem',
		padding: '0.5rem 1rem',
	},
}

const appIconBodyCss: CSSObject = {
	display: 'grid',
	justifyItems: 'start',
	gap: '0.75rem',
	padding: '1rem 1.2rem',
}

const appIconImgCss: CSSObject = {
	display: 'block',
	width: 'min(256px, 100%)',
	height: 'auto',
	aspectRatio: '1',
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
}

const appIconHintCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
	maxWidth: '48ch',
}

const snippetPreCss: CSSObject = {
	'& pre': {
		margin: 0,
		padding: '1rem 1.2rem',
		font: '500 0.92rem/1.6 ui-monospace, "SF Mono", Menlo, monospace',
		whiteSpace: 'pre-wrap' as const,
		wordBreak: 'break-word' as const,
		backgroundColor: 'transparent',
		overflow: 'visible' as const,
	},
	'& pre code': {
		font: 'inherit',
		color: 'inherit',
		backgroundColor: 'transparent',
		border: 'none',
		borderRadius: 0,
		padding: 0,
	},
}

/** Gold/amber already used for caution chrome (fork-outdated copy). */
const warningAccent = 'oklch(0.72 0.14 85)'

function getClientNoteCss(accentColor: string) {
	return {
		...getAccentCalloutCss({ accentColor }),
		margin: 0,
		padding: '0.55rem 0.85rem',
		backgroundColor: `oklch(from ${accentColor} l c h / 0.08)`,
		color: colors.textMuted,
		fontSize: typography.fontSize.sm,
		maxWidth: '72ch',
		'& a': {
			color: colors.primaryText,
		},
	}
}

const clientDangerCss = getClientNoteCss(colors.danger)
const clientCautionCss = getClientNoteCss(warningAccent)
