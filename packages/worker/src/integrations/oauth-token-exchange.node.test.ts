import { expect, test } from 'vitest'
import {
	buildOAuthTokenExchangeFailurePayload,
	buildOAuthTokenExchangeRequest,
	isOAuthTokenExchangeSoftFailure,
	normalizeOAuthTokenExchangePayload,
	oauthTokenExchangeFailureHttpStatus,
	resolveTokenExchangeStyle,
} from './oauth-token-exchange.ts'

const redirectUri = 'https://example.com/connect/oauth'
const basicFormError =
	'basic-form token exchange requires confidential flow with a client secret.'

function build(
	params: Record<string, string>,
	{
		flow = 'confidential',
		clientSecret = 'client-secret',
		style,
	}: {
		flow?: 'confidential' | 'pkce'
		clientSecret?: string | null
		style: 'form' | 'basic-json' | 'basic-form'
	},
) {
	return buildOAuthTokenExchangeRequest({
		params: new URLSearchParams({
			grant_type: 'authorization_code',
			...params,
		}),
		flow,
		clientSecret,
		style,
	})
}

test('token exchange style resolves Notion basic-json, Canva basic-form, and explicit overrides', () => {
	const notion = 'https://api.notion.com/v1/oauth/token'
	const canva = 'https://api.canva.com/rest/v1/oauth/token'
	const styleCases = [
		{ tokenUrl: notion, expected: 'basic-json' },
		{ tokenUrl: 'https://slack.com/api/oauth.v2.access', expected: 'form' },
		{ tokenUrl: notion, tokenExchangeStyle: 'form' as const, expected: 'form' },
		{ tokenUrl: canva, expected: 'basic-form' },
		{ tokenUrl: canva, tokenExchangeStyle: 'form' as const, expected: 'form' },
	]
	expect(
		styleCases.filter(
			({ expected, ...input }) => resolveTokenExchangeStyle(input) !== expected,
		),
	).toEqual([])
})

test('token exchange builds basic-json and form request shapes and the failure payload', () => {
	const codeParams = {
		client_id: 'client-id',
		code: 'code',
		redirect_uri: redirectUri,
	}
	const notionRequest = build(codeParams, { style: 'basic-json' })
	expect(notionRequest.headers).toEqual({
		Accept: 'application/json',
		'Content-Type': 'application/json',
		Authorization: `Basic ${btoa('client-id:client-secret')}`,
	})
	expect(JSON.parse(notionRequest.body)).toEqual({
		grant_type: 'authorization_code',
		code: 'code',
		redirect_uri: redirectUri,
	})

	const formRequest = build(codeParams, { style: 'form' })
	expect(formRequest.headers).toEqual({
		Accept: 'application/json',
		'Content-Type': 'application/x-www-form-urlencoded',
	})
	expect(new URLSearchParams(formRequest.body).get('client_secret')).toBe(
		'client-secret',
	)

	const formPkceBody = new URLSearchParams(
		build({ ...codeParams, code_verifier: 'pkce-verifier' }, { style: 'form' })
			.body,
	)
	expect(formPkceBody.get('client_secret')).toBe('client-secret')
	expect(formPkceBody.get('code_verifier')).toBe('pkce-verifier')

	expect(
		buildOAuthTokenExchangeFailurePayload({
			providerStatus: 401,
			payload: {
				error: 'invalid_client',
				error_description: 'Client authentication failed',
			},
		}),
	).toEqual({
		ok: false,
		error:
			'Token exchange failed: invalid_client (Client authentication failed)',
		providerError: 'invalid_client',
		error_description: 'Client authentication failed',
		providerStatus: 401,
	})
	expect(
		buildOAuthTokenExchangeFailurePayload({
			providerStatus: 200,
			payload: { error: 'bad_verification_code' },
		}).error,
	).toBe('Token exchange failed: bad_verification_code')
	expect(
		buildOAuthTokenExchangeFailurePayload({
			providerStatus: 429,
			payload: null,
		}),
	).toEqual({
		ok: false,
		error:
			'Token exchange failed: the provider returned HTTP 429 with a response that was not JSON',
		providerStatus: 429,
	})
	expect(
		buildOAuthTokenExchangeFailurePayload({
			providerStatus: 422,
			payload: { message: 'Validation Failed' },
		}).error,
	).toBe(
		'Token exchange failed: the provider returned HTTP 422 with no error reason',
	)
	expect(
		buildOAuthTokenExchangeFailurePayload({
			providerStatus: 400,
			payload: { error: 'invalid_grant', error_description: 'x'.repeat(900) },
		}).error_description,
	).toHaveLength(300)
	expect(oauthTokenExchangeFailureHttpStatus()).toBe(502)
})

test('basic-form keeps PKCE code_verifier alongside Basic client auth and requires a confidential client', () => {
	const canvaRequest = build(
		{
			client_id: 'canva-client-id',
			client_secret: 'stale-body-secret',
			code: 'canva-code',
			redirect_uri: redirectUri,
			code_verifier: 'pkce-verifier',
		},
		{ clientSecret: 'canva-client-secret', style: 'basic-form' },
	)
	expect(canvaRequest.headers).toEqual({
		Accept: 'application/json',
		'Content-Type': 'application/x-www-form-urlencoded',
		Authorization: `Basic ${btoa('canva-client-id:canva-client-secret')}`,
	})
	const canvaBody = new URLSearchParams(canvaRequest.body)
	expect(canvaBody.get('grant_type')).toBe('authorization_code')
	expect(canvaBody.get('code')).toBe('canva-code')
	expect(canvaBody.get('code_verifier')).toBe('pkce-verifier')
	expect(canvaBody.get('client_id')).toBeNull()
	expect(canvaBody.get('client_secret')).toBeNull()

	expect(
		build(
			{ client_id: 'client:id', code: 'canva-code' },
			{ clientSecret: 'secret%value', style: 'basic-form' },
		).headers.Authorization,
	).toBe(`Basic ${btoa('client%3Aid:secret%25value')}`)

	const canvaParams = { client_id: 'canva-client-id', code: 'canva-code' }
	expect(() =>
		build(canvaParams, {
			flow: 'pkce',
			clientSecret: 'canva-client-secret',
			style: 'basic-form',
		}),
	).toThrow(basicFormError)
	expect(() =>
		build(canvaParams, { clientSecret: null, style: 'basic-form' }),
	).toThrow(basicFormError)
	expect(() =>
		build(
			{ code: 'canva-code' },
			{ clientSecret: 'canva-client-secret', style: 'basic-form' },
		),
	).toThrow('basic-form token exchange requires client_id in params.')
})

test('normalizeOAuthTokenExchangePayload hoists Slack authed_user tokens and detects ok:false soft failures', () => {
	const userOnly = normalizeOAuthTokenExchangePayload({
		ok: true,
		app_id: 'A0123',
		authed_user: {
			id: 'U0123',
			scope: 'channels:history,chat:write',
			access_token: 'xoxp-user-token',
			token_type: 'user',
		},
		team: { id: 'T0123', name: 'Acme' },
	})
	expect(userOnly.access_token).toBe('xoxp-user-token')
	expect(userOnly.token_type).toBe('user')
	expect(userOnly.scope).toBe('channels:history,chat:write')
	expect(userOnly.authed_user).toMatchObject({ id: 'U0123' })

	const botAndUser = normalizeOAuthTokenExchangePayload({
		ok: true,
		access_token: 'xoxb-bot-token',
		token_type: 'bot',
		authed_user: { id: 'U0123', access_token: 'xoxp-user-token' },
	})
	expect(botAndUser.access_token).toBe('xoxb-bot-token')
	expect(botAndUser.token_type).toBe('bot')

	const standard = { access_token: 'token', refresh_token: 'refresh' }
	expect(normalizeOAuthTokenExchangePayload(standard)).toBe(standard)
	const noToken = { error: 'invalid_grant' }
	expect(normalizeOAuthTokenExchangePayload(noToken)).toBe(noToken)

	expect(
		isOAuthTokenExchangeSoftFailure({ ok: false, error: 'invalid_code' }),
	).toBe(true)
	expect(
		isOAuthTokenExchangeSoftFailure({ ok: true, access_token: 'xoxp-token' }),
	).toBe(false)
	expect(isOAuthTokenExchangeSoftFailure({ access_token: 'token' })).toBe(false)
	// GitHub answers a refused exchange with HTTP 200 and an OAuth error body.
	expect(
		isOAuthTokenExchangeSoftFailure({
			error: 'incorrect_client_credentials',
			error_description:
				'The client_id and/or client_secret passed are incorrect.',
		}),
	).toBe(true)
	expect(
		isOAuthTokenExchangeSoftFailure({
			error: 'partial',
			authed_user: { access_token: 'xoxp-user-token' },
		}),
	).toBe(false)
})
