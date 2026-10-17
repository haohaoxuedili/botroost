BEGIN;
-- Admission control needs what each endpoint actually reserves, not what a new one would.
-- An endpoint created under the old defaults keeps its 1 vCPU / 1 GiB request until its pod
-- is recreated, so counting it as the current 2 vCPU default would refuse placements that fit.
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS resources jsonb;
-- Backfill from the last command each endpoint received: its runtime_request is the request
-- the running pod was actually created with.
UPDATE endpoints e SET resources = c.runtime_request->'resources'
FROM (SELECT DISTINCT ON (endpoint_id) endpoint_id, runtime_request FROM agent_commands ORDER BY endpoint_id, created_at DESC) c
WHERE c.endpoint_id = e.id AND e.resources IS NULL AND c.runtime_request->'resources' IS NOT NULL;
COMMIT;
