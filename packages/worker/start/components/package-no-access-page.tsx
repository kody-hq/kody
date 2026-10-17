/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { SiteLink } from './site-link.tsx'
import { CopyTextButton } from './copy-text-button.tsx'
import { ErrorAgentPromptButton } from './error-agent-prompt-button.tsx'
import { routes } from '#universal/routes.ts'
import { buildPackageNoAccessErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	illustratedErrorActionsCss,
	illustratedErrorCopyCss,
	illustratedErrorHeadingCss,
	illustratedErrorImageCss,
	illustratedErrorPageCss,
} from '#client/illustrated-error-page.ts'

export type PackageNoAccessPageProps = {
	username: string
	kodyId: string
	packageName: string
	viewerUsername: string
}

/**
 * Signed-in visitor reached a real package they cannot open. Never reuse the
 * illustrated 404 — a shared private-app handoff must not look unpublished.
 */
export function PackageNoAccessPage(props: PackageNoAccessPageProps) {
	const { username, kodyId, packageName, viewerUsername } = props
	const packageHref = routes.communityPackage.href({ username, kodyId })
	const sharingDocsHref = routes.docDetail.href({ slug: 'package-sharing' })
	const requestMessage = [
		`Hi, please grant me Use on package ${packageName}`,
		`and Use on its hosted app (app:execute),`,
		`so I can open the package page and the package app.`,
		`(I'm @${viewerUsername}).`,
		`Package page: ${packageHref}`,
	].join(' ')
	const prompt = buildPackageNoAccessErrorAgentPrompt({
		path: packageHref,
		packageName,
		ownerUsername: username,
		viewerUsername,
	})

	return (
		<section data-testid="package-no-access-page" css={illustratedErrorPageCss}>
			<img
				src={publicAsset('/images/kody-404-disappointed.png')}
				alt="Kody looking disappointed, holding an Ethernet plug and a USB-C cable that do not match"
				width={1254}
				height={1254}
				css={illustratedErrorImageCss}
			/>
			<h1 css={illustratedErrorHeadingCss}>You don't have access</h1>
			<p css={illustratedErrorCopyCss}>
				<code css={packageNameCss}>{packageName}</code> is real, but your
				account (@{viewerUsername}) cannot open it. Ask the @{username} owner to
				grant you Use on this package and Use on its hosted app (app:execute).
				An org invite alone is not enough unless those grants come with it.
			</p>
			<nav aria-label="What to try next" css={illustratedErrorActionsCss}>
				<CopyTextButton
					value={requestMessage}
					idleLabel="Copy access request"
					copiedLabel="Copied"
					variant="pill"
					ariaLabel="Copy an access request message for the package owner"
				/>
				<SiteLink href={sharingDocsHref} css={getPillButtonCss()}>
					How sharing works
				</SiteLink>
				<SiteLink href={routes.home.href()} css={getGhostButtonCss()}>
					Go home
				</SiteLink>
			</nav>
			<ErrorAgentPromptButton prompt={prompt} />
		</section>
	)
}

const packageNameCss = {
	fontFamily: typography.fontFamilyMono,
	fontSize: '0.95em',
	color: colors.text,
}
