/**
 * Database migrations, applied automatically (once each) the first time the Worker runs.
 * Add new migrations to the END of this list; never edit one that has shipped.
 */
export interface Migration {
  id: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_init',
    statements: [
      `CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
)`,
      `CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`,
      `CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scene TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
      `CREATE INDEX projects_user ON projects(user_id, updated_at DESC)`,
      `CREATE TABLE project_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
      `CREATE INDEX versions_project ON project_versions(project_id, id DESC)`,
      `CREATE TABLE provider_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  last4 TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
)`,
      `CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
)`,
      `CREATE INDEX ledger_user ON ledger(user_id)`,
      `CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  provider_name TEXT,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  stage_done INTEGER NOT NULL DEFAULT -1,
  error TEXT,
  cost INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  input TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
      `CREATE UNIQUE INDEX jobs_idempotency ON jobs(user_id, idempotency_key)`,
      `CREATE INDEX jobs_project ON jobs(project_id, created_at DESC)`,
      `CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
      `CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
)`,
    ],
  },
  {
    id: '0002_assets_sharing_billing',
    statements: [
      `CREATE TABLE assets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  has_frames INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, asset_id)
)`,
      `CREATE TABLE shares (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
)`,
      `CREATE INDEX shares_project ON shares(project_id)`,
      `CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
      `CREATE INDEX subscriptions_customer ON subscriptions(stripe_customer_id)`,
    ],
  },
  {
    id: '0003_teams_tools',
    statements: [
      `CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
)`,
      `CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
)`,
      `CREATE INDEX team_members_user ON team_members(user_id)`,
      `CREATE TABLE team_invites (
  token TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`,
      `CREATE INDEX team_invites_team ON team_invites(team_id)`,
      `ALTER TABLE projects ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL`,
      `CREATE INDEX projects_team ON projects(team_id)`,
      `ALTER TABLE assets ADD COLUMN hd INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'motion'`,
    ],
  },
  {
    id: '0004_file_chunks',
    statements: [
      `CREATE TABLE file_chunks (
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  type TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (key, idx)
)`,
    ],
  },
];
