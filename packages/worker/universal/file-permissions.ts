export const filePermissionOptions = [
	{ permission: 'file:read', label: 'View and download' },
	{ permission: 'file:comment', label: 'Comment' },
	{ permission: 'file:write', label: 'Edit' },
	{ permission: 'file:delete', label: 'Delete' },
	{ permission: 'file:manage_access', label: 'Manage access' },
] as const
export type FilePermission =
	(typeof filePermissionOptions)[number]['permission']
