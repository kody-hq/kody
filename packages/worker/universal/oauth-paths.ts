/**
 * Shared OAuth protocol paths. The Cloudflare provider wrapper and native
 * Start consent/callback documents use these to keep their public URLs aligned.
 */
export const oauthPaths = {
	authorize: '/oauth/authorize',
	authorizeInfo: '/oauth/authorize-info',
	token: '/oauth/token',
	register: '/oauth/register',
	callback: '/oauth/callback',
	userinfo: '/oauth/userinfo',
	logout: '/oauth/logout',
	apiPrefix: '/api/',
	discovery: '/.well-known/oauth-authorization-server',
	openidConfiguration: '/.well-known/openid-configuration',
	jwks: '/.well-known/jwks.json',
} as const
