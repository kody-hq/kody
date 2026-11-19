-- When a capability approval's commit first served anonymous visitors (became
-- the source's serving commit). The visitor fallback while a wider republish
-- awaits approval only picks approvals that served, so an approval for a
-- commit superseded before it served never becomes the public version.
-- NULL means the commit has not served yet. Existing rows keep today's
-- fallback by counting as served from their approval time.
ALTER TABLE package_capability_approvals ADD COLUMN served_at TEXT;

UPDATE package_capability_approvals SET served_at = approved_at;
