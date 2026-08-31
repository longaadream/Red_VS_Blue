export const POSTGRES_AUTHORITY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS battle_authority_schema_version (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    version INTEGER NOT NULL CHECK (version > 0)
  )`,
  `INSERT INTO battle_authority_schema_version (singleton, version)
   VALUES (TRUE, 1)
   ON CONFLICT (singleton) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS battle_room_authority (
    battle_id TEXT PRIMARY KEY,
    epoch BIGINT NOT NULL,
    room_json JSONB NOT NULL,
    authority_version BIGINT NOT NULL CHECK (authority_version >= 0),
    durable_version BIGINT NOT NULL CHECK (durable_version >= 0 AND durable_version <= authority_version),
    state_hash TEXT NOT NULL,
    public_hash TEXT NOT NULL,
    transition_hash TEXT NOT NULL,
    terminal BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS battle_transition (
    battle_id TEXT NOT NULL REFERENCES battle_room_authority(battle_id) ON DELETE CASCADE,
    epoch BIGINT NOT NULL,
    from_version BIGINT NOT NULL,
    to_version BIGINT NOT NULL,
    client_action_id TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    pre_state_hash TEXT NOT NULL,
    post_state_hash TEXT NOT NULL,
    previous_transition_hash TEXT NOT NULL,
    transition_hash TEXT NOT NULL,
    transition_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (battle_id, to_version),
    UNIQUE (battle_id, client_action_id),
    CHECK (to_version = from_version + 1)
  )`,
  `CREATE TABLE IF NOT EXISTS battle_receipt (
    battle_id TEXT NOT NULL REFERENCES battle_room_authority(battle_id) ON DELETE CASCADE,
    client_action_id TEXT NOT NULL,
    authority_version BIGINT NOT NULL,
    status TEXT NOT NULL,
    receipt_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (battle_id, client_action_id)
  )`,
  `CREATE TABLE IF NOT EXISTS battle_checkpoint (
    battle_id TEXT NOT NULL REFERENCES battle_room_authority(battle_id) ON DELETE CASCADE,
    authority_version BIGINT NOT NULL,
    state_hash TEXT NOT NULL,
    public_hash TEXT NOT NULL,
    transition_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    checkpoint_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (battle_id, authority_version)
  )`,
  `CREATE TABLE IF NOT EXISTS battle_terminal_barrier (
    battle_id TEXT PRIMARY KEY REFERENCES battle_room_authority(battle_id) ON DELETE CASCADE,
    authority_version BIGINT NOT NULL,
    state_hash TEXT NOT NULL,
    transition_hash TEXT NOT NULL,
    checkpoint_json JSONB NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS battle_transition_replay_idx ON battle_transition (battle_id, from_version)',
  'CREATE INDEX IF NOT EXISTS battle_checkpoint_restore_idx ON battle_checkpoint (battle_id, authority_version DESC)',
] as const
