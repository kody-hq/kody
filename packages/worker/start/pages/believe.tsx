/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { docHref } from '#universal/docs-nav.ts'
import { routes } from '#universal/routes.ts'
import {
	articleMeasure,
	pageGutter,
	pageHeadCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

type Belief = {
	id: string
	title: string
	body: string
	inProduct: string
	docSlug: string
	docLabel: string
}

/**
 * Each belief must point at behavior the product already ships, with a doc
 * that describes it. Do not add beliefs the product does not back up.
 */
const beliefs: ReadonlyArray<Belief> = [
	{
		id: 'invisible-software',
		title: 'The best software is invisible.',
		body: 'People want problems solved, not another app to learn. Your team already has agents they like. Kody should make those agents better without asking anyone to open something new.',
		inProduct:
			'There is no Kody chat app. Your agent reaches Kody over MCP, and you keep working where you already work.',
		docSlug: 'what-is-kody',
		docLabel: 'What is Kody?',
	},
	{
		id: 'your-agent',
		title: 'Your agent is your choice.',
		body: 'Agents change fast, and people on the same team prefer different ones. Switching agents should not mean starting over, and one person\u2019s pick should not decide everyone else\u2019s.',
		inProduct:
			'Every agent you connect shares one account: the same memories, credentials, packages, and jobs. Org accounts let a whole team share that home.',
		docSlug: 'connect-your-agent',
		docLabel: 'Connect your agent',
	},
	{
		id: 'keys-stay-out',
		title: 'Keys belong out of the prompt.',
		body: 'An agent can be talked into anything that is in its context. A credential pasted into chat or a .env file is one bad instruction away from leaking.',
		inProduct:
			'No capability returns a credential, and there is deliberately no plaintext secret_get. Code uses keys by name, and Kody fills them in at the network boundary, only for hosts you approved.',
		docSlug: 'secrets',
		docLabel: 'Secrets',
	},
	{
		id: 'done-once',
		title: 'Work done once should stay done.',
		body: 'Asking an agent to redo the same task every morning spends tokens and invites drift. Once something works, it should keep working without a model deciding how to do it again.',
		inProduct:
			'Jobs, workflows, webhooks, and email run saved packages with no model in the loop. Kody runs no chat-model loop and bills no chat tokens.',
		docSlug: 'triggers',
		docLabel: 'Jobs, workflows, and webhooks',
	},
	{
		id: 'you-own-it',
		title: 'You own what your agents build.',
		body: 'The useful things your agents make should not be locked inside one vendor\u2019s chat history or someone else\u2019s runtime.',
		inProduct:
			'Packages are code in your account that you can open, change, schedule, and republish. Installing a public package gives you a fork you own. Kody itself is Fair Source.',
		docSlug: 'package-sharing',
		docLabel: 'Sharing a package',
	},
]

/**
 * `/believe`: the beliefs behind Kody, each tied to a product behavior.
 * Linked from the homepage "Invisible software" closing section.
 */
export function BelieveRoute() {
	return (
		<article css={pageCss}>
			<header css={headCss}>
				<h1>What we believe</h1>
				<p>
					Kody is the shared cloud behind your team&rsquo;s agents. These are
					the beliefs that shape it, and where each one shows up in the product
					today.
				</p>
			</header>

			<ol css={listCss}>
				{beliefs.map((belief, index) => (
					<li key={belief.id} css={beliefCss}>
						<h2 id={belief.id} css={beliefTitleCss}>
							<span css={numberCss} aria-hidden="true">
								{String(index + 1).padStart(2, '0')}
							</span>
							{belief.title}
						</h2>
						<p css={bodyCss}>{belief.body}</p>
						<p css={inProductCss}>
							<strong>In the product: </strong>
							{belief.inProduct}{' '}
							<SiteLink href={docHref(belief.docSlug)}>
								{belief.docLabel}
							</SiteLink>
						</p>
					</li>
				))}
			</ol>

			<p css={footCss}>
				<SiteLink href={routes.home.href()} css={backLinkCss}>
					← Home
				</SiteLink>
			</p>
		</article>
	)
}

const pageCss = {
	maxWidth: articleMeasure,
	marginInline: 'auto',
	padding: `clamp(2.5rem, 6vw, 4rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
}

const headCss = {
	...pageHeadCss,
	'& h1': {
		margin: 0,
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.06,
		textWrap: 'balance' as const,
	},
	'& > p': {
		margin: '0.85rem 0 0',
		maxWidth: '36rem',
		fontSize: '1.05rem',
		lineHeight: 1.55,
		color: colors.textMuted,
	},
}

const listCss = {
	listStyle: 'none',
	margin: 'clamp(2.5rem, 6vw, 3.5rem) 0 0',
	padding: 0,
	display: 'grid',
	gap: 'clamp(2.25rem, 5vw, 3rem)',
}

const beliefCss = {
	margin: 0,
}

const beliefTitleCss = {
	display: 'flex',
	alignItems: 'baseline',
	gap: '0.75rem',
	margin: '0 0 0.6rem',
	fontSize: '1.5rem',
	fontWeight: 700,
	letterSpacing: '-0.02em',
	lineHeight: 1.2,
	scrollMarginTop: '5rem',
}

const numberCss = {
	flex: 'none',
	fontSize: '0.95rem',
	fontWeight: 650,
	fontVariantNumeric: 'tabular-nums' as const,
	color: colors.primaryText,
}

const bodyCss = {
	margin: 0,
	fontSize: '1.05rem',
	lineHeight: 1.65,
	color: colors.text,
}

const inProductCss = {
	margin: '0.85rem 0 0',
	paddingLeft: '0.9rem',
	borderLeft: `2px solid ${colors.primaryText}`,
	fontSize: '0.98rem',
	lineHeight: 1.6,
	color: colors.textMuted,
	'& strong': {
		fontWeight: 650,
		color: colors.text,
	},
	'& a': {
		color: colors.primaryText,
		textDecoration: 'none',
		fontWeight: 550,
		whiteSpace: 'nowrap' as const,
		'&:hover': {
			color: colors.text,
		},
	},
}

const footCss = {
	marginTop: 'clamp(2.5rem, 6vw, 3.5rem)',
}

const backLinkCss = {
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}
