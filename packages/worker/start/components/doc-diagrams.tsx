/** @jsxImportSource @emotion/react */
import { type ReactNode } from 'react'
import { type CSSObject } from '@emotion/react'
import {
	breakpoints,
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

/**
 * First-party figures that docs place with `> [!DIAGRAM] <id>`. The
 * blockquote's remaining text is the caption, which is also what agents read
 * in the raw markdown, so a figure only illustrates what the caption says.
 * An unknown id renders as an ordinary blockquote.
 */
const docDiagrams: ReadonlyMap<string, () => ReactNode> = new Map([
	['placeholder-fill', renderPlaceholderFillDiagram],
])

export function renderDocDiagram(input: {
	id: string
	key: number
	caption: ReactNode
}): ReactNode | null {
	const draw = docDiagrams.get(input.id)
	if (!draw) return null
	return (
		<figure key={input.key} data-doc-diagram={input.id} css={figureCss}>
			<label css={pauseCss}>
				<input type="checkbox" css={pauseInputCss} />
				Pause animation
			</label>
			{draw()}
			<figcaption css={captionCss}>{input.caption}</figcaption>
		</figure>
	)
}

const motionOk = '@media (prefers-reduced-motion: no-preference)'
/**
 * Ten seconds, so a keyframe at N% happens N/10 s into the cycle: the
 * request leaves at 0.8 s, the gateway checks run 2–3.2 s, the filled request
 * reaches the service at 5 s, and the redacted reply lands at 7.4 s. Each
 * piece starts dim and lights up at its step. After the last cycle the
 * figure rests on its finished state, which is also what reduced motion
 * shows.
 */
const cycleSeconds = 10
const cycles = 3

const dim = { opacity: 0.28 }
const lit = { opacity: 1 }

function animated(name: string) {
	return {
		[motionOk]: {
			animation: `${name} ${cycleSeconds}s linear ${cycles} both`,
		},
	}
}

/** Stacked cards run the wire top to bottom, so the dot travels on y. */
const stackedMotionOk = `@media (max-width: ${breakpoints.tablet}) and (prefers-reduced-motion: no-preference)`

function renderWire(input: { name: string; label: string }) {
	return (
		<div css={wireCss}>
			<span css={wireLineCss} />
			<span
				css={{
					...wireDotCss,
					...animated(input.name),
					[stackedMotionOk]: { animationName: `${input.name}-y` },
				}}
			/>
			<span css={wireLabelCss}>{input.label}</span>
		</div>
	)
}

function renderPlaceholderFillDiagram() {
	return (
		<div css={stageCss} aria-hidden="true">
			<section css={cardCss}>
				<p css={cardTitleCss}>Your code</p>
				<div css={codeCss}>
					{`fetch(reposUrl, {\n  headers: {\n    Authorization:\n      'Bearer `}
					<mark css={placeholderCss}>{'{{secret:github}}'}</mark>
					{`',\n  },\n})`}
				</div>
				<p
					css={{
						...replyCss,
						...animated('kody-diagram-reveal-reply'),
					}}
				>
					An echoed value comes back as <code>[REDACTED SECRET]</code>
				</p>
			</section>

			{renderWire({
				name: 'kody-diagram-travel-to-gateway',
				label: 'request',
			})}

			<section css={{ ...cardCss, ...gatewayCardCss }}>
				<p css={cardTitleCss}>Kody gateway</p>
				<ul css={checkListCss}>
					<li css={animated('kody-diagram-reveal-https')}>HTTPS request</li>
					<li css={animated('kody-diagram-reveal-host')}>
						api.github.com is an allowed host for <code>github</code>
					</li>
					<li css={animated('kody-diagram-reveal-fill')}>Value filled in</li>
					<li css={animated('kody-diagram-reveal-echo')}>
						Echoed value redacted
					</li>
				</ul>
			</section>

			{renderWire({
				name: 'kody-diagram-travel-to-service',
				label: 'filled',
			})}

			<section css={{ ...cardCss, ...animated('kody-diagram-reveal-service') }}>
				<p css={cardTitleCss}>api.github.com</p>
				<div css={codeCss}>
					{'Authorization:\n  Bearer '}
					<span css={maskCss}>{'••••••••••'}</span>
				</div>
				<p css={noteCss}>Only the service sees the value.</p>
			</section>
		</div>
	)
}

const figureCss: CSSObject = {
	margin: '0 0 1.6rem',
	display: 'grid',
	gap: spacing.sm,
	'@keyframes kody-diagram-reveal-https': {
		'0%, 20%': dim,
		'24%, 100%': lit,
	},
	'@keyframes kody-diagram-reveal-host': {
		'0%, 26%': dim,
		'30%, 100%': lit,
	},
	'@keyframes kody-diagram-reveal-fill': {
		'0%, 32%': dim,
		'36%, 100%': lit,
	},
	'@keyframes kody-diagram-reveal-service': {
		'0%, 50%': dim,
		'54%, 100%': lit,
	},
	'@keyframes kody-diagram-reveal-echo': {
		'0%, 66%': dim,
		'70%, 100%': lit,
	},
	'@keyframes kody-diagram-reveal-reply': {
		'0%, 74%': dim,
		'78%, 100%': lit,
	},
	'@keyframes kody-diagram-travel-to-gateway': {
		'0%, 8%': { opacity: 0, left: '0%', top: '50%' },
		'9.5%': { opacity: 1, left: '0%', top: '50%' },
		'18%': { opacity: 1, left: '100%', top: '50%' },
		'19.5%, 100%': { opacity: 0, left: '100%', top: '50%' },
	},
	'@keyframes kody-diagram-travel-to-service': {
		'0%, 38%': { opacity: 0, left: '0%', top: '50%' },
		'39.5%': { opacity: 1, left: '0%', top: '50%' },
		'48%': { opacity: 1, left: '100%', top: '50%' },
		'49.5%, 100%': { opacity: 0, left: '100%', top: '50%' },
	},
	'@keyframes kody-diagram-travel-to-gateway-y': {
		'0%, 8%': { opacity: 0, top: '0%', left: '50%' },
		'9.5%': { opacity: 1, top: '0%', left: '50%' },
		'18%': { opacity: 1, top: '100%', left: '50%' },
		'19.5%, 100%': { opacity: 0, top: '100%', left: '50%' },
	},
	'@keyframes kody-diagram-travel-to-service-y': {
		'0%, 38%': { opacity: 0, top: '0%', left: '50%' },
		'39.5%': { opacity: 1, top: '0%', left: '50%' },
		'48%': { opacity: 1, top: '100%', left: '50%' },
		'49.5%, 100%': { opacity: 0, top: '100%', left: '50%' },
	},
	'&:hover *, &:has(input:checked) *': { animationPlayState: 'paused' },
}

const pauseCss: CSSObject = {
	display: 'none',
	justifySelf: 'end',
	alignItems: 'center',
	gap: spacing.xs,
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
	cursor: 'pointer',
	[motionOk]: { display: 'inline-flex' },
}

const pauseInputCss: CSSObject = {
	margin: 0,
	accentColor: colors.primary,
}

const stageCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns:
		'minmax(0, 1.25fr) 3.5rem minmax(0, 1fr) 3.5rem minmax(0, 1fr)',
	alignItems: 'stretch',
	padding: spacing.md,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	background: colors.surface,
	[mq.tablet]: {
		gridTemplateColumns: 'minmax(0, 1fr)',
	},
}

const cardCss: CSSObject = {
	margin: 0,
	padding: spacing.sm,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	background: colors.background,
	display: 'grid',
	alignContent: 'start',
	gap: spacing.xs,
	minWidth: 0,
}

const gatewayCardCss: CSSObject = {
	borderColor: colors.primary,
	background: colors.primarySoftest,
}

const cardTitleCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	letterSpacing: '0.04em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const codeCss: CSSObject = {
	fontFamily: typography.fontFamilyMono,
	fontSize: '0.78rem',
	lineHeight: 1.5,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
}

const placeholderCss: CSSObject = {
	padding: '0 0.2em',
	borderRadius: radius.sm,
	background: colors.primarySoftStrong,
	color: colors.text,
}

const maskCss: CSSObject = {
	padding: '0 0.2em',
	borderRadius: radius.sm,
	background: colors.text,
	color: colors.text,
	letterSpacing: '-0.05em',
}

const checkListCss: CSSObject = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.xs,
	fontSize: typography.fontSize.sm,
	'& > li::before': {
		content: '"✓ "',
		color: colors.primary,
		fontWeight: typography.fontWeight.bold,
	},
}

const replyCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
}

const noteCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
}

const wireCss: CSSObject = {
	position: 'relative' as const,
	minHeight: '2.5rem',
}

const wireLineCss: CSSObject = {
	position: 'absolute' as const,
	left: '0.25rem',
	right: '0.25rem',
	top: '50%',
	borderTop: `2px dashed ${colors.border}`,
	[mq.tablet]: {
		left: '50%',
		right: 'auto',
		top: '0.25rem',
		bottom: '0.25rem',
		borderTop: 'none',
		borderLeft: `2px dashed ${colors.border}`,
	},
}

const wireDotCss: CSSObject = {
	position: 'absolute' as const,
	left: '0%',
	top: '50%',
	width: '0.7rem',
	height: '0.7rem',
	marginLeft: '-0.35rem',
	marginTop: '-0.35rem',
	borderRadius: radius.full,
	background: colors.primary,
	opacity: 0,
}

const wireLabelCss: CSSObject = {
	position: 'absolute' as const,
	left: 0,
	right: 0,
	top: 'calc(50% + 0.4rem)',
	textAlign: 'center' as const,
	fontSize: '0.68rem',
	color: colors.textMuted,
	[mq.tablet]: {
		top: '50%',
		left: 'calc(50% + 0.6rem)',
		right: 'auto',
		transform: 'translateY(-50%)',
	},
}

const captionCss: CSSObject = {
	maxWidth: '62ch',
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	'& > p': { margin: 0 },
}
