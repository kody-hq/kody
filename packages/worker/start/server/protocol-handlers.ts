import { getStartRequestEnv } from './request-env.ts'
import {
	createRobotsTxtHandler,
	createSitemapHandler,
	createAuthMarkdownHandler,
	createMcpServerCardHandler,
	createApiCatalogHandler,
	createAgentSkillsIndexHandler,
	createAgentSkillMarkdownHandler,
	createSecurityTxtHandler,
	createOpenaiAppsChallengeHandler,
} from '#app/handlers/agent-discovery.ts'
import { createHealthHandler } from '#app/handlers/health.ts'
import { createHealthComponentsHandler } from '#app/handlers/health-components.ts'
import { createSentryTunnelHandler } from '#app/handlers/sentry-tunnel.ts'
import { createOgPageImageHandler } from '#app/handlers/og-page-image.ts'
import {
	createBlogRssHandler,
	createBlogPostMarkdownHandler,
	createBlogPostOgImageHandler,
} from '#app/handlers/blog.ts'
import {
	createDocsMarkdownHandler,
	createDocsLlmsTxtHandler,
	createDocsConnectMarkdownHandler,
	createDocDetailMarkdownHandler,
	createDocDetailOgImageHandler,
	createLlmsTxtHandler,
} from '#app/handlers/docs.ts'
import { createYoutubeThumbHandler } from '#app/handlers/youtube-thumb.ts'
import { createAccountExportHandler } from '#app/handlers/account-export.ts'
import { createMcpServerLogoHandler } from '#app/handlers/mcp-server-logo.ts'
import { createAccountMcpServersOauthCallbackHandler } from '#app/handlers/account-mcp-servers.ts'
import { createAccountMemoriesExportHandler } from './memories-export.ts'
import {
	createCommunityDetailRawHandler,
	createCommunityPackageRawHandler,
} from '#app/handlers/package-files-raw.ts'
import {
	createCommunityPackageAssetHandler,
	createCommunityDetailAssetHandler,
} from '#app/handlers/package-readme-assets.ts'
import { createCommunityIconHandler } from '#app/handlers/community-icon.ts'
import { createCommunityPackageIconHandler } from '#app/handlers/community-package-icon.ts'
import { createAccountRepoIconHandler } from '#app/handlers/account-repo-icon.ts'
import { createIntegrationLogoHandler } from '#app/handlers/integration-logo.ts'
import { createProviderMarkLogoHandler } from '#app/handlers/provider-mark-logo.ts'
import { createCommunityDetailOgImageHandler } from '#app/handlers/community-detail.ts'
import { createOrgAvatarHandler } from '#app/handlers/org-avatar.ts'
import { createProfileAvatarHandler } from '#app/handlers/profile-avatar.ts'
import { createProfileOgImageHandler } from '#app/handlers/profile.ts'
import { createWebhookIngressHandler } from '#app/handlers/webhook-ingress.ts'
import { createStripeWebhookHandler } from '#app/handlers/stripe-webhook.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { createAuthProviderCallbackHandler } from '#app/handlers/auth-provider.ts'
import { createSessionHandler } from '#app/handlers/session.ts'

export const robotsTxtHttp = ({ request }: { request: Request; params: {} }) =>
	createRobotsTxtHandler(getStartRequestEnv())({ request })

export const sitemapHttp = ({ request }: { request: Request; params: {} }) =>
	createSitemapHandler(getStartRequestEnv())({ request })

export const authMarkdownHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createAuthMarkdownHandler(getStartRequestEnv())({ request })

export const mcpServerCardHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createMcpServerCardHandler(getStartRequestEnv())({ request })

export const apiCatalogHttp = ({ request }: { request: Request; params: {} }) =>
	createApiCatalogHandler(getStartRequestEnv())({ request })

export const agentSkillsIndexHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createAgentSkillsIndexHandler(getStartRequestEnv())({ request })

export const agentSkillMarkdownHttp = ({
	params,
}: {
	request: Request
	params: { skillId: string }
}) =>
	createAgentSkillMarkdownHandler(getStartRequestEnv())({
		params: { skillId: params.skillId },
	})

export const securityTxtHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createSecurityTxtHandler(getStartRequestEnv())({ request })

export const openaiAppsChallengeHttp = () =>
	createOpenaiAppsChallengeHandler(getStartRequestEnv())()

export const healthHttp = ({ request }: { request: Request; params: {} }) =>
	createHealthHandler(getStartRequestEnv())({ request })

const healthCollectors = new WeakMap<
	Env,
	ReturnType<typeof createHealthComponentsHandler>
>()
export const healthComponentsHttp = () => {
	const bindings = getStartRequestEnv()
	let collector = healthCollectors.get(bindings)
	if (!collector) {
		collector = createHealthComponentsHandler(bindings)
		healthCollectors.set(bindings, collector)
	}
	return collector()
}

export const sentryTunnelHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createSentryTunnelHandler(getStartRequestEnv())({ request })

export const ogPageImageHttp = ({
	request,
	params,
}: {
	request: Request
	params: { page: string }
}) =>
	createOgPageImageHandler(getStartRequestEnv())({
		request,
		params: { page: params.page },
	})

export const blogRssHttp = ({ request }: { request: Request; params: {} }) =>
	createBlogRssHandler(getStartRequestEnv())({ request })

export const blogPostMarkdownHttp = ({
	params,
}: {
	request: Request
	params: { slug: string }
}) =>
	createBlogPostMarkdownHandler(getStartRequestEnv())({
		params: { slug: params.slug },
	})

export const blogPostOgImageHttp = ({
	request,
	params,
}: {
	request: Request
	params: { slug: string }
}) =>
	createBlogPostOgImageHandler(getStartRequestEnv())({
		request,
		params: { slug: params.slug },
	})

export const docsMarkdownHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createDocsMarkdownHandler(getStartRequestEnv())({ request })

export const docsLlmsTxtHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createDocsLlmsTxtHandler(getStartRequestEnv())({ request })

export const docsConnectMarkdownHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createDocsConnectMarkdownHandler(getStartRequestEnv())({ request })

export const docDetailMarkdownHttp = ({
	request,
	params,
}: {
	request: Request
	params: { slug: string }
}) =>
	createDocDetailMarkdownHandler(getStartRequestEnv())({
		request,
		params: { slug: params.slug },
	})

export const docDetailOgImageHttp = ({
	request,
	params,
}: {
	request: Request
	params: { slug: string }
}) =>
	createDocDetailOgImageHandler(getStartRequestEnv())({
		request,
		params: { slug: params.slug },
	})

export const llmsTxtHttp = ({ request }: { request: Request; params: {} }) =>
	createLlmsTxtHandler(getStartRequestEnv())({ request })

export const youtubeThumbHttp = ({
	request,
	params,
}: {
	request: Request
	params: { videoId: string }
}) =>
	createYoutubeThumbHandler(getStartRequestEnv())({
		request,
		params: { videoId: params.videoId },
	})

export const accountExportHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createAccountExportHandler(getStartRequestEnv())({ request })

export const accountMcpServerLogoHttp = ({
	request,
	params,
}: {
	request: Request
	params: { serverId: string }
}) =>
	createMcpServerLogoHandler(getStartRequestEnv())({
		request,
		params: { serverId: params.serverId },
	})

export const accountMcpServersOauthCallbackHttp = ({
	request,
}: {
	request: Request
	params: {}
}) =>
	createAccountMcpServersOauthCallbackHandler(getStartRequestEnv())({ request })

export const accountMemoriesExportHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createAccountMemoriesExportHandler(getStartRequestEnv())({ request })

export const communityDetailRawHttp = ({
	request,
	params,
}: {
	request: Request
	params: { listingId: string; _splat?: string }
}) =>
	createCommunityDetailRawHandler(getStartRequestEnv())({
		request,
		params: {
			listingId: params.listingId,
			relativePath: params._splat ?? '',
		},
	})

export const communityPackageRawHttp = ({
	request,
	params,
}: {
	request: Request
	params: { username: string; kodyId: string; ref: string; _splat?: string }
}) =>
	createCommunityPackageRawHandler(getStartRequestEnv())({
		request,
		params: {
			username: params.username,
			kodyId: params.kodyId,
			ref: params.ref,
			relativePath: params._splat ?? '',
		},
	})

export const communityPackageAssetHttp = ({
	request,
	params,
}: {
	request: Request
	params: { username: string; kodyId: string; _splat?: string }
}) =>
	createCommunityPackageAssetHandler(getStartRequestEnv())({
		request,
		params: {
			username: params.username,
			kodyId: params.kodyId,
			relativePath: params._splat ?? '',
		},
	})

export const communityDetailAssetHttp = ({
	params,
}: {
	request: Request
	params: { listingId: string; _splat?: string }
}) =>
	createCommunityDetailAssetHandler(getStartRequestEnv())({
		params: {
			listingId: params.listingId,
			relativePath: params._splat ?? '',
		},
	})

export const communityDetailIconHttp = ({
	params,
}: {
	request: Request
	params: { listingId: string; iconCommit: string }
}) =>
	createCommunityIconHandler(getStartRequestEnv())({
		params: {
			listingId: params.listingId,
			iconCommit: params.iconCommit,
		},
	})

export const communityPackageIconHttp = ({
	request,
	params,
}: {
	request: Request
	params: { username: string; kodyId: string; iconCommit: string }
}) =>
	createCommunityPackageIconHandler(getStartRequestEnv())({
		request,
		params: {
			username: params.username,
			kodyId: params.kodyId,
			iconCommit: params.iconCommit,
		},
	})

export const accountRepoIconHttp = ({
	request,
	params,
}: {
	request: Request
	params: { repoId: string; iconCommit: string }
}) =>
	createAccountRepoIconHandler(getStartRequestEnv())({
		request,
		params: {
			repoId: params.repoId,
			iconCommit: params.iconCommit,
		},
	})

export const integrationLogoHttp = ({
	request,
	params,
}: {
	request: Request
	params: { integrationSlug: string }
}) =>
	createIntegrationLogoHandler(getStartRequestEnv())({
		request,
		params: { integrationSlug: params.integrationSlug },
	})

export const providerMarkLogoHttp = ({
	params,
}: {
	request: Request
	params: { slug: string }
}) =>
	createProviderMarkLogoHandler(getStartRequestEnv())({
		params: { slug: params.slug },
	})

export const communityDetailOgImageHttp = ({
	request,
	params,
}: {
	request: Request
	params: { listingId: string }
}) =>
	createCommunityDetailOgImageHandler(getStartRequestEnv())({
		request,
		params: { listingId: params.listingId },
	})

export const orgAvatarHttp = ({
	request,
	params,
}: {
	request: Request
	params: { orgSlug: string; hash: string; ext: string }
}) =>
	createOrgAvatarHandler(getStartRequestEnv())({
		request,
		params: {
			orgSlug: params.orgSlug,
			hash: params.hash,
			ext: params.ext,
		},
	})

export const profileAvatarHttp = ({
	request,
	params,
}: {
	request: Request
	params: { username: string; hash: string; ext: string }
}) =>
	createProfileAvatarHandler(getStartRequestEnv())({
		request,
		params: {
			username: params.username,
			hash: params.hash,
			ext: params.ext,
		},
	})

export const profileOgImageHttp = ({
	request,
	params,
}: {
	request: Request
	params: { username: string }
}) =>
	createProfileOgImageHandler(getStartRequestEnv())({
		request,
		params: { username: params.username },
	})

export const webhookIngressHttp = ({
	request,
}: {
	request: Request
	params: {
		username: string
		packageKodyId: string
		webhookName: string
		urlSecret: string
	}
}) => createWebhookIngressHandler(getStartRequestEnv())({ request })

export const stripeWebhookHttp = ({
	request,
}: {
	request: Request
	params: {}
}) => createStripeWebhookHandler(getStartRequestEnv())({ request })

export const authHttp = ({ request }: { request: Request; params: {} }) =>
	createAuthHandler(getStartRequestEnv())({ request })

export const authProviderCallbackHttp = ({
	request,
	params,
}: {
	request: Request
	params: { provider: string }
}) =>
	createAuthProviderCallbackHandler(getStartRequestEnv())({
		request,
		params: { provider: params.provider },
	})

export const sessionHttp = ({ request }: { request: Request; params: {} }) =>
	createSessionHandler(getStartRequestEnv())({ request })
