import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type FileStoreRpc } from './store.ts'

export function fileStoreName(ownerId: OwnerId) {
	return `${ownerId}:files:v1`
}
export function fileStoreRpc(
	env: Pick<Env, 'FILE_STORE'>,
	ownerId: OwnerId,
): FileStoreRpc {
	if (!env.FILE_STORE) throw new Error('File storage is not configured.')
	return env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(ownerId)),
	) as unknown as FileStoreRpc
}
