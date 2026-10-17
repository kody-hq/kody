import { createServerFn } from '@tanstack/react-start'
import { pickWithAgentOrder } from '#universal/with-agents.ts'

export const loadHome = createServerFn({ method: 'GET' }).handler(async () => {
	const [
		{ env },
		{ loadLandingHeroVideos },
		{ pickWalkthroughHosts },
		{ loadDocumentHead },
	] = await Promise.all([
		import('cloudflare:workers'),
		import('../../src/app/landing-hero-videos.ts'),
		import('../../universal/walkthrough-hosts.ts'),
		import('./document-head.ts'),
	])
	const landingHeroVideos = await loadLandingHeroVideos({ env })
	return {
		initialHosts: pickWalkthroughHosts(),
		landingAgentOrder: pickWithAgentOrder(),
		landingHeroVideos,
		head: loadDocumentHead('home', '/'),
	}
})
