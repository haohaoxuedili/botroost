BEGIN;
-- Provider routing: new agents report this flag on claim. Cross-provider
-- commands are only dispatched to nodes whose agent supports routing;
-- legacy agents keep serving their enrolled provider only.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS provider_routing boolean NOT NULL DEFAULT false;
COMMIT;
