CREATE TABLE IF NOT EXISTS ciel_control_flags (
  control_key TEXT PRIMARY KEY,
  control_value TEXT NOT NULL CHECK(control_value IN ('true','false')),
  updated_at_ms INTEGER NOT NULL
);
