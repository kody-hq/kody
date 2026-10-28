import { readFile, writeFile } from 'node:fs/promises'
import { isExecutedDirectly } from '../node-runtime.ts'

export type ClaIdentity = {
	githubLogin: string | null
	name: string | null
	email: string | null
}

type ClaSigner = {
	github: string
	signedAt: string
	cla: 'individual' | 'entity'
}

export type ClaSignersFile = {
	version: 1
	document: string
	allowlist: {
		github: Array<string>
		email: Array<string>
	}
	signers: Array<ClaSigner>
}

type ClaMissingIdentity = {
	identity: ClaIdentity
	reason: string
}

export type ClaCheckResult =
	| { ok: true }
	| { ok: false; missing: Array<ClaMissingIdentity> }

export const individualClaSigningPhrase =
	'I have read the CLA and I hereby sign the CLA'

const githubBotLoginPattern = /\[bot\]$/i

export type ClaRecordResult =
	| { status: 'recorded'; github: string }
	| { status: 'already_signed'; github: string }
	| { status: 'ignored'; reason: 'not_signing_comment' | 'missing_login' }

export type ClaSigningComment = {
	login: string
	createdAt: string
	body: string
}

function normalize(value: string) {
	return value.trim().toLowerCase()
}

function identityLabel(identity: ClaIdentity) {
	if (identity.githubLogin) {
		return `@${identity.githubLogin}`
	}
	if (identity.email) {
		return identity.email
	}
	if (identity.name) {
		return identity.name
	}
	return 'unknown identity'
}

export function parseClaSignersFile(raw: string): ClaSignersFile {
	const parsed: unknown = JSON.parse(raw)
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('version' in parsed) ||
		parsed.version !== 1
	) {
		throw new Error('CLA signers file must be version 1 JSON')
	}

	const file = parsed as ClaSignersFile
	if (
		typeof file.document !== 'string' ||
		typeof file.allowlist !== 'object' ||
		file.allowlist === null ||
		!Array.isArray(file.allowlist.github) ||
		!Array.isArray(file.allowlist.email) ||
		!Array.isArray(file.signers)
	) {
		throw new Error('CLA signers file is missing allowlist or signers')
	}

	return file
}

// Match the repo formatter (oxfmt: printWidth 80, tabWidth 2): an allowlist
// array stays on one line only while that line fits; otherwise it expands one
// value per line, which is what JSON.stringify with tab indent produces.
const formatterPrintWidth = 80
const allowlistEntryIndentWidth = 4

function compactStringArray(values: ReadonlyArray<string>) {
	return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`
}

function compactAllowlistEntryFits(input: {
	key: string
	compact: string
	trailingComma: boolean
}) {
	const width =
		allowlistEntryIndentWidth +
		`${JSON.stringify(input.key)}: `.length +
		input.compact.length +
		(input.trailingComma ? 1 : 0)
	return width <= formatterPrintWidth
}

export function serializeClaSignersFile(file: ClaSignersFile) {
	const placeholderGithub = '__CLA_ALLOWLIST_GITHUB__'
	const placeholderEmail = '__CLA_ALLOWLIST_EMAIL__'
	const compactGithub = compactStringArray(file.allowlist.github)
	const compactEmail = compactStringArray(file.allowlist.email)
	const githubFits = compactAllowlistEntryFits({
		key: 'github',
		compact: compactGithub,
		trailingComma: true,
	})
	const emailFits = compactAllowlistEntryFits({
		key: 'email',
		compact: compactEmail,
		trailingComma: false,
	})
	const indented = JSON.stringify(
		{
			...file,
			allowlist: {
				github: githubFits ? placeholderGithub : file.allowlist.github,
				email: emailFits ? placeholderEmail : file.allowlist.email,
			},
		},
		null,
		'\t',
	)
		.replace(JSON.stringify(placeholderGithub), compactGithub)
		.replace(JSON.stringify(placeholderEmail), compactEmail)
	return `${indented}\n`
}

export function isIndividualClaSigningComment(body: string) {
	return body.trim() === individualClaSigningPhrase
}

export function applyIndividualClaSigningComment(input: {
	file: ClaSignersFile
	github: string
	signedAt: string
	comment: string
}): { file: ClaSignersFile } & ClaRecordResult {
	if (!isIndividualClaSigningComment(input.comment)) {
		return {
			file: input.file,
			status: 'ignored',
			reason: 'not_signing_comment',
		}
	}

	const login = input.github.trim()
	if (!login) {
		return { file: input.file, status: 'ignored', reason: 'missing_login' }
	}

	if (
		input.file.signers.some(
			(signer) => normalize(signer.github) === normalize(login),
		)
	) {
		return { file: input.file, status: 'already_signed', github: login }
	}

	return {
		file: {
			...input.file,
			signers: [
				...input.file.signers,
				{
					github: login,
					signedAt: input.signedAt,
					cla: 'individual',
				},
			],
		},
		status: 'recorded',
		github: login,
	}
}

export function applyIndividualClaSigningComments(
	file: ClaSignersFile,
	comments: ReadonlyArray<ClaSigningComment>,
): { file: ClaSignersFile; recorded: Array<string> } {
	let updated = file
	const recorded: Array<string> = []
	const recordedLogins = new Set<string>()

	for (const comment of comments) {
		const result = applyIndividualClaSigningComment({
			file: updated,
			github: comment.login,
			signedAt: comment.createdAt.slice(0, 10),
			comment: comment.body,
		})
		updated = result.file
		if (result.status !== 'recorded') {
			continue
		}

		const login = normalize(result.github)
		if (recordedLogins.has(login)) {
			continue
		}
		recordedLogins.add(login)
		recorded.push(result.github)
	}

	return { file: updated, recorded }
}

function isAllowlistedIdentity(
	identity: ClaIdentity,
	signersFile: ClaSignersFile,
) {
	const login = identity.githubLogin ? normalize(identity.githubLogin) : null
	if (
		login &&
		(githubBotLoginPattern.test(login) || login.startsWith('app/'))
	) {
		return true
	}
	if (
		login &&
		signersFile.allowlist.github.some((entry) => normalize(entry) === login)
	) {
		return true
	}

	const email = identity.email ? normalize(identity.email) : null
	return Boolean(
		email &&
		signersFile.allowlist.email.some((entry) => normalize(entry) === email),
	)
}

function hasSignedCla(identity: ClaIdentity, signersFile: ClaSignersFile) {
	const login = identity.githubLogin ? normalize(identity.githubLogin) : null
	if (!login) {
		return false
	}

	return signersFile.signers.some(
		(signer) => normalize(signer.github) === login,
	)
}

export function checkClaIdentities(
	identities: ReadonlyArray<ClaIdentity>,
	signersFile: ClaSignersFile,
): ClaCheckResult {
	const missing: Array<ClaMissingIdentity> = []
	const seen = new Set<string>()

	for (const identity of identities) {
		const key = [identity.githubLogin, identity.email, identity.name]
			.map((part) => (part ? normalize(part) : ''))
			.join('|')
		if (seen.has(key)) {
			continue
		}
		seen.add(key)

		if (isAllowlistedIdentity(identity, signersFile)) {
			continue
		}
		if (hasSignedCla(identity, signersFile)) {
			continue
		}

		const reason = identity.githubLogin
			? `${identityLabel(identity)} has not signed the CLA`
			: `${identityLabel(identity)} has no GitHub login and is not a Licensor email`
		missing.push({ identity, reason })
	}

	return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

export function formatClaFailure(
	result: Extract<ClaCheckResult, { ok: false }>,
) {
	const lines = [
		'Unsigned contributions cannot merge.',
		'Read docs/legal/individual-cla.md (or the Entity CLA if an organization owns the work).',
		'Comment on the pull request: I have read the CLA and I hereby sign the CLA',
		'That signing comment on the pull request satisfies this check.',
		'The signer is recorded on the cla-signatures branch after the pull request merges. See docs/contributing/inbound-contributions.md.',
		'',
		'Missing signatures:',
		...result.missing.map((entry) => `- ${entry.reason}`),
	]
	return lines.join('\n')
}

function readFlag(args: Array<string>, flag: string) {
	const index = args.indexOf(flag)
	if (index === -1) {
		return null
	}
	const value = args[index + 1]
	if (!value || value.startsWith('--')) {
		return null
	}
	return value
}

async function runRecordCli(args: Array<string>) {
	const signersPath = readFlag(args, '--signers')
	const github = readFlag(args, '--record-signer')
	const signedAt = readFlag(args, '--signed-at')
	const commentPath = readFlag(args, '--comment-file')

	if (!signersPath || !github || !signedAt || !commentPath) {
		throw new Error(
			'Usage: node tools/ci/check-cla.ts --signers <file> --record-signer <login> --signed-at <YYYY-MM-DD> --comment-file <file>',
		)
	}

	const current = parseClaSignersFile(await readFile(signersPath, 'utf8'))
	const recorded = applyIndividualClaSigningComment({
		file: current,
		github,
		signedAt,
		comment: await readFile(commentPath, 'utf8'),
	})

	switch (recorded.status) {
		case 'ignored':
			console.log('skipped=true')
			console.log('added=false')
			break
		case 'already_signed':
			console.log('skipped=false')
			console.log('added=false')
			console.log(`github=${recorded.github}`)
			break
		case 'recorded':
			await writeFile(
				signersPath,
				serializeClaSignersFile(recorded.file),
				'utf8',
			)
			console.log('skipped=false')
			console.log('added=true')
			console.log(`github=${recorded.github}`)
			break
		default: {
			const exhaustive: never = recorded
			throw new Error(
				`Unhandled CLA record status: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

async function runRecordCommentsCli(args: Array<string>) {
	const signersPath = readFlag(args, '--signers')
	const commentsPath = readFlag(args, '--record-comments-json')

	if (!signersPath || !commentsPath) {
		throw new Error(
			'Usage: node tools/ci/check-cla.ts --signers <file> --record-comments-json <file>',
		)
	}

	const current = parseClaSignersFile(await readFile(signersPath, 'utf8'))
	const commentsRaw: unknown = JSON.parse(await readFile(commentsPath, 'utf8'))
	if (!Array.isArray(commentsRaw)) {
		throw new Error('CLA signing comments JSON must be an array')
	}

	const result = applyIndividualClaSigningComments(
		current,
		commentsRaw as Array<ClaSigningComment>,
	)
	if (result.recorded.length > 0) {
		await writeFile(signersPath, serializeClaSignersFile(result.file), 'utf8')
	}

	console.log(`added=${result.recorded.length > 0}`)
	console.log(`github=${result.recorded.join(',')}`)
}

async function runCheckCli(args: Array<string>) {
	const signersPath = readFlag(args, '--signers')
	const identitiesPath = readFlag(args, '--identities-json')
	const signingCommentsPath = readFlag(args, '--signing-comments-json')

	if (
		!signersPath ||
		!identitiesPath ||
		(args.includes('--signing-comments-json') && !signingCommentsPath)
	) {
		throw new Error(
			'Usage: node tools/ci/check-cla.ts --signers <file> --identities-json <file> [--signing-comments-json <file>]',
		)
	}

	let signersFile = parseClaSignersFile(await readFile(signersPath, 'utf8'))
	if (signingCommentsPath) {
		const commentsRaw: unknown = JSON.parse(
			await readFile(signingCommentsPath, 'utf8'),
		)
		if (!Array.isArray(commentsRaw)) {
			throw new Error('CLA signing comments JSON must be an array')
		}
		signersFile = applyIndividualClaSigningComments(
			signersFile,
			commentsRaw as Array<ClaSigningComment>,
		).file
	}

	const identitiesRaw: unknown = JSON.parse(
		await readFile(identitiesPath, 'utf8'),
	)
	if (!Array.isArray(identitiesRaw)) {
		throw new Error('Identities JSON must be an array')
	}

	const result = checkClaIdentities(
		identitiesRaw as Array<ClaIdentity>,
		signersFile,
	)
	if (!result.ok) {
		console.error(formatClaFailure(result))
		process.exitCode = 1
	}
}

async function runCli(args: Array<string>) {
	if (args.includes('--record-comments-json')) {
		await runRecordCommentsCli(args)
		return
	}

	if (args.includes('--record-signer')) {
		await runRecordCli(args)
		return
	}

	await runCheckCli(args)
}

if (isExecutedDirectly(import.meta.url)) {
	await runCli(process.argv.slice(2))
}
