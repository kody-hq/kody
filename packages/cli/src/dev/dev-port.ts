/**
 * `kody dev` ports: each package gets a stable default (so bookmarks, OAuth
 * redirect URIs, and agent notes keep working across restarts) and walks up to
 * the next free port when that one is taken. An explicit `--port` is honored
 * exactly and fails with an actionable message instead.
 */

import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StructuredCliError } from '../structured-error.js'

export const devPortRange = { min: 4100, max: 4999 } as const
const fallbackAttempts = 20

export function defaultDevPort(kodyId: string): number {
	const span = devPortRange.max - devPortRange.min + 1
	const hash = createHash('sha256').update(kodyId).digest()
	return devPortRange.min + (hash.readUInt32BE(0) % span)
}

export function parseDevPort(raw: string): number {
	const port = /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN
	if (!Number.isInteger(port) || port > 65_535) {
		throw new StructuredCliError({
			code: 'invalid_port',
			message: `--port must be an integer from 0 to 65535 (got "${raw}").`,
			fix: 'Pass --port 0 for any free port, or omit --port to use this package’s stable default.',
		})
	}
	return port
}

/**
 * Listen on `port` exactly when `explicit`, otherwise on `port` or the next
 * free port above it. Returns the bound port.
 */
export async function listenDevServer(
	server: Server,
	input: { host: string; port: number; explicit: boolean },
): Promise<number> {
	const attempts = input.explicit || input.port === 0 ? 1 : fallbackAttempts
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const port = input.port === 0 ? 0 : wrapPort(input.port + attempt)
		try {
			await listenOnce(server, input.host, port)
			return (server.address() as AddressInfo).port
		} catch (error) {
			if (isAddressUnavailable(error)) throw hostUnavailableError(input.host)
			if (input.explicit) {
				if (isAddressInUse(error)) throw portInUseError(input.host, port)
				throw error
			}
			if (!isAddressInUse(error) && !isPortReserved(error)) throw error
		}
	}
	throw new StructuredCliError({
		code: 'dev_port_in_use',
		message: `Ports ${input.port}–${wrapPort(input.port + attempts - 1)} on ${input.host} are all in use.`,
		fix: 'Stop old `kody dev` processes, or pass --port 0 for any free port.',
	})
}

function portInUseError(host: string, port: number): StructuredCliError {
	return new StructuredCliError({
		code: 'dev_port_in_use',
		message: `Port ${port} on ${host} is already in use.`,
		fix: `Find the owner with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` and stop it, pass another --port, or omit --port to use this package’s default (it moves to the next free port automatically).`,
	})
}

function hostUnavailableError(host: string): StructuredCliError {
	return new StructuredCliError({
		code: 'dev_host_unavailable',
		message: `Cannot listen on ${host}: it is not an address of this machine.`,
		fix: 'Pass one of this machine’s IP addresses, or --host 0.0.0.0 to listen on all of them.',
	})
}

function isAddressUnavailable(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRNOTAVAIL'
}

function wrapPort(port: number): number {
	return port > 65_535 ? devPortRange.min + (port - 65_536) : port
}

function listenOnce(server: Server, host: string, port: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off('listening', onListening)
			reject(error)
		}
		const onListening = () => {
			server.off('error', onError)
			resolve()
		}
		server.once('error', onError)
		server.once('listening', onListening)
		server.listen(port, host)
	})
}

function isAddressInUse(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
}

/** Windows answers EACCES for ports inside an excluded (reserved) range. */
function isPortReserved(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'EACCES'
}
