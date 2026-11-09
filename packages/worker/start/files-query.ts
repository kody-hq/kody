import { createPageQuery } from './page-query.ts'
import { loadFilesPage } from '#start/server/files'
export const filesPageQuery = createPageQuery('loadFilesPage', loadFilesPage, {
	freshAuthorization: true,
	staleTime: 0,
})
