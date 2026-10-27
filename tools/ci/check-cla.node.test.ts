import { expect, test } from 'vitest'

import {
	applyIndividualClaSigningComment,
	applyIndividualClaSigningComments,
	checkClaIdentities,
	formatClaFailure,
	individualClaSigningPhrase,
	isIndividualClaSigningComment,
	parseClaSignersFile,
	serializeClaSignersFile,
	type ClaSignersFile,
} from './check-cla.ts'

function signersFile(overrides: Partial<ClaSignersFile> = {}): ClaSignersFile {
	return {
		version: 1,
		document: 'docs/legal/individual-cla.md',
		allowlist: {
			github: ['kentcdodds', 'kody-bot', 'cursoragent'],
			email: ['me@kentcdodds.com', 'me+github@kentcdodds.com'],
		},
		signers: [],
		...overrides,
	}
}

test('CLA check allowlists the Licensor, bots, signed humans, and rejects everyone else', () => {
	const file = signersFile({
		signers: [
			{ github: 'ExampleSigner', signedAt: '2026-08-16', cla: 'individual' },
		],
	})

	const identity = (
		githubLogin: string | null,
		name: string,
		email: string | null = null,
	) => ({ githubLogin, name, email })

	expect(
		checkClaIdentities(
			[
				identity('kentcdodds', 'Kent'),
				identity('kody-bot', 'Kody'),
				identity('cursoragent', 'Cursor Agent', 'cursoragent@cursor.com'),
				identity('cursor[bot]', 'cursor[bot]'),
				identity('app/imgbot', 'ImgBot'),
				identity(null, 'Kent C. Dodds', 'me+github@kentcdodds.com'),
				identity('examplesigner', 'Example Signer', 'signer@example.com'),
			],
			file,
		),
	).toEqual({ ok: true })

	const failing = checkClaIdentities(
		[
			identity('kentcdodds', 'Kent'),
			identity('mirkosalvato1-ctrl', 'Mirko', 'mirkosalvato1@gmail.com'),
			identity(null, 'Someone', 'someone@example.com'),
		],
		file,
	)
	expect(failing.ok).toBe(false)
	if (failing.ok) {
		throw new Error('expected missing signatures')
	}
	expect(failing.missing.map((entry) => entry.reason)).toEqual([
		'@mirkosalvato1-ctrl has not signed the CLA',
		'someone@example.com has no GitHub login and is not a Licensor email',
	])
	expect(formatClaFailure(failing)).toContain(individualClaSigningPhrase)
	expect(formatClaFailure(failing)).toContain(
		'That signing comment on the pull request satisfies this check.',
	)
	expect(formatClaFailure(failing)).toContain(
		'The signer is recorded on the cla-signatures branch after the pull request merges.',
	)
})

test('CLA signing comment records the commenter once and ignores everything else', () => {
	const empty = signersFile()
	expect(
		isIndividualClaSigningComment(`  ${individualClaSigningPhrase}  `),
	).toBe(true)
	expect(isIndividualClaSigningComment('I agree')).toBe(false)

	const ignored = applyIndividualClaSigningComment({
		file: empty,
		github: 'ExampleSigner',
		signedAt: '2026-08-16',
		comment: 'I agree',
	})
	expect(ignored).toEqual({
		file: empty,
		status: 'ignored',
		reason: 'not_signing_comment',
	})

	const recorded = applyIndividualClaSigningComment({
		file: empty,
		github: 'ExampleSigner',
		signedAt: '2026-08-16',
		comment: individualClaSigningPhrase,
	})
	expect(recorded.status).toBe('recorded')
	if (recorded.status !== 'recorded') {
		throw new Error('expected a new signature')
	}
	expect(recorded.github).toBe('ExampleSigner')
	expect(recorded.file.signers).toEqual([
		{
			github: 'ExampleSigner',
			signedAt: '2026-08-16',
			cla: 'individual',
		},
	])
	expect(
		checkClaIdentities(
			[{ githubLogin: 'examplesigner', name: 'Example', email: null }],
			recorded.file,
		),
	).toEqual({ ok: true })

	const again = applyIndividualClaSigningComment({
		file: recorded.file,
		github: 'examplesigner',
		signedAt: '2026-08-17',
		comment: individualClaSigningPhrase,
	})
	expect(again).toEqual({
		file: recorded.file,
		status: 'already_signed',
		github: 'examplesigner',
	})
	const serialized = serializeClaSignersFile(recorded.file)
	expect(serialized).toContain('"ExampleSigner"')
	expect(serialized.endsWith('\n')).toBe(true)
	expect(parseClaSignersFile(serialized)).toEqual(recorded.file)
	expect(() => parseClaSignersFile('{"version":2}')).toThrow(/version 1/)
	expect(
		applyIndividualClaSigningComment({
			file: empty,
			github: '   ',
			signedAt: '2026-08-16',
			comment: individualClaSigningPhrase,
		}),
	).toEqual({ file: empty, status: 'ignored', reason: 'missing_login' })
})

test('CLA check accepts the PR author signing in a comment', () => {
	const author = {
		githubLogin: 'example-signer',
		name: 'Example Signer',
		email: null,
	}
	const comments = [
		{
			login: 'example-signer',
			createdAt: '2026-08-16T10:30:00Z',
			body: individualClaSigningPhrase,
		},
	]

	const signed = applyIndividualClaSigningComments(signersFile(), comments)
	expect(signed.recorded).toEqual(['example-signer'])
	expect(checkClaIdentities([author], signed.file)).toEqual({ ok: true })
})

test('CLA check rejects a signing comment from another login or with extra text', () => {
	const author = {
		githubLogin: 'example-signer',
		name: 'Example Signer',
		email: null,
	}
	const otherLogin = applyIndividualClaSigningComments(signersFile(), [
		{
			login: 'different-signer',
			createdAt: '2026-08-16T10:30:00Z',
			body: individualClaSigningPhrase,
		},
	])
	const extraText = applyIndividualClaSigningComments(signersFile(), [
		{
			login: 'example-signer',
			createdAt: '2026-08-16T10:30:00Z',
			body: `${individualClaSigningPhrase} thanks`,
		},
	])

	expect(checkClaIdentities([author], otherLogin.file).ok).toBe(false)
	expect(checkClaIdentities([author], extraText.file).ok).toBe(false)
})

test('multiple CLA signing comments record each new signer only once', () => {
	const initial = signersFile({
		signers: [
			{ github: 'AlreadySigned', signedAt: '2026-08-01', cla: 'individual' },
		],
	})
	const result = applyIndividualClaSigningComments(initial, [
		{
			login: 'FirstSigner',
			createdAt: '2026-08-16T10:30:00Z',
			body: individualClaSigningPhrase,
		},
		{
			login: 'SecondSigner',
			createdAt: '2026-08-17T11:45:00Z',
			body: individualClaSigningPhrase,
		},
		{
			login: 'firstsigner',
			createdAt: '2026-08-18T12:00:00Z',
			body: individualClaSigningPhrase,
		},
		{
			login: 'alreadysigned',
			createdAt: '2026-08-19T12:00:00Z',
			body: individualClaSigningPhrase,
		},
	])

	expect(result.recorded).toEqual(['FirstSigner', 'SecondSigner'])
	expect(result.file.signers).toEqual([
		...initial.signers,
		{ github: 'FirstSigner', signedAt: '2026-08-16', cla: 'individual' },
		{ github: 'SecondSigner', signedAt: '2026-08-17', cla: 'individual' },
	])

	const alreadySigned = applyIndividualClaSigningComments(result.file, [
		{
			login: 'firstsigner',
			createdAt: '2026-08-20T12:00:00Z',
			body: individualClaSigningPhrase,
		},
	])
	expect(alreadySigned).toEqual({ file: result.file, recorded: [] })
})

test('serialized CLA signers file matches the repo formatter', () => {
	const serialized = serializeClaSignersFile(
		signersFile({
			allowlist: {
				github: ['kentcdodds'],
				email: [
					'me@kentcdodds.com',
					'me+github@kentcdodds.com',
					'noreply@anthropic.com',
				],
			},
		}),
	)
	expect(serialized).toContain('\t\t"github": ["kentcdodds"],\n')
	expect(serialized).toContain(
		'\t\t"email": [\n\t\t\t"me@kentcdodds.com",\n\t\t\t"me+github@kentcdodds.com",\n\t\t\t"noreply@anthropic.com"\n\t\t]\n',
	)
})
