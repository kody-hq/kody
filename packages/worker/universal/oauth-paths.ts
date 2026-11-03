/**
 * Shared OAuth protocol paths. The Cloudflare provider wrapper and native
 * Start consent/callback documents use these to keep their public URLs aligned.
 */
export const oauthPaths = {
	authorize: '/oauth/authorize',
	authorizeInfo: '/oauth/authorize-info',
	token: '/oauth/token',
	deviceAuthorization: '/oauth/device_authorization',
	device: '/device',
	agentIdentity: '/agent/identity',
	agentIdentityClaim: '/agent/identity/claim',
	agentClaim: '/agent/claim',
	register: '/oauth/register',
	callback: '/oauth/callback',
	userinfo: '/oauth/userinfo',
	logout: '/oauth/logout',
	apiPrefix: '/api/',
	discovery: '/.well-known/oauth-authorization-server',
	openidConfiguration: '/.well-known/openid-configuration',
	jwks: '/.well-known/jwks.json',
} as const

/**
 * "Sign in on another device" for Kody's own full-account sign-in (ADR 0094):
 * the requesting browser starts here (POST) and waits here (GET).
 */
export const accountDeviceSignInPath = '/login/device'

/** Device-code cookie for a browser signing in to a full Kody account. */
export const accountDeviceSignInCookieName = '__Host-kody_account_device'
export const accountDeviceSignInCookieNameInsecure = 'kody_account_device'
