import { kodyCallDispatcherName } from '#worker/kody-evaluate-bindings.ts'
import { parseSecretNameOrPlaceholder } from '#mcp/secrets/placeholders.ts'
import {
	assertIntegrationHostAllowed,
	IntegrationHostNotAllowedError,
} from './integration-host-allowlist.ts'

export { IntegrationHostNotAllowedError }

type CapabilityResult = unknown
type SecretScope = 'session' | 'package' | 'user'

export type CapabilityArgs = Record<string, unknown>

export type KodyNamespace = Record<
	string,
	(args: CapabilityArgs) => Promise<CapabilityResult>
>

/** Non-secret config the host returns for `createAuthenticatedFetch`. */
type IntegrationConfig = {
	name: string
	apiBaseUrl?: string | null
	requiredHosts?: Array<string>
}

type IntegrationConfigResult = {
	integration: IntegrationConfig | null
}

/**
 * Host-side, runtime-only config read: the run org's connection by name,
 * else the actor's own personal connection granted to the run org (the
 * set the integration-token gateway resolves). Not a public capability.
 */
export const INTEGRATION_RUNTIME_CONFIG_TOOL_NAME =
	'__kodyIntegrationRuntimeConfig'

export type ExecuteRequestInput = string | URL | Request

export type BasicAuthSecretHeaderInput = {
	usernameSecret: string
	passwordSecret: string
	scope?: SecretScope | null
}

export type OAuthClientCredentialsInput = {
	tokenUrl: string | URL
	clientIdSecret: string
	clientSecretSecret: string
	scope?: SecretScope | null
	authStyle?: 'basic'
	body?: Record<string, string>
	headers?: Record<string, string>
}

export const secretHeaders = {
	basic(input: BasicAuthSecretHeaderInput) {
		const username = parseSecretNameOrPlaceholder(
			input.usernameSecret,
			'usernameSecret',
		)
		const password = parseSecretNameOrPlaceholder(
			input.passwordSecret,
			'passwordSecret',
		)
		return buildBasicAuthSecretPlaceholder({
			usernameSecret: username.name,
			passwordSecret: password.name,
			scope: resolveBasicAuthSecretScope({
				explicitScope: input.scope,
				usernameScope: username.scope,
				passwordScope: password.scope,
			}),
		})
	},
}

export const EXECUTE_HELPER_CAPABILITY_NAMES = [
	INTEGRATION_RUNTIME_CONFIG_TOOL_NAME,
	'integrationTokenRefresh',
] as const

async function refreshIntegrationTokensHostSide(
	kody: KodyNamespace,
	providerName: string,
) {
	const tokenRefresh = kody.integrationTokenRefresh
	if (typeof tokenRefresh !== 'function') {
		throw new Error(
			'kody.integrationTokenRefresh is not available in this sandbox.',
		)
	}
	const result = (await tokenRefresh({ name: providerName })) as {
		ok?: unknown
		refreshed?: unknown
	} | null
	if (result?.ok !== true) {
		throw new Error(
			`Host-side token refresh for integration "${providerName}" did not succeed.`,
		)
	}
	return result.refreshed !== false
}

export async function createAuthenticatedFetch(
	kody: KodyNamespace,
	providerName: string,
	options?: {
		/**
		 * Outbound fetch implementation. Cloud / package-app sandboxes omit this
		 * so ambient `fetch` hits the fetch gateway. CapabilityProxy local
		 * execute passes `executeGatewayFetch` so placeholders expand on origin
		 * and long-lived OAuth tokens never enter local workerd.
		 */
		fetch?: typeof globalThis.fetch
	},
): Promise<
	(input: ExecuteRequestInput, init?: RequestInit) => Promise<Response>
> {
	const integration = await readIntegrationConfig(kody, providerName)
	const doFetch = options?.fetch ?? fetch

	// Both lanes refresh host-side (integrationTokenRefresh) and retry with
	// a placeholder header the gateway resolves to the fresh token, so the
	// raw token never enters the sandbox. The user lane enforces each
	// secret's allowed_hosts against the token URL host-side — the same
	// containment the gateway applied when this refresh ran in-sandbox.
	// Null when the connection has nothing to refresh (non-expiring grant);
	// retrying with the same token would only repeat the failure.
	const retryAuthorizationHeader = async () => {
		const refreshed = await refreshIntegrationTokensHostSide(kody, providerName)
		return refreshed
			? buildAccessTokenAuthorizationHeader(providerName, integration)
			: null
	}

	return async (input: ExecuteRequestInput, init?: RequestInit) => {
		const resolvedUrl = resolveRequestUrl(input, integration)
		assertIntegrationHostAllowed(providerName, integration, resolvedUrl)

		const request = new Request(resolvedUrl, init)
		const retryRequest: Request = request.clone() as Request
		let response: Response
		try {
			response = await doFetch(
				createBearerRequest(
					request,
					buildAccessTokenAuthorizationHeader(providerName, integration),
				),
			)
		} catch (error) {
			if (!isMissingAccessTokenSecretError(error, providerName)) throw error
			const retryAuthorization = await retryAuthorizationHeader()
			if (!retryAuthorization) throw error
			return doFetch(createBearerRequest(retryRequest, retryAuthorization))
		}
		if (!(await responseIndicatesAuthFailure(response, integration))) {
			return response
		}

		const retryAuthorization = await retryAuthorizationHeader()
		if (!retryAuthorization) return response
		await response.body?.cancel()
		return doFetch(createBearerRequest(retryRequest, retryAuthorization))
	}
}

const SLACK_AUTH_ERROR_CODES = new Set([
	'token_expired',
	'token_revoked',
	'invalid_auth',
	'not_authed',
])

function isSlackIntegration(integration: IntegrationConfig) {
	if (integration.name.startsWith('slack')) return true
	const apiBaseUrl = integration.apiBaseUrl ?? ''
	if (hostLooksLikeSlack(apiBaseUrl)) return true
	return (integration.requiredHosts ?? []).some((host) =>
		hostLooksLikeSlack(host),
	)
}

function hostLooksLikeSlack(value: string) {
	const lower = value.toLowerCase()
	return lower.includes('slack.com') || lower.includes('files.slack.com')
}

/**
 * Detect auth failures that should trigger host-side refresh+retry.
 * Always treats HTTP 401 as auth failure. For Slack integrations, also
 * treats Web API `{ok:false}` auth error codes and files.slack.com HTML
 * login redirects (dead token) as auth failures. Clones before reading
 * JSON so non-auth ok:false bodies stay intact on the original response.
 */
async function responseIndicatesAuthFailure(
	response: Response,
	integration: IntegrationConfig,
) {
	if (response.status === 401) return true
	if (!isSlackIntegration(integration)) return false

	const contentType = response.headers.get('content-type') ?? ''
	if (isSlackFilesHtmlLoginResponse(response, contentType)) return true

	if (!contentType.toLowerCase().includes('application/json')) return false
	try {
		const body = (await response.clone().json()) as unknown
		if (!body || typeof body !== 'object' || Array.isArray(body)) return false
		const record = body as { ok?: unknown; error?: unknown }
		return (
			record.ok === false &&
			typeof record.error === 'string' &&
			SLACK_AUTH_ERROR_CODES.has(record.error)
		)
	} catch {
		return false
	}
}

function isSlackFilesHtmlLoginResponse(
	response: Response,
	contentType: string,
) {
	if (!contentType.toLowerCase().includes('text/html')) return false
	try {
		return new URL(response.url).hostname === 'files.slack.com'
	} catch {
		return false
	}
}

export async function oauthClientCredentials(
	input: OAuthClientCredentialsInput,
	options?: {
		/**
		 * Outbound fetch implementation. Cloud / package-app sandboxes omit this
		 * so ambient `fetch` hits the fetch gateway. CapabilityProxy local
		 * execute passes `executeGatewayFetch` so secret placeholders expand on
		 * origin and secret values never enter local workerd.
		 */
		fetch?: typeof globalThis.fetch
	},
): Promise<Record<string, unknown>> {
	const authStyle = (input.authStyle ?? 'basic') as string
	if (authStyle !== 'basic') {
		throw new Error(
			`Unsupported OAuth client_credentials authStyle "${authStyle}".`,
		)
	}
	const body = new URLSearchParams(input.body ?? {})
	body.set('grant_type', 'client_credentials')
	const headers = new Headers(input.headers)
	if (!headers.has('Accept')) {
		headers.set('Accept', 'application/json')
	}
	headers.set('Content-Type', 'application/x-www-form-urlencoded')
	headers.set(
		'Authorization',
		secretHeaders.basic({
			usernameSecret: input.clientIdSecret,
			passwordSecret: input.clientSecretSecret,
			scope: input.scope,
		}),
	)
	const doFetch = options?.fetch ?? fetch
	const response = await doFetch(input.tokenUrl, {
		method: 'POST',
		headers,
		body: body.toString(),
	})
	const payload = (await response.json()) as unknown
	if (!response.ok) {
		throw new Error(
			`OAuth client_credentials request failed with HTTP ${response.status}.`,
		)
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error('OAuth client_credentials response was not a JSON object.')
	}
	// The fetch gateway sealed access_token and refresh_token (ADR 0068).
	return payload as Record<string, unknown>
}

async function readIntegrationConfig(
	kody: KodyNamespace,
	providerName: string,
) {
	const readConfig = kody[INTEGRATION_RUNTIME_CONFIG_TOOL_NAME]
	if (typeof readConfig !== 'function') {
		throw new Error(
			'createAuthenticatedFetch is not available in this sandbox.',
		)
	}
	const result = (await readConfig({
		name: providerName,
	})) as IntegrationConfigResult
	const integration = result?.integration ?? null
	if (!integration) {
		throw new Error(`Integration "${providerName}" was not found.`)
	}
	return integration
}

function buildAccessTokenAuthorizationHeader(
	providerName: string,
	_integration: IntegrationConfig,
) {
	const name = providerName.trim()
	if (!name) {
		throw new Error('Integration name is required.')
	}
	return `Bearer {{integration-token:${name}}}`
}

function createBearerRequest(request: Request, authorization: string) {
	const headers = new Headers(request.headers)
	headers.set('Authorization', authorization)
	return new Request(request, { headers })
}

function isMissingAccessTokenSecretError(error: unknown, providerName: string) {
	return (
		error instanceof Error &&
		error.message ===
			`Integration "${providerName}" does not have a stored access token.`
	)
}

function buildBasicAuthSecretPlaceholder(input: {
	usernameSecret: string
	passwordSecret: string
	scope?: SecretScope | null
}) {
	return input.scope
		? `{{secret-basic:username=${input.usernameSecret},password=${input.passwordSecret}|scope=${input.scope}}}`
		: `{{secret-basic:username=${input.usernameSecret},password=${input.passwordSecret}}}`
}

function normalizeOptionalSecretScope(scope: SecretScope | null | undefined) {
	if (scope == null) return null
	if (scope === 'package' || scope === 'session' || scope === 'user')
		return scope
	throw new Error(`Unsupported secret scope "${scope}".`)
}

function resolveBasicAuthSecretScope(input: {
	explicitScope: SecretScope | null | undefined
	usernameScope: SecretScope | null
	passwordScope: SecretScope | null
}) {
	const explicit = normalizeOptionalSecretScope(input.explicitScope)
	if (explicit != null) return explicit
	const { usernameScope, passwordScope } = input
	if (usernameScope == null) return passwordScope
	if (passwordScope == null) return usernameScope
	if (usernameScope !== passwordScope) {
		throw new Error(
			'usernameSecret and passwordSecret opaque refs disagree on scope. Pass scope explicitly or use matching refs.',
		)
	}
	return usernameScope
}

function resolveRequestUrl(
	input: ExecuteRequestInput,
	integration: IntegrationConfig,
) {
	if (typeof input === 'string' && input.startsWith('/')) {
		return resolveRelativeUrl(input, integration)
	}
	if (input instanceof URL) return input
	if (typeof input === 'string') return input
	if (input instanceof Request) {
		const relativePath = getRelativePathFromRequest(input, integration)
		if (relativePath) {
			return new Request(resolveRelativeUrl(relativePath, integration), input)
		}
	}
	return input
}

function getRelativePathFromRequest(
	input: Request,
	integration: IntegrationConfig,
): string | null {
	const requestUrl = new URL(input.url)
	const normalizedBase = getNormalizedApiBaseUrl(integration)
	if (normalizedBase && requestUrl.href.startsWith(normalizedBase)) {
		return null
	}
	const runtimeOrigin = getRuntimeOrigin()
	if (!runtimeOrigin || requestUrl.origin !== runtimeOrigin) {
		return null
	}
	return `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`
}

function getRuntimeOrigin() {
	const runtimeLocation = (
		globalThis as typeof globalThis & {
			location?: { origin?: string | null }
		}
	).location
	const origin = runtimeLocation?.origin ?? null
	return typeof origin === 'string' && origin.length > 0 ? origin : null
}

function getNormalizedApiBaseUrl(integration: IntegrationConfig) {
	if (!integration.apiBaseUrl) return null
	return integration.apiBaseUrl.endsWith('/')
		? integration.apiBaseUrl.slice(0, -1)
		: integration.apiBaseUrl
}

function resolveRelativeUrl(pathname: string, integration: IntegrationConfig) {
	const normalizedBase = getNormalizedApiBaseUrl(integration)
	if (!normalizedBase) {
		throw new Error(
			`Integration "${integration.name}" does not define apiBaseUrl for relative requests.`,
		)
	}
	return new URL(`${normalizedBase}${pathname}`)
}

export function getExecuteHelperCapabilityNames() {
	return [...EXECUTE_HELPER_CAPABILITY_NAMES]
}

export function createExecuteHelperPrelude() {
	return `
class IntegrationHostNotAllowedError extends Error {
  constructor(integrationName, disallowedHost) {
    super(
      \`Integration "\${integrationName}" does not allow requests to host "\${disallowedHost}". \` +
        \`The host must be listed in the integration's requiredHosts or match its apiBaseUrl.\`
    );
    this.name = 'IntegrationHostNotAllowedError';
    this.integrationName = integrationName;
    this.disallowedHost = disallowedHost;
  }
}
const __kodyGetIntegrationAllowedHosts = (integration) => {
  const hosts = new Set();
  if (integration.requiredHosts) {
    for (const host of integration.requiredHosts) {
      const normalized = host.trim().toLowerCase();
      if (normalized) hosts.add(normalized);
    }
  }
  if (integration.apiBaseUrl) {
    const apiHost = new URL(integration.apiBaseUrl).hostname.trim().toLowerCase();
    if (apiHost) hosts.add(apiHost);
  }
  return Array.from(hosts);
};
const __kodyAssertIntegrationHostAllowed = (integrationName, integration, url) => {
  let resolvedUrl;
  if (typeof url === 'string') {
    if (url.startsWith('//')) {
      resolvedUrl = \`https:\${url}\`;
    } else if (url.startsWith('/')) {
      return;
    } else {
      resolvedUrl = url;
    }
  } else if (url instanceof URL) {
    resolvedUrl = url.href;
  } else if (url instanceof Request) {
    resolvedUrl = url.url;
  } else {
    return;
  }
  let requestHost;
  try {
    requestHost = new URL(resolvedUrl).hostname.trim().toLowerCase();
  } catch {
    return;
  }
  if (!requestHost) return;
  const allowedHosts = __kodyGetIntegrationAllowedHosts(integration);
  if (allowedHosts.length === 0) {
    throw new Error(
      \`Integration "\${integrationName}" has no allowed hosts configured (requiredHosts and apiBaseUrl are both empty). \` +
        \`Cannot attach credentials without a host allowlist.\`
    );
  }
  if (!allowedHosts.includes(requestHost)) {
    throw new IntegrationHostNotAllowedError(integrationName, requestHost);
  }
};
const __kodyBuildAccessTokenAuthorizationHeader = (providerName, _integration) => {
  const name = String(providerName ?? '').trim();
  if (!name) {
    throw new Error('Integration name is required.');
  }
  return \`Bearer {{integration-token:\${name}}}\`;
};
const __kodyCreateBearerRequest = (request, authorization) => {
  const headers = new Headers(request.headers);
  headers.set('Authorization', authorization);
  return new Request(request, { headers });
};
const __kodyIsMissingAccessTokenSecretError = (error, providerName) => {
  return (
    error instanceof Error &&
    error.message ===
      \`Integration "\${providerName}" does not have a stored access token.\`
  );
};
const __kodyParseSecretNameOrPlaceholder = (value, fieldName) => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new Error(
      \`\${fieldName} is required.\`,
    );
  }
  if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
    const match = /^\\{\\{secret:([a-zA-Z0-9._-]+)(?:\\|scope=(session|package|user))?\\}}$/.exec(trimmed);
    if (!match) {
      throw new Error(
        \`\${fieldName} must be a saved secret name or a single {{secret:…}} opaque ref.\`,
      );
    }
    const scope = match[2];
    return {
      name: match[1],
      scope:
        scope === 'package' || scope === 'session' || scope === 'user'
          ? scope
          : null,
    };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      \`\${fieldName} must be a saved secret name using letters, numbers, dots, underscores, or hyphens, or a single {{secret:…}} opaque ref.\`,
    );
  }
  return { name: trimmed, scope: null };
};
const __kodyNormalizeOptionalSecretScope = (scope) => {
  if (scope == null) return null;
  if (scope === 'package' || scope === 'session' || scope === 'user') return scope;
  throw new Error(\`Unsupported secret scope "\${scope}".\`);
};
const __kodyResolveBasicAuthSecretScope = (input) => {
  const explicit = __kodyNormalizeOptionalSecretScope(input.explicitScope);
  if (explicit != null) return explicit;
  const usernameScope = input.usernameScope;
  const passwordScope = input.passwordScope;
  if (usernameScope == null) return passwordScope;
  if (passwordScope == null) return usernameScope;
  if (usernameScope !== passwordScope) {
    throw new Error(
      'usernameSecret and passwordSecret opaque refs disagree on scope. Pass scope explicitly or use matching refs.',
    );
  }
  return usernameScope;
};
const __kodyBuildBasicAuthSecretPlaceholder = (input) => {
  const username = __kodyParseSecretNameOrPlaceholder(input.usernameSecret, 'usernameSecret');
  const password = __kodyParseSecretNameOrPlaceholder(input.passwordSecret, 'passwordSecret');
  const scope = __kodyResolveBasicAuthSecretScope({
    explicitScope: input.scope,
    usernameScope: username.scope,
    passwordScope: password.scope,
  });
  return scope
    ? \`{{secret-basic:username=\${username.name},password=\${password.name}|scope=\${scope}}}\`
    : \`{{secret-basic:username=\${username.name},password=\${password.name}}}\`;
};
const secretHeaders = {
  basic(input) {
    return __kodyBuildBasicAuthSecretPlaceholder(input);
  },
};
const __kodyReadIntegrationConfig = async (providerName) => {
  const result = await ${kodyCallDispatcherName}(${JSON.stringify(INTEGRATION_RUNTIME_CONFIG_TOOL_NAME)}, { name: providerName });
  const integration = result?.integration ?? null;
  if (!integration) {
    throw new Error(\`Integration "\${providerName}" was not found.\`);
  }
  return integration;
};
const __kodyGetNormalizedApiBaseUrl = (integration) => {
  if (!integration.apiBaseUrl) return null;
  return integration.apiBaseUrl.endsWith('/')
    ? integration.apiBaseUrl.slice(0, -1)
    : integration.apiBaseUrl;
};
const __kodyGetRuntimeOrigin = () => {
  const origin = globalThis.location?.origin ?? null;
  return typeof origin === 'string' && origin.length > 0 ? origin : null;
};
const __kodyResolveRelativeUrl = (pathname, integration) => {
  const normalizedBase = __kodyGetNormalizedApiBaseUrl(integration);
  if (!normalizedBase) {
    throw new Error(
      \`Integration "\${integration.name}" does not define apiBaseUrl for relative requests.\`,
    );
  }
  return new URL(\`\${normalizedBase}\${pathname}\`);
};
const __kodyGetRelativePathFromRequest = (input, integration) => {
  const requestUrl = new URL(input.url);
  const normalizedBase = __kodyGetNormalizedApiBaseUrl(integration);
  if (normalizedBase && requestUrl.href.startsWith(normalizedBase)) {
    return null;
  }
  const runtimeOrigin = __kodyGetRuntimeOrigin();
  if (!runtimeOrigin || requestUrl.origin !== runtimeOrigin) {
    return null;
  }
  return \`\${requestUrl.pathname}\${requestUrl.search}\${requestUrl.hash}\`;
};
const __kodyResolveRequestUrl = (input, integration) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    return __kodyResolveRelativeUrl(input, integration);
  }
  if (input instanceof URL) return input;
  if (typeof input === 'string') return input;
  if (input instanceof Request) {
    const relativePath = __kodyGetRelativePathFromRequest(input, integration);
    if (relativePath) {
      return new Request(__kodyResolveRelativeUrl(relativePath, integration), input);
    }
  }
  return input;
};
const __kodyRefreshIntegrationTokensHostSide = async (providerName) => {
  const result = await ${kodyCallDispatcherName}('integrationTokenRefresh', { name: providerName });
  if (result?.ok !== true) {
    throw new Error(
      \`Host-side token refresh for integration "\${providerName}" did not succeed.\`,
    );
  }
  return result.refreshed !== false;
};
const __kodyCreateAuthenticatedFetch = async (providerName) => {
  const integration = await __kodyReadIntegrationConfig(providerName);
  // Both lanes refresh host-side and retry with a placeholder header the
  // gateway resolves to the fresh token, so the raw token never enters the
  // sandbox.
  const retryAuthorizationHeader = async () => {
    const refreshed = await __kodyRefreshIntegrationTokensHostSide(providerName);
    return refreshed
      ? __kodyBuildAccessTokenAuthorizationHeader(providerName, integration)
      : null;
  };
  return async (input, init) => {
    const resolvedUrl = __kodyResolveRequestUrl(input, integration);
    __kodyAssertIntegrationHostAllowed(providerName, integration, resolvedUrl);
    const request = new Request(resolvedUrl, init);
    const retryRequest = request.clone();
    let response;
    try {
      response = await fetch(
        __kodyCreateBearerRequest(
          request,
          __kodyBuildAccessTokenAuthorizationHeader(providerName, integration),
        ),
      );
    } catch (error) {
      if (!__kodyIsMissingAccessTokenSecretError(error, providerName)) throw error;
      const retryAuthorization = await retryAuthorizationHeader();
      if (!retryAuthorization) throw error;
      return fetch(__kodyCreateBearerRequest(retryRequest, retryAuthorization));
    }
    if (!(await __kodyResponseIndicatesAuthFailure(response, integration))) {
      return response;
    }
    const retryAuthorization = await retryAuthorizationHeader();
    if (!retryAuthorization) return response;
    await response.body?.cancel();
    return fetch(__kodyCreateBearerRequest(retryRequest, retryAuthorization));
  };
};
const __kodySlackAuthErrorCodes = new Set([
  'token_expired',
  'token_revoked',
  'invalid_auth',
  'not_authed',
]);
const __kodyHostLooksLikeSlack = (value) => {
  const lower = String(value ?? '').toLowerCase();
  return lower.includes('slack.com') || lower.includes('files.slack.com');
};
const __kodyIsSlackIntegration = (integration) => {
  if (String(integration?.name ?? '').startsWith('slack')) return true;
  if (__kodyHostLooksLikeSlack(integration?.apiBaseUrl ?? '')) return true;
  return (integration?.requiredHosts ?? []).some((host) =>
    __kodyHostLooksLikeSlack(host),
  );
};
const __kodyIsSlackFilesHtmlLoginResponse = (response, contentType) => {
  if (!String(contentType).toLowerCase().includes('text/html')) return false;
  try {
    return new URL(response.url).hostname === 'files.slack.com';
  } catch {
    return false;
  }
};
const __kodyResponseIndicatesAuthFailure = async (response, integration) => {
  if (response.status === 401) return true;
  if (!__kodyIsSlackIntegration(integration)) return false;
  const contentType = response.headers.get('content-type') ?? '';
  if (__kodyIsSlackFilesHtmlLoginResponse(response, contentType)) return true;
  if (!contentType.toLowerCase().includes('application/json')) return false;
  try {
    const body = await response.clone().json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    return (
      body.ok === false &&
      typeof body.error === 'string' &&
      __kodySlackAuthErrorCodes.has(body.error)
    );
  } catch {
    return false;
  }
};
const __kodyOauthClientCredentials = async (input) => {
  const authStyle = input.authStyle ?? 'basic';
  if (authStyle !== 'basic') {
    throw new Error(\`Unsupported OAuth client_credentials authStyle "\${authStyle}".\`);
  }
  const body = new URLSearchParams(input.body ?? {});
  body.set('grant_type', 'client_credentials');
  const headers = new Headers(input.headers);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  headers.set('Content-Type', 'application/x-www-form-urlencoded');
  headers.set(
    'Authorization',
    secretHeaders.basic({
      usernameSecret: input.clientIdSecret,
      passwordSecret: input.clientSecretSecret,
      scope: input.scope,
    }),
  );
  const response = await fetch(input.tokenUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      \`OAuth client_credentials request failed with HTTP \${response.status}.\`,
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('OAuth client_credentials response was not a JSON object.');
  }
  // The fetch gateway sealed access_token and refresh_token (ADR 0068).
  return payload;
};
const createAuthenticatedFetch = async (providerName) =>
  __kodyCreateAuthenticatedFetch(providerName);
const oauthClientCredentials = async (input) =>
  __kodyOauthClientCredentials(input);
`.trim()
}
