/** @jsxImportSource @emotion/react */
import { useState } from 'react'

import { CopyCodeBlock } from '../components/copy-code-block.tsx'
import {
	highlightSnippetKey,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'
import { type WalkthroughHostPick } from '#universal/walkthrough-hosts.ts'
import {
	howKodyWorksPackageFiles,
	howKodyWorksTranscriptActs,
	transcriptFileLang,
} from '#client/routes/how-kody-works-transcript.ts'
import {
	interactiveGuideActCss,
	interactiveGuideKickerCss,
	interactiveGuideMutedLeadCss,
	interactiveGuideToolBodyCss,
	interactiveGuideToolCss,
	interactiveGuideToolsCss,
	interactiveGuideToolNameCss,
	interactiveGuideToolSummaryCss,
	renderInteractiveGuideWalkthrough,
} from './interactive-guide-walkthrough.tsx'
import {
	renderWalkthroughPackageTitle,
	walkthroughPackageTitleLabel,
} from './walkthrough-ask-kicker.tsx'
import { WalkthroughHostIntro } from './walkthrough-host-intro.tsx'

/**
 * Interactive factory-loop transcript for /docs/how-kody-works.
 * Shared line/tool rendering lives in interactive-guide-walkthrough.tsx.
 * Host selects live in the lead so changing an agent updates the
 * conversation marks and the package-title marks together. The
 * interactive guide opts out of page translation so Chrome Translate
 * cannot rewrite those remounted nodes (KODY-7N).
 */
export function HowKodyWorksWalkthrough(props: {
	highlights?: Record<string, HighlightedCode>
	hosts?: WalkthroughHostPick
}) {
	const [hosts, setHosts] = useState(props.hosts)
	return renderInteractiveGuideWalkthrough({
		lockTranslation: true,
		lead: hosts ? (
			<WalkthroughHostIntro
				hosts={hosts}
				onHostsChange={(next) => {
					setHosts(next)
				}}
			/>
		) : (
			'A question you would ask again becomes an export you can invoke from any agent, then a daily email that stays quiet until something actually shipped.'
		),
		acts: howKodyWorksTranscriptActs,
		highlights: props.highlights,
		hosts,
		afterActs: (
			<section
				css={interactiveGuideActCss}
				aria-labelledby="package-files-title"
			>
				<p css={interactiveGuideKickerCss}>The package</p>
				<h2
					id="package-files-title"
					aria-label={walkthroughPackageTitleLabel(hosts)}
				>
					{renderWalkthroughPackageTitle(hosts)}
				</h2>
				<p css={interactiveGuideMutedLeadCss}>
					Same implementation for “ask again” and the morning job. The job calls{' '}
					<code>emailSend</code> only when the list is not empty.
				</p>
				<div css={interactiveGuideToolsCss}>
					{(
						Object.entries(howKodyWorksPackageFiles) as Array<
							[keyof typeof howKodyWorksPackageFiles, string]
						>
					).map(([path, code]) => (
						<details key={path} css={interactiveGuideToolCss}>
							<summary>
								<span css={interactiveGuideToolNameCss}>{path}</span>
								<span css={interactiveGuideToolSummaryCss}>
									{packageFileSummary(path)}
								</span>
							</summary>
							<div css={interactiveGuideToolBodyCss}>
								<CopyCodeBlock
									copy={false}
									code={code}
									lang={transcriptFileLang(path)}
									highlighted={
										props.highlights?.[
											highlightSnippetKey({
												code,
												lang: transcriptFileLang(path),
											})
										]
									}
								/>
							</div>
						</details>
					))}
				</div>
			</section>
		),
	})
}

function packageFileSummary(path: keyof typeof howKodyWorksPackageFiles) {
	switch (path) {
		case 'src/daily-digest.ts':
			return 'Skip mail on a quiet day'
		case 'src/what-shipped.ts':
			return 'Filter public events and advance the cursor'
		case 'package.json':
			return 'Export plus a daily job'
		case 'README.md':
			return 'Why this package exists'
		case 'AGENTS.md':
			return 'Imports, smoke tests, and edge cases'
		default: {
			const exhaustive: never = path
			return exhaustive
		}
	}
}
