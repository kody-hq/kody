declare module 'node:crypto' {
	export interface Hash {
		update(data: string): Hash
		digest(): Uint8Array
	}
	export function createHash(algorithm: 'sha256'): Hash
}
