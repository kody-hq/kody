-- Optional label, last-used timestamp, and default teams for membership
-- invite links. Labels are display-only. last_used_at updates on each
-- successful claim. team_ids_json applies only to membership links (same
-- idea as addressed invites); team and resource links leave it null.

ALTER TABLE org_invite_links ADD COLUMN label TEXT;
ALTER TABLE org_invite_links ADD COLUMN last_used_at TEXT;
ALTER TABLE org_invite_links ADD COLUMN team_ids_json TEXT;
