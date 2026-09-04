-- 0009 · Seed data.
--
-- Five departments, because Model 1's whole premise is that an estate is owned by many departments
-- with no shared registry. Four users, one per role, so RBAC (D1-07) is testable from the first
-- commit that needs it rather than from whenever someone remembers to add fixtures.
--
-- Idempotent: ON CONFLICT DO NOTHING on the natural keys, so `db:migrate` twice is a no-op.
--
-- The seed password is `saakshi-dev` for all four users. It is a **development credential**,
-- deliberately in version control so a fresh clone can log in, in the same class as compose's
-- POSTGRES_PASSWORD. D4-01 must not deploy these rows; D4-02 issues separate judge credentials.
-- Hashed with pgcrypto bcrypt (`gen_salt('bf')`), so the hash differs per run and is verifiable by
-- any standard bcrypt library.

INSERT INTO departments (name, code, contact_json) VALUES
  ('Gujarat Police',                  'POLICE',    '{"nodal":"Control Room","phone":"100"}'),
  ('Department of Health',            'HEALTH',    '{"nodal":"State Health Office"}'),
  ('Gujarat State Road Transport Corporation', 'GSRTC', '{"nodal":"Depot Operations"}'),
  ('Panchayat, Rural Housing & Rural Development', 'PANCHAYAT', '{"nodal":"District Panchayat"}'),
  ('Municipal Corporation',           'MUNICIPAL', '{"nodal":"City Command Centre"}')
ON CONFLICT (code) DO NOTHING;

INSERT INTO users (name, badge_no, role, department_id, password_hash)
SELECT v.name, v.badge_no, v.role::user_role, d.id, crypt('saakshi-dev', gen_salt('bf'))
FROM (VALUES
  -- Full control: registry, onboarding, retention policy.
  ('A. Desai',   'GP-ADM-0001', 'admin',      'POLICE'),
  -- Approves exports and escalations; sees the trust dashboard.
  ('R. Chauhan', 'GP-SUP-0100', 'supervisor', 'POLICE'),
  -- The control-room seat: alert queue, verify, acknowledge.
  ('M. Patel',   'GP-OPR-1042', 'operator',   'POLICE'),
  -- Read-only across the audit chain. Cannot see live video or run traces.
  ('S. Joshi',   'GP-AUD-0007', 'auditor',    'MUNICIPAL')
) AS v(name, badge_no, role, dept_code)
JOIN departments d ON d.code = v.dept_code
ON CONFLICT (badge_no) DO NOTHING;
