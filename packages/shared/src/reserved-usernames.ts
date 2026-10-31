/**
 * Static denylist for handles that must not be claimed as usernames or
 * organization slugs (shared `@` namespace). Covers brand/product identity,
 * support/trust surfaces, infrastructure and route-like names, and RFC 5321
 * mailbox locals commonly used for system mail. Keep this array sorted,
 * unique, and lowercase so diffs stay reviewable.
 *
 * Lives in shared so the create-org client can hint with the built-in list;
 * admin KV overrides stay server-only via reserved-username-settings.
 */
export const builtInReservedUsernameList = [
	'abuse',
	'account',
	'accounts',
	'acme',
	'acme-challenge',
	'admin',
	'administrator',
	'agent',
	'agents',
	'alpha',
	'anonymous',
	'anthropic',
	'api',
	'apis',
	'app',
	'apple',
	'apps',
	'assets',
	'auth',
	'autoconfig',
	'autodiscover',
	'beta',
	'billing',
	'blog',
	'bot',
	'bots',
	'bounce',
	'broadcasthost',
	'callback',
	'callbacks',
	'canary',
	'careers',
	'cdn',
	'ceo',
	'checkout',
	'cloudflare',
	'community',
	'connect',
	'connector',
	'connectors',
	'console',
	'contact',
	'copyright',
	'daemon',
	'dashboard',
	'demo',
	'dev',
	'dev-null',
	'devops',
	'discord',
	'dmca',
	'dns',
	'do-not-reply',
	'doc',
	'docs',
	'documentation',
	'domains',
	'donotreply',
	'download',
	'downloads',
	'email',
	'epic',
	'epicweb',
	'example',
	'external',
	'facebook',
	'false',
	'faq',
	'feedback',
	'files',
	'ftp',
	'gateway',
	'github',
	'google',
	'group',
	'groups',
	'guest',
	'health',
	'hello',
	'help',
	'help-desk',
	'helpdesk',
	'hostmaster',
	'identity',
	'images',
	'imap',
	'img',
	'info',
	'internal',
	'invoice',
	'isatap',
	'jobs',
	'kent',
	'kentcdodds',
	'kody',
	'kody-ai',
	'kody-app',
	'kody-assistant',
	'kody-bot',
	'kody-hq',
	'kody-jobs',
	'kody-platform',
	'kody-runtime',
	'kodyai',
	'kodyapp',
	'kodyassistant',
	'kodybot',
	'kodyhq',
	'kodyjobs',
	'kodyplatform',
	'kodyruntime',
	'legal',
	'linkedin',
	'local',
	'localhost',
	'login',
	'logout',
	'logs',
	'mail',
	'mailer_daemon',
	'mailer-daemon',
	'mailerdaemon',
	'marketing',
	'mcp',
	'me',
	'media',
	'member',
	'members',
	'meta',
	'metrics',
	'microsoft',
	'mobile',
	'mod',
	'moderator',
	'monitor',
	'monitoring',
	'mta-sts',
	'mx1',
	'mx2',
	'news',
	'no-reply',
	'nobody',
	'noreply',
	'ns1',
	'ns2',
	'ns3',
	'null',
	'oauth',
	'oauth2',
	'official',
	'openai',
	'ops',
	'org',
	'orgs',
	'owner',
	'package',
	'packages',
	'panel',
	'password',
	'passwords',
	'pay',
	'payments',
	'ping',
	'policy',
	'pop',
	'pop3',
	'portal',
	'postmaster',
	'press',
	'preview',
	'privacy',
	'private',
	'prod',
	'production',
	'profile',
	'proxy',
	'psl',
	'public',
	'register',
	'report',
	'reset',
	'root',
	'router',
	'safety',
	'sales',
	'sample',
	'sandbox',
	'security',
	'session',
	'sessions',
	'settings',
	'sftp',
	'signin',
	'signup',
	'slack',
	'smtp',
	'ssh',
	'ssl',
	'sso',
	'staff',
	'stage',
	'staging',
	'static',
	'status',
	'stripe',
	'subscribe',
	'sudo',
	'superuser',
	'support',
	'sys',
	'sysadmin',
	'system',
	'team',
	'teams',
	'terms',
	'test',
	'testing',
	'tls',
	'token',
	'tokens',
	'tos',
	'trademark',
	'true',
	'trust',
	'twitter',
	'undefined',
	'unsubscribe',
	'user',
	'users',
	'verified',
	'verify',
	'void',
	'vpn',
	'web',
	'webhook',
	'webhooks',
	'webmail',
	'webmaster',
	'wpad',
	'www',
	'youtube',
] as const

const reservedUsernames = new Set<string>(builtInReservedUsernameList)

/**
 * Username charset separators already present on reserved tokens or DNS-safe
 * labels. Hyphen is the only claimable separator; underscore appears on a few
 * legacy mailbox locals in this list. Do not add other strip rules.
 *
 * `adminHandleGet` compacts stored handles with this same set. Adding a
 * character here changes both reserved-name checks and that admin lookup.
 */
export const reservedUsernameSeparatorCharacters = ['-', '_'] as const

function reservedUsernameSeparatorPatternSource(
	character: (typeof reservedUsernameSeparatorCharacters)[number],
) {
	switch (character) {
		case '-':
			return '\\-'
		case '_':
			return '_'
		default: {
			const unexpected: never = character
			throw new Error(`Unsupported reserved-username separator: ${unexpected}`)
		}
	}
}

const reservedUsernameSeparators = new RegExp(
	reservedUsernameSeparatorCharacters
		.map((character) => reservedUsernameSeparatorPatternSource(character))
		.join('|'),
	'g',
)

/** Substring match only for compact reserved tokens this long or longer. */
const reservedUsernameSubstringMinLength = 4

/**
 * Platform system-email locals that must never be unreserved. Mirrors
 * `systemEmailLocals` without importing `#worker/email/*` (that graph already
 * imports this module). These also feed built-in substring roots.
 */
export const permanentlyReservedSystemLocals = [
	'kody',
	'support',
	'abuse',
	'dmca',
	'postmaster',
	'security',
	'admin',
	'psl',
] as const

/**
 * Inbound-only system-email alias locals (keys of `systemEmailInboundAliases`)
 * that must never be unreserved. Exact/compact claim only — common words like
 * `team` must not substring-block handles such as `team-one` or `fresh-team`.
 */
export const permanentlyReservedSystemInboundAliasLocals = ['team'] as const

/**
 * Handles the website routes itself. `/@me/...` redirects to the signed-in
 * person's own handle, so `me` can never be claimed or unreserved.
 */
export const permanentlyReservedRouteHandles = ['me'] as const

const permanentlyReservedRouteHandleSet = new Set<string>(
	permanentlyReservedRouteHandles,
)

const permanentlyReservedSystemLocalSet = new Set<string>([
	...permanentlyReservedSystemLocals,
	...permanentlyReservedSystemInboundAliasLocals,
])

/**
 * Built-in denylist tokens that also block compact substrings (brand, system
 * mail, and `kody`-prefixed names). Infrastructure labels such as `user`,
 * `test`, and `help` stay exact/compact-equal only; abuse and impersonation
 * lean on KV-added terms plus operator discretion.
 */
const builtInReservedUsernameSubstringRoots = new Set<string>([
	'kent',
	'kentcdodds',
	...permanentlyReservedSystemLocals,
])

function isBuiltInSubstringEligibleToken(normalizedReserved: string) {
	if (builtInReservedUsernameSubstringRoots.has(normalizedReserved)) {
		return true
	}
	return normalizedReserved.startsWith('kody')
}

function isSubstringEligibleReservedToken(
	normalizedReserved: string,
	kvAdded: ReadonlySet<string>,
) {
	if (kvAdded.has(normalizedReserved)) return true
	if (!reservedUsernames.has(normalizedReserved)) return false
	return isBuiltInSubstringEligibleToken(normalizedReserved)
}

/**
 * Local parts shaped like the legacy inbound reply-token aliases
 * (`kody-r-<hex>`). Reserved so a user can never register a username that
 * collides with that address space.
 */
const reservedUsernamePrefixPattern = /^kody-r-/

export function normalizeReservedUsername(username: string) {
	return username.trim().toLowerCase()
}

/** Lowercase, trim, and strip `reservedUsernameSeparatorCharacters`. */
export function compactReservedUsername(username: string) {
	return normalizeReservedUsername(username).replace(
		reservedUsernameSeparators,
		'',
	)
}

export function isBuiltInReservedUsername(username: string) {
	const normalized = normalizeReservedUsername(username)
	return (
		reservedUsernames.has(normalized) ||
		reservedUsernamePrefixPattern.test(normalized)
	)
}

/**
 * True when `username` may not be newly claimed against `reservedNames`.
 * Existing holders keep their username; this is only for signup, rename,
 * generated usernames, and admin conflict listing.
 *
 * Matching is case-insensitive (lowercase + trim). Hyphens and underscores
 * are stripped before equality checks, including on input that is not a valid
 * stored username. Every effective token blocks exact and compact-equal claims.
 * Substring matching applies only to KV-added tokens and built-in brand/system
 * roots (`kody`, `kent`, permanent system locals, and other `kody`-prefixed
 * built-ins). When substring applies, the compact reserved token must be at
 * least four characters (so KV `ass` does not block `assistant`).
 */
export function usernameCollidesWithReservedNames(
	username: string,
	reservedNames: Iterable<string>,
	options: { added?: Iterable<string> } = {},
) {
	const normalized = normalizeReservedUsername(username)
	if (!normalized) return false
	if (reservedUsernamePrefixPattern.test(normalized)) return true
	const compact = compactReservedUsername(normalized)
	if (!compact) return false
	const kvAdded = toNormalizedSet(options.added)
	for (const reserved of reservedNames) {
		const normalizedReserved = normalizeReservedUsername(reserved)
		if (!normalizedReserved) continue
		if (normalized === normalizedReserved) return true
		const compactReserved = compactReservedUsername(normalizedReserved)
		if (!compactReserved) continue
		if (compact === compactReserved) return true
		if (
			isSubstringEligibleReservedToken(normalizedReserved, kvAdded) &&
			compactReserved.length >= reservedUsernameSubstringMinLength &&
			compact.includes(compactReserved)
		) {
			return true
		}
	}
	return false
}

export function isReservedUsername(username: string) {
	return usernameCollidesWithReservedNames(username, reservedUsernames)
}

export function isPermanentlyReservedUsername(username: string) {
	const normalized = normalizeReservedUsername(username)
	if (permanentlyReservedSystemLocalSet.has(normalized)) {
		return true
	}
	if (permanentlyReservedRouteHandleSet.has(normalized)) return true
	if (reservedUsernamePrefixPattern.test(normalized)) {
		return true
	}
	return reservedUsernames.has(normalized) && normalized.startsWith('kody')
}

export function getReservedUsernameError(username: string) {
	if (isReservedUsername(username)) {
		return 'This username is reserved.'
	}
	return null
}

export function isReservedUsernameToken(
	username: string,
	overrides: {
		added?: Iterable<string>
		removed?: Iterable<string>
	} = {},
) {
	const normalized = normalizeReservedUsername(username)
	if (!normalized) return false
	if (reservedUsernamePrefixPattern.test(normalized)) return true
	return computeEffectiveReservedUsernames(overrides).has(normalized)
}

export function isUsernameEffectivelyReserved(
	username: string,
	overrides: {
		added?: Iterable<string>
		removed?: Iterable<string>
	} = {},
) {
	const normalized = normalizeReservedUsername(username)
	if (!normalized) return false
	if (reservedUsernamePrefixPattern.test(normalized)) return true
	return usernameCollidesWithReservedNames(
		normalized,
		computeEffectiveReservedUsernames(overrides),
		{ added: overrides.added },
	)
}

export function computeEffectiveReservedUsernames(input: {
	added?: Iterable<string>
	removed?: Iterable<string>
}) {
	const removed = toNormalizedSet(input.removed)
	const effective = new Set<string>()
	for (const name of builtInReservedUsernameList) {
		if (isPermanentlyReservedUsername(name) || !removed.has(name)) {
			effective.add(name)
		}
	}
	for (const name of toNormalizedSet(input.added)) {
		if (!removed.has(name) || isPermanentlyReservedUsername(name)) {
			effective.add(name)
		}
	}
	return effective
}

function toNormalizedSet(names: Iterable<string> | undefined) {
	const result = new Set<string>()
	if (!names) return result
	for (const name of names) {
		const normalized = normalizeReservedUsername(name)
		if (normalized) result.add(normalized)
	}
	return result
}
