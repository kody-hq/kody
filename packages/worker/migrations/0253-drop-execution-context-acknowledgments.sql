-- Drop the first-run acknowledgment table from 0252.
--
-- The first-run acknowledgment was reverted: the excess-access warnings and
-- notices (0248) already tell people what a shared context runs as, and
-- accepting the share is the consent. Nothing reads or writes this table.

DROP INDEX IF EXISTS execution_context_acknowledgments_user;
DROP TABLE IF EXISTS execution_context_acknowledgments;
