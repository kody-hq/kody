import { expect, test } from 'vitest'
import {
	cliFailureText,
	isRetryableExecutionContextCliFailure,
	shouldRetryExecutionContextCli,
} from './retry.ts'

test('retries the windows-latest context register fetch-failed envelope', () => {
	const windowsRegisterLog = [
		'Error: Command failed: C:\\hostedtoolcache\\windows\\node\\26.13.0\\x64\\node.exe D:\\a\\kody\\kody\\packages\\cli\\dist\\bin.js context register --name e2e-win32-x64-41872749631 --json --no-install',
		'{"error":true,"message":"fetch failed"}',
	].join('\n')
	expect(isRetryableExecutionContextCliFailure(windowsRegisterLog)).toBe(true)
	expect(
		isRetryableExecutionContextCliFailure(
			'Could not reach the Kody API at https://kody-pr-4871-api.kody-a99.workers.dev (fetch failed: ECONNREFUSED). The request was not sent.',
		),
	).toBe(true)
})

test('does not retry experiment-off, scope, or host-folder assertion failures', () => {
	expect(
		isRetryableExecutionContextCliFailure(
			'Execution contexts are an experiment that is off for this account.',
		),
	).toBe(false)
	expect(
		isRetryableExecutionContextCliFailure(
			'This credential lacks org:execution_context:register.',
		),
	).toBe(false)
	expect(
		isRetryableExecutionContextCliFailure(
			'The run did not return the host folder read.',
		),
	).toBe(false)
})

test('shouldRetryExecutionContextCli reads execFileSync stdout', () => {
	const error = Object.assign(
		new Error('Command failed: kody context register'),
		{
			stdout: '{"error":true,"message":"fetch failed"}\n',
			stderr: null,
		},
	)
	expect(cliFailureText(error)).toContain('fetch failed')
	expect(shouldRetryExecutionContextCli(error, ['context', 'register'])).toBe(
		true,
	)
	expect(shouldRetryExecutionContextCli(error, ['execute'])).toBe(false)
	expect(
		shouldRetryExecutionContextCli(new Error('The daemon never came online.')),
	).toBe(false)
})
