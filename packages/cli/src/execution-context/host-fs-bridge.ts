import {
	access,
	appendFile,
	copyFile,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	rmdir,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { type Stats } from 'node:fs'
import {
	type EffectiveFs,
	FsAccessError,
	resolveHostPath,
} from './fs-access.js'

/** Largest file one host-folder read or write moves through the bridge. */
export const hostFsMaxBytes = 32 * 1024 * 1024

export type HostFsRequest = {
	op: string
	path: string
	dest?: string
	data?: string
	recursive?: boolean
	force?: boolean
	withFileTypes?: boolean
	mode?: number
}

function statView(stats: Stats) {
	return {
		kind: stats.isDirectory()
			? 'directory'
			: stats.isSymbolicLink()
				? 'symlink'
				: stats.isFile()
					? 'file'
					: 'other',
		size: stats.size,
		mode: stats.mode,
		mtimeMs: stats.mtimeMs,
		atimeMs: stats.atimeMs,
		ctimeMs: stats.ctimeMs,
		birthtimeMs: stats.birthtimeMs,
	}
}

function decodeData(data: unknown) {
	const bytes = Buffer.from(typeof data === 'string' ? data : '', 'base64')
	if (bytes.byteLength > hostFsMaxBytes) {
		throw new FsAccessError(
			'EFBIG',
			`Host folder writes are limited to ${hostFsMaxBytes} bytes per call.`,
		)
	}
	return bytes
}

/** Runs one fs call from a run's workerd against the effective host mounts. */
export async function handleHostFsRequest(
	effective: EffectiveFs,
	request: HostFsRequest,
): Promise<unknown> {
	const path = request.path
	switch (request.op) {
		case 'readFile': {
			const real = await resolveHostPath(effective, path, 'read')
			const info = await stat(real)
			if (info.size > hostFsMaxBytes) {
				throw new FsAccessError(
					'EFBIG',
					`${path} is larger than the ${hostFsMaxBytes}-byte host folder read limit.`,
				)
			}
			return (await readFile(real)).toString('base64')
		}
		case 'writeFile':
		case 'appendFile': {
			const real = await resolveHostPath(effective, path, 'write', {
				allowMountRoot: false,
			})
			const write = request.op === 'writeFile' ? writeFile : appendFile
			await write(real, decodeData(request.data))
			return null
		}
		case 'readdir': {
			const real = await resolveHostPath(effective, path, 'read')
			const entries = await readdir(real, { withFileTypes: true })
			return entries.map((entry) => ({
				name: entry.name,
				kind: entry.isDirectory()
					? 'directory'
					: entry.isSymbolicLink()
						? 'symlink'
						: entry.isFile()
							? 'file'
							: 'other',
			}))
		}
		case 'stat':
			return statView(
				await stat(await resolveHostPath(effective, path, 'read')),
			)
		case 'lstat':
			return statView(
				await lstat(
					await resolveHostPath(effective, path, 'read', {
						followFinal: false,
					}),
				),
			)
		case 'access': {
			const wantsWrite =
				typeof request.mode === 'number' && (request.mode & 2) !== 0
			const real = await resolveHostPath(
				effective,
				path,
				wantsWrite ? 'write' : 'read',
				{ allowMountRoot: true },
			)
			await access(real, request.mode)
			return null
		}
		case 'realpath':
			return await resolveHostPath(effective, path, 'read')
		case 'mkdir': {
			const real = await resolveHostPath(effective, path, 'write', {
				followFinal: false,
				allowMountRoot: true,
			})
			await mkdir(real, { recursive: request.recursive === true })
			return null
		}
		case 'rm':
		case 'unlink':
		case 'rmdir': {
			const real = await resolveHostPath(effective, path, 'write', {
				followFinal: false,
			})
			if (request.op === 'unlink') await unlink(real)
			else if (request.op === 'rmdir') await rmdir(real)
			else
				await rm(real, {
					recursive: request.recursive === true,
					force: request.force === true,
				})
			return null
		}
		case 'rename':
		case 'copyFile': {
			const dest = request.dest ?? ''
			const destReal = await resolveHostPath(effective, dest, 'write', {
				followFinal: request.op === 'copyFile',
			})
			if (request.op === 'rename') {
				const from = await resolveHostPath(effective, path, 'write', {
					followFinal: false,
				})
				await rename(from, destReal)
			} else {
				await copyFile(await resolveHostPath(effective, path, 'read'), destReal)
			}
			return null
		}
		default:
			throw new FsAccessError(
				'ENOTSUP',
				`fs.${request.op} is not supported on execution context host folders. Use fs/promises readFile, writeFile, appendFile, readdir, stat, lstat, mkdir, rm, unlink, rmdir, rename, copyFile, access, or realpath.`,
			)
	}
}
