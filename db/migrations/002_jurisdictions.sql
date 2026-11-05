CREATE TABLE jurisdiction_access (
  country TEXT PRIMARY KEY,
  access TEXT NOT NULL CHECK (access IN ('allow', 'pending', 'block')),
  entity_id TEXT REFERENCES entities(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jurisdiction_audit (
  id BIGSERIAL PRIMARY KEY,
  country TEXT NOT NULL,
  previous_access TEXT,
  access TEXT NOT NULL,
  actor_user_id BIGINT,
  actor_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO jurisdiction_access (country, access, entity_id) VALUES
  ('SG', 'allow', 'SG-OPCO'),
  ('US', 'allow', 'SG-OPCO'),
  ('MY', 'pending', 'MY-ENTITY');

INSERT INTO jurisdiction_audit (country, previous_access, access, actor_email)
SELECT country, NULL, access, 'seed'
FROM jurisdiction_access;
