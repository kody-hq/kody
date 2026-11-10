import { restoreActor } from 'xstate/persist'
import { createActor, type AnyStateMachine, type AnyEventObject } from 'xstate'
import { afterEach, beforeEach, expect, test } from 'vitest'
import assert from 'node:assert/strict'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

import { uiContext, uiState, sendUiEvent } from './ui-actor.ts'
import { loginState } from './routes/login-state.ts'
import { passwordResetState } from './routes/password-reset-state.ts'
import { usernameSignupState } from './routes/username-signup-state.ts'
import { twoFactorVerifyState } from './routes/two-factor-verify-state.ts'
import { oauthConsentState } from './routes/oauth-consent-state.ts'
import { emailVerificationState } from './routes/email-verification-state.ts'
import { passkeyCeremonyState } from './routes/passkey-ceremony-state.ts'
import { avatarCropState } from './routes/avatar-crop-state.ts'
import { usernameAvailabilityState } from './routes/username-availability-state.ts'
import { publishCommitCheckState } from './routes/publish-commit-check-state.ts'
import { connectOauthDeviceState } from './routes/connect-oauth-device-state.ts'
import { adminCodemodRunState } from './routes/admin-codemod-run-state.ts'
import { clipboardFeedbackState } from './routes/clipboard-feedback-state.ts'
import { submissionGateState } from './routes/submission-gate-state.ts'

beforeEach(() => consoleWarn.mockImplementation(() => {}))
afterEach(() => {
	for (const call of consoleWarn.mock.calls) {
		assert.equal(call.length, 1)
		assert.match(
			String(call[0]),
			/^Actor [\w.]+ received event "[A-Z_]+" in state "[a-z_]+" with no matching transition$/,
		)
	}
})
type Probe = {
	name: string
	machine: AnyStateMachine
	prefix?: AnyEventObject[]
	start: AnyEventObject
	reply: AnyEventObject
	target: string
	replaceable?: boolean
}
const controller = new AbortController()
const progress = { runId: null, items: [], summary: {} }
const probes: Probe[] = [
	{
		name: 'login',
		machine: loginState,
		start: { type: 'SUBMIT', data: {} },
		reply: { type: 'RESPONSE_ERROR', data: { message: 'Retry' } },
		target: 'error',
	},
	{
		name: 'reset password',
		machine: passwordResetState,
		start: { type: 'SUBMIT', data: {} },
		reply: { type: 'RESPONSE_OK', data: { message: 'Sent' } },
		target: 'success',
	},
	{
		name: 'signup',
		machine: usernameSignupState,
		prefix: [{ type: 'CONFIRM_USERNAME', data: { message: 'Confirm' } }],
		start: { type: 'SUBMIT', data: {} },
		reply: { type: 'RESPONSE_ERROR', data: { message: 'Retry' } },
		target: 'error',
	},
	{
		name: 'two factor',
		machine: twoFactorVerifyState,
		start: { type: 'SUBMIT', data: {} },
		reply: { type: 'RESPONSE_ERROR', data: { message: 'Retry' } },
		target: 'error',
	},
	{
		name: 'OAuth sign in',
		machine: oauthConsentState,
		start: { type: 'SIGN_IN', data: { controller } },
		reply: {
			type: 'RESPONSE_ERROR',
			data: { message: 'Retry', clientFailure: null },
		},
		target: 'error',
	},
	{
		name: 'OAuth decision',
		machine: oauthConsentState,
		start: { type: 'DECIDE', data: { decision: 'approve', request: {} } },
		reply: { type: 'REDIRECT', data: { decision: 'approve' } },
		target: 'redirecting',
	},
	...(['RESEND', 'CHECK'] as const).map((type) => ({
		name: `verification ${type}`,
		machine: emailVerificationState,
		start: { type, data: {} },
		reply: { type: 'RESPONSE_OK', data: { message: 'Checked' } },
		target: 'success',
	})),
	{
		name: 'passkey',
		machine: passkeyCeremonyState,
		start: { type: 'SUBMIT', data: { controller } },
		reply: { type: 'OPTIONS_OK', data: { controller } },
		target: 'ceremony',
	},
	{
		name: 'avatar decode',
		machine: avatarCropState,
		start: { type: 'DECODE', data: {} },
		reply: {
			type: 'DECODE_OK',
			data: { previewUrl: 'blob:preview', imageSize: { width: 1, height: 1 } },
		},
		target: 'ready',
		replaceable: true,
	},
	{
		name: 'username availability',
		machine: usernameAvailabilityState,
		start: { type: 'CHECK', data: {} },
		reply: {
			type: 'RESPONSE_AVAILABLE',
			data: { username: 'jane', reason: null, suggestions: [] },
		},
		target: 'available',
		replaceable: true,
	},
	{
		name: 'publish commit',
		machine: publishCommitCheckState,
		start: { type: 'CHECK_COMMIT', data: { key: 'pkg:sha' } },
		reply: { type: 'CHECK_PASSED', data: { key: 'pkg:sha' } },
		target: 'passed',
		replaceable: true,
	},
	{
		name: 'device session',
		machine: connectOauthDeviceState,
		start: { type: 'START', data: {} },
		reply: {
			type: 'SESSION_OK',
			data: {
				session: {
					sessionId: 'session',
					userCode: 'CODE',
					verificationUri: 'https://example.com',
					verificationUriComplete: null,
					expiresIn: 60,
					interval: 5,
				},
			},
		},
		target: 'polling',
	},
	{
		name: 'codemod',
		machine: adminCodemodRunState,
		start: { type: 'SUBMIT', data: progress },
		reply: { type: 'RESPONSE_OK', data: { ...progress, message: 'Done' } },
		target: 'complete',
	},
	{
		name: 'clipboard',
		machine: clipboardFeedbackState,
		start: { type: 'COPY', data: {} },
		reply: { type: 'RESPONSE_OK', data: {} },
		target: 'copied',
	},
]

test.each(probes)(
	'$name fences synchronous duplicates or supersedes a draft, and rejects stale responses',
	({ machine, prefix = [], start, reply, target, replaceable }) => {
		const actor = createActor(machine).start()
		for (const event of prefix) actor.send(event)
		actor.send({ ...start, requestId: 1 })
		const pending = actor.getSnapshot()
		actor.send({ ...start, requestId: 2 })
		if (!replaceable) expect(actor.getSnapshot()).toBe(pending)
		const current = actor.getSnapshot()
		actor.send({ ...reply, requestId: 0 })
		expect(actor.getSnapshot()).toBe(current)
		actor.send({ ...reply, requestId: replaceable ? 2 : 1 })
		expect(actor.getSnapshot().value).toBe(target)
		expect(actor.getSnapshot().context.data).not.toHaveProperty('status')
		actor.stop()
	},
)

test('restoring a rendered form snapshot preserves initial feedback and retry clears it atomically', () => {
	const initial = { status: 'error', message: 'Existing feedback' } as const
	const actor = restoreActor(
		loginState,
		loginState.getPersistedSnapshot(
			loginState.resolveState({
				value: initial.status,
				context: uiContext(initial),
			}),
		),
	).start()
	expect(uiState(actor.getSnapshot())).toEqual(initial)
	expect(uiState(actor.getSnapshot())).toBe(uiState(actor.getSnapshot()))
	expect(sendUiEvent(actor, { type: 'SUBMIT', data: {} })).toBe(true)
	expect(uiState(actor.getSnapshot())).toEqual({ status: 'submitting' })
	expect(sendUiEvent(actor, { type: 'SUBMIT', data: {} })).toBe(false)
	actor.stop()
})

test('the mutation gate ignores repeated submissions synchronously and releases after errors or empty work', async () => {
	const actor = createActor(submissionGateState).start()
	for (const error of [false, true]) {
		actor.send({ type: 'SUBMIT' })
		const pending = actor.getSnapshot()
		actor.send({ type: 'SUBMIT' })
		expect(actor.getSnapshot()).toBe(pending)
		try {
			await Promise.resolve()
			if (error) throw new Error('failed')
		} catch (error) {
			expect(error).toEqual(new Error('failed'))
		} finally {
			actor.send({ type: 'SETTLED' })
		}
		expect(actor.getSnapshot().value).toBe('idle')
	}
	actor.stop()
})

test('a device approval remains authoritative after local expiry, but not after reset and restart', () => {
	const actor = createActor(connectOauthDeviceState).start()
	const view = {
		userCode: 'CODE',
		verificationUri: 'https://example.com',
		verificationUriComplete: null,
		expiresIn: 0,
	}
	const session = { ...view, sessionId: 'one', interval: 5 }
	actor.send({ type: 'START', data: {}, requestId: 1 })
	actor.send({ type: 'SESSION_OK', data: { session }, requestId: 1 })
	actor.send({
		type: 'RESPONSE_ERROR',
		data: { message: 'Expired', view },
		requestId: 1,
	})
	actor.send({ type: 'RESPONSE_OK', data: { view }, requestId: 1 })
	expect(actor.getSnapshot().value).toBe('success')
	actor.send({ type: 'RESET', data: {} })
	actor.send({ type: 'START', data: {}, requestId: 2 })
	actor.send({
		type: 'SESSION_OK',
		data: { session: { ...session, sessionId: 'two' } },
		requestId: 2,
	})
	actor.send({ type: 'RESPONSE_OK', data: { view }, requestId: 1 })
	expect(actor.getSnapshot().value).toBe('polling')
	actor.send({ type: 'RESPONSE_OK', data: { view }, requestId: 2 })
	expect(actor.getSnapshot().value).toBe('success')
	actor.stop()
})

test('invalidating a checking username cannot be overwritten by an older response', () => {
	const actor = createActor(usernameAvailabilityState).start()
	actor.send({ type: 'CHECK', data: {}, requestId: 1 })
	actor.send({
		type: 'INVALID_DRAFT',
		data: { username: '?', reason: 'Invalid', suggestions: [] },
	})
	actor.send({
		type: 'RESPONSE_AVAILABLE',
		data: { username: 'old', reason: null, suggestions: [] },
		requestId: 1,
	})
	expect(uiState(actor.getSnapshot())).toEqual({
		status: 'invalid',
		username: '?',
		reason: 'Invalid',
		suggestions: [],
	})
	actor.stop()
})
