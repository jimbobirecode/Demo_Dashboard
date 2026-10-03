-- Baseline, part 3: one-time sign-in links for the tour operator portal.
--
-- Previously created at runtime by server/src/routes/portal.js on the first
-- portal sign-in. Only the SHA-256 of a token is stored.

CREATE TABLE IF NOT EXISTS public.operator_portal_links (
    id           SERIAL PRIMARY KEY,
    club         TEXT NOT NULL,
    operator_id  INTEGER NOT NULL,
    email        TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    requested_ip TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
