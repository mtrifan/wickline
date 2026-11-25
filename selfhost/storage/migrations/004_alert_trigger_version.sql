-- Schema v4: the version of the `alerts` value that recorded each alert's last trigger
-- (PLAN §2.5.6). A browser trigger near a recorded one collapses into it only when the browser's
-- base predates that version; a browser that saw the trigger and the re-arm reports a new crossing.
ALTER TABLE alert_meta ADD COLUMN trigger_version INTEGER;
