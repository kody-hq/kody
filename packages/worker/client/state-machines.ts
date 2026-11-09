import { adminCodemodRunState } from './routes/admin-codemod-run-state.ts'
import { avatarCropState } from './routes/avatar-crop-state.ts'
import { clipboardFeedbackState } from './routes/clipboard-feedback-state.ts'
import { connectOauthDeviceState } from './routes/connect-oauth-device-state.ts'
import {
	connectOauthStepState,
	connectOauthOperationState,
} from './routes/connect-oauth-state.ts'
import { desktopSetupOperationState } from './routes/desktop-setup-operation-state.ts'
import { desktopSetupStepState } from '#universal/desktop-setup-step-state.ts'
import { emailVerificationState } from './routes/email-verification-state.ts'
import { landingPointerState } from './routes/landing-pointer-state.ts'
import { loginState } from './routes/login-state.ts'
import { oauthConsentState } from './routes/oauth-consent-state.ts'
import { passkeyCeremonyState } from './routes/passkey-ceremony-state.ts'
import { passwordResetState } from './routes/password-reset-state.ts'
import { publishCommitCheckState } from './routes/publish-commit-check-state.ts'
import { twoFactorVerifyState } from './routes/two-factor-verify-state.ts'
import { undoableActionState } from './routes/undoable-action-state.ts'
import { usernameAvailabilityState } from './routes/username-availability-state.ts'
import { usernameSignupState } from './routes/username-signup-state.ts'
export const stateMachines = [
	{
		machine: adminCodemodRunState,
		file: 'packages/worker/client/routes/admin-codemod-run-state.ts',
	},
	{
		machine: avatarCropState,
		file: 'packages/worker/client/routes/avatar-crop-state.ts',
	},
	{
		machine: clipboardFeedbackState,
		file: 'packages/worker/client/routes/clipboard-feedback-state.ts',
	},
	{
		machine: connectOauthDeviceState,
		file: 'packages/worker/client/routes/connect-oauth-device-state.ts',
	},
	{
		machine: connectOauthStepState,
		file: 'packages/worker/client/routes/connect-oauth-state.ts',
	},
	{
		machine: connectOauthOperationState,
		file: 'packages/worker/client/routes/connect-oauth-state.ts',
	},
	{
		machine: desktopSetupOperationState,
		file: 'packages/worker/client/routes/desktop-setup-operation-state.ts',
	},
	{
		machine: desktopSetupStepState,
		file: 'packages/worker/universal/desktop-setup-step-state.ts',
	},
	{
		machine: emailVerificationState,
		file: 'packages/worker/client/routes/email-verification-state.ts',
	},
	{
		machine: landingPointerState,
		file: 'packages/worker/client/routes/landing-pointer-state.ts',
	},
	{ machine: loginState, file: 'packages/worker/client/routes/login-state.ts' },
	{
		machine: oauthConsentState,
		file: 'packages/worker/client/routes/oauth-consent-state.ts',
	},
	{
		machine: passkeyCeremonyState,
		file: 'packages/worker/client/routes/passkey-ceremony-state.ts',
	},
	{
		machine: passwordResetState,
		file: 'packages/worker/client/routes/password-reset-state.ts',
	},
	{
		machine: publishCommitCheckState,
		file: 'packages/worker/client/routes/publish-commit-check-state.ts',
	},
	{
		machine: twoFactorVerifyState,
		file: 'packages/worker/client/routes/two-factor-verify-state.ts',
	},
	{
		machine: undoableActionState,
		file: 'packages/worker/client/routes/undoable-action-state.ts',
	},
	{
		machine: usernameAvailabilityState,
		file: 'packages/worker/client/routes/username-availability-state.ts',
	},
	{
		machine: usernameSignupState,
		file: 'packages/worker/client/routes/username-signup-state.ts',
	},
] as const
