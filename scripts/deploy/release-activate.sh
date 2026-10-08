#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

# RED-245 is intentionally a fixed production cutover.  The release id and
# source commit are supplied explicitly so this script cannot be repurposed as
# a general remote installer by accident.
readonly RVB_ROOT=/opt/rvb
readonly NODE=/opt/rvb/runtime/node-v24.21.0-linux-x64/bin/node
readonly GAME_LINK=/opt/rvb/current
readonly OFFICIAL_LINK=/opt/rvb/official-current
readonly GAME_UNIT=rvb-game
readonly OFFICIAL_UNIT=rvb-official
readonly GAME_ENTRY=colyseus-server.mjs
readonly OFFICIAL_ENTRY=official-server.mjs
readonly GAME_PORT=2567
readonly OFFICIAL_PORT=2568
readonly GAME_STATE=/var/lib/rvb
readonly OFFICIAL_STATE=/var/lib/rvb-official
readonly PANEL_URL_FILE=/var/lib/rvb-official/control-panel.url
readonly LOCK_FILE=/var/lock/rvb-red245-release.lock
readonly EXPECTED_PACKAGE_HASH=25b673f202e1b9eeace0fce32398439c3178c7b128b23a32b3710e5c7e6d2346
readonly GAME_DATABASE=rvb
readonly OFFICIAL_DATABASE=rvb_official

RELEASE_ID=''
PREVIOUS_RELEASE_ID=''
EXPECTED_COMMIT=''
EXPECTED_OLD_PROFILE=''
EXPECTED_NEW_PROFILE=''
DATABASE=''

PANEL_URL=''
ORIGINAL_MAINTENANCE=''
OLD_AUTHORITY=''
MAINTENANCE_STARTED=0
GAME_PROFILE_CHANGED=0
OFFICIAL_PROFILE_CHANGED=0
LINKS_CHANGED=0
SERVICES_STOPPED=0
CUTOVER_STARTED=0
ROLLING_BACK=0
DEPLOY_SUCCEEDED=0

die() {
  printf 'RED-245 deploy refused: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: release-activate.sh --release-id ID --previous-release-id ID \
  --expected-commit SHA --expected-old-profile HASH --expected-new-profile HASH \
  --database NAME
EOF
  exit 2
}

is_hash() { [[ "$1" =~ ^[a-f0-9]{64}$ ]]; }
is_commit() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
is_release_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }

parse_args() {
  while (($#)); do
    case "$1" in
      --release-id|--candidate)
        [[ -z "$RELEASE_ID" ]] || die 'duplicate --release-id'
        (($# >= 2)) || usage
        RELEASE_ID=$2
        shift 2
        ;;
      --previous-release-id|--previous-release)
        [[ -z "$PREVIOUS_RELEASE_ID" ]] || die 'duplicate --previous-release-id'
        (($# >= 2)) || usage
        PREVIOUS_RELEASE_ID=$2
        shift 2
        ;;
      --expected-commit)
        [[ -z "$EXPECTED_COMMIT" ]] || die 'duplicate --expected-commit'
        (($# >= 2)) || usage
        EXPECTED_COMMIT=$2
        shift 2
        ;;
      --expected-old-profile)
        [[ -z "$EXPECTED_OLD_PROFILE" ]] || die 'duplicate --expected-old-profile'
        (($# >= 2)) || usage
        EXPECTED_OLD_PROFILE=$2
        shift 2
        ;;
      --expected-new-profile)
        [[ -z "$EXPECTED_NEW_PROFILE" ]] || die 'duplicate --expected-new-profile'
        (($# >= 2)) || usage
        EXPECTED_NEW_PROFILE=$2
        shift 2
        ;;
      --database)
        [[ -z "$DATABASE" ]] || die 'duplicate --database'
        (($# >= 2)) || usage
        DATABASE=$2
        shift 2
        ;;
      -h|--help) usage ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [[ -n "$RELEASE_ID" && -n "$PREVIOUS_RELEASE_ID" && -n "$EXPECTED_COMMIT" \
    && -n "$EXPECTED_OLD_PROFILE" && -n "$EXPECTED_NEW_PROFILE" && -n "$DATABASE" ]] || usage
  is_release_id "$RELEASE_ID" || die 'release id contains unsafe characters'
  is_release_id "$PREVIOUS_RELEASE_ID" || die 'previous release id contains unsafe characters'
  is_commit "$EXPECTED_COMMIT" || die 'expected commit must be a lowercase 40-character SHA-1'
  is_hash "$EXPECTED_OLD_PROFILE" || die 'expected old profile must be a lowercase SHA-256 hash'
  is_hash "$EXPECTED_NEW_PROFILE" || die 'expected new profile must be a lowercase SHA-256 hash'
  [[ "$EXPECTED_OLD_PROFILE" != "$EXPECTED_NEW_PROFILE" ]] || die 'expected old and new profile hashes must differ'
  [[ "$RELEASE_ID" != "$PREVIOUS_RELEASE_ID" ]] || die 'candidate and previous release ids must differ'
  [[ "$DATABASE" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || die 'database name contains unsafe characters'
  [[ "$DATABASE" == "$OFFICIAL_DATABASE" ]] || die "official database must be exactly $OFFICIAL_DATABASE"
  # RED-245 candidate names are deliberately allow-listed.  This also keeps a
  # typo from selecting an arbitrary immutable release directory.
  case "$RELEASE_ID" in
    release-0113-?????????-content-1012) ;;
    *) die "release id is not allow-listed: $RELEASE_ID" ;;
  esac
  case "$PREVIOUS_RELEASE_ID" in
    release-0112-4cd7617d8-content-1011) ;;
    *) die "previous release id is not allow-listed: $PREVIOUS_RELEASE_ID" ;;
  esac
}

assert_runtime() {
  [[ -x "$NODE" ]] || die "required Node runtime is missing: $NODE"
  command -v flock >/dev/null 2>&1 || die 'flock is required'
  command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required'
  command -v systemctl >/dev/null 2>&1 || die 'systemctl is required'
  command -v curl >/dev/null 2>&1 || die 'curl is required'
  command -v psql >/dev/null 2>&1 || die 'psql is required'
  command -v pg_dump >/dev/null 2>&1 || die 'pg_dump is required'
  command -v realpath >/dev/null 2>&1 || die 'realpath is required'
  command -v sudo >/dev/null 2>&1 || die 'sudo is required'
  command -v stat >/dev/null 2>&1 || die 'stat is required'
  command -v sleep >/dev/null 2>&1 || die 'sleep is required'
}

assert_service_account() {
  local unit=$1 user group
  user=$(systemctl show "$unit" --property=User --value) || die "cannot inspect $unit User"
  group=$(systemctl show "$unit" --property=Group --value) || die "cannot inspect $unit Group"
  [[ "$user" == rvb && "$group" == rvb ]] || die "$unit must run as rvb:rvb"
}

assert_profile_ownership() {
  local state=$1 owner
  [[ -d "$state/resource-pack" && ! -L "$state/resource-pack" ]] || die "missing resource-pack state: $state"
  owner=$(stat -c '%U:%G' "$state/resource-pack") || die "cannot inspect resource-pack owner: $state"
  [[ "$owner" == rvb:rvb ]] || die "resource-pack must be owned by rvb:rvb: $state"
}

readonly_candidate_root() {
  local candidate_root=$1
  [[ "$candidate_root" == "$RVB_ROOT/releases/$RELEASE_ID" ]] || die 'candidate path is not the fixed release slot'
  [[ -d "$candidate_root" && ! -L "$candidate_root" ]] || die 'candidate must be a real directory'
  local resolved_parent resolved_candidate
  resolved_parent=$(realpath -e "$RVB_ROOT/releases") || die 'release root is unavailable'
  [[ "$resolved_parent" == "$RVB_ROOT/releases" ]] || die 'release root resolves outside /opt/rvb/releases'
  resolved_candidate=$(realpath -e "$candidate_root") || die 'candidate cannot be resolved'
  [[ "$resolved_candidate" == "$candidate_root" ]] || die 'candidate path is not immutable and canonical'
}

assert_release_directory() {
  local release_root=$1
  [[ "$release_root" == "$RVB_ROOT/releases/"* ]] || die 'release directory is outside /opt/rvb/releases'
  [[ -d "$release_root" && ! -L "$release_root" ]] || die 'release must be a real directory'
  local resolved_parent resolved_release
  resolved_parent=$(realpath -e "$RVB_ROOT/releases") || die 'release root is unavailable'
  [[ "$resolved_parent" == "$RVB_ROOT/releases" ]] || die 'release root resolves outside /opt/rvb/releases'
  resolved_release=$(realpath -e "$release_root") || die 'release cannot be resolved'
  [[ "$resolved_release" == "$release_root" ]] || die 'release path is not canonical'
}

verify_manifest() {
  local candidate_root=$1
  readonly_candidate_root "$candidate_root"
  [[ -f "$candidate_root/SHA256SUMS" && ! -L "$candidate_root/SHA256SUMS" ]] || die 'candidate is missing SHA256SUMS'
  declare -A listed=()
  local line hash relative
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || die 'SHA256SUMS contains a blank line'
    [[ "$line" =~ ^([a-f0-9]{64})\ \ ([A-Za-z0-9._/-]+)$ ]] || die 'SHA256SUMS contains an unsafe entry'
    hash=${BASH_REMATCH[1]}
    relative=${BASH_REMATCH[2]}
    [[ "$relative" != /* && "$relative" != *'\'* ]] || die 'SHA256SUMS contains an absolute or backslash path'
    [[ "$relative" != *'//' && "$relative" != ./* && "$relative" != */./* && "$relative" != */../* && "$relative" != ../* ]] || die 'SHA256SUMS contains traversal'
    [[ "$relative" != SHA256SUMS ]] || die 'SHA256SUMS must not list itself'
    [[ -z "${listed[$relative]+present}" ]] || die "duplicate manifest path: $relative"
    listed["$relative"]=$hash
  done < "$candidate_root/SHA256SUMS"
  ((${#listed[@]} > 0)) || die 'SHA256SUMS is empty'

  declare -A observed=()
  local absolute
  while IFS= read -r -d '' absolute; do
    die "candidate contains a symbolic link: ${absolute#"$candidate_root"/}"
  done < <(find -P "$candidate_root" -mindepth 1 -type l -print0)
  while IFS= read -r -d '' absolute; do
    relative=${absolute#"$candidate_root"/}
    [[ "$relative" == SHA256SUMS || -n "${listed[$relative]+present}" ]] || die "unlisted candidate file: $relative"
    [[ "$relative" != SHA256SUMS ]] && observed["$relative"]=1
  done < <(find -P "$candidate_root" -mindepth 1 -type f -print0)
  ((${#observed[@]} == ${#listed[@]})) || die 'SHA256SUMS does not cover the complete candidate'
  for relative in "${!listed[@]}"; do
    [[ -n "${observed[$relative]+present}" ]] || die "manifest file is missing: $relative"
  done
  (cd "$candidate_root" && sha256sum --check --strict SHA256SUMS >/dev/null) || die 'candidate checksum verification failed'
  for relative in build.json install-profile.mjs "$GAME_ENTRY" "$OFFICIAL_ENTRY" content.rvbpack config/content-script-publishers.json; do
    [[ -f "$candidate_root/$relative" && ! -L "$candidate_root/$relative" ]] || die "candidate is missing required file: $relative"
  done
  while IFS= read -r -d '' absolute; do
    [[ "$(stat -c '%a' "$absolute")" == 755 ]] || die "candidate directory must be mode 755: ${absolute#"$candidate_root"/}"
  done < <(find -P "$candidate_root" -type d -print0)
  while IFS= read -r -d '' absolute; do
    [[ "$(stat -c '%a' "$absolute")" == 644 ]] || die "candidate file must be mode 644: ${absolute#"$candidate_root"/}"
  done < <(find -P "$candidate_root" -type f -print0)
}

verify_build_metadata() {
  local candidate_root=$1
  local metadata
  metadata=$("$NODE" --input-type=module - "$candidate_root/build.json" "$EXPECTED_COMMIT" <<'NODE'
import fs from 'node:fs'
const file = process.argv[2]
const expected = process.argv[3]
let value
try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { process.exit(2) }
const commit = typeof value.sourceHead === 'string' ? value.sourceHead : value.commit
if (value.dirty !== false || commit !== expected || value.nodeMajor !== undefined && value.nodeMajor !== 24) process.exit(1)
process.stdout.write('ok')
NODE
) || die 'candidate build.json is dirty, unpinned, or not Node 24'
  [[ "$metadata" == ok ]] || die 'candidate build metadata did not verify'
}

unit_exec_start() {
  systemctl show "$1" --property=ExecStart --value || die "cannot inspect $1 ExecStart"
}

assert_current_link_and_unit() {
  local link=$1 unit=$2 entry=$3 expected_root=$4
  [[ -L "$link" ]] || die "$link is not a managed symlink"
  [[ "$(realpath -e "$link")" == "$expected_root" ]] || die "$link does not point to the expected previous release"
  local command
  command=$(unit_exec_start "$unit")
  [[ "$command" == *"$NODE"* && "$command" == *"$link/$entry"* ]] || die "$unit ExecStart does not use the managed runtime link"
}

assert_service_stopped() {
  local unit=$1
  if systemctl is-active --quiet "$unit"; then die "$unit did not stop"; fi
}

json_field() {
  local payload=$1 field=$2
  printf '%s' "$payload" | "$NODE" --input-type=module -e '
let source = ""; for await (const chunk of process.stdin) source += chunk;
const value = JSON.parse(source); let current = value;
for (const part of process.argv[1].split(".")) current = current?.[part];
if (current === undefined || current === null) process.exit(1);
process.stdout.write(typeof current === "string" ? current : JSON.stringify(current));
' "$field"
}

assert_empty_rooms() {
  local payload=$1 label=$2
  printf '%s' "$payload" | "$NODE" --input-type=module -e '
let source = ""; for await (const chunk of process.stdin) source += chunk;
const value = JSON.parse(source); if (!Array.isArray(value.rooms) || value.rooms.length !== 0) process.exit(1);
' || die "$label returned non-empty or invalid rooms"
}

assert_health_ready() {
  local payload=$1 label=$2
  if ! health_ready "$payload"; then
    die "$label healthz is not ready"
  fi
}

health_ready() {
  local payload=$1
  RVB_HEALTH_PAYLOAD=$payload "$NODE" --input-type=module <<'NODE'
const value = JSON.parse(process.env.RVB_HEALTH_PAYLOAD)
if (value.ok !== true) process.exit(1)
NODE
}

assert_catalog_identity() {
  local payload=$1 label=$2 expected_hash=$3 expected_authority=$4
  if ! catalog_identity_matches "$payload" "$expected_hash" "$expected_authority"; then
    die "$label catalog identity did not match the expected profile"
  fi
}

catalog_identity_matches() {
  local payload=$1 expected_hash=$2 expected_authority=$3
  RVB_IDENTITY_PAYLOAD=$payload RVB_EXPECTED_HASH=$expected_hash RVB_EXPECTED_AUTHORITY=$expected_authority "$NODE" --input-type=module <<'NODE'
const value = JSON.parse(process.env.RVB_IDENTITY_PAYLOAD)
const identity = value.profileIdentity
if (!identity || identity.resolvedProfileHash !== process.env.RVB_EXPECTED_HASH || identity.authorityContentHash !== process.env.RVB_EXPECTED_AUTHORITY) process.exit(1)
NODE
}

http_json() {
  curl --fail --silent --show-error --max-time 10 -H 'Accept: application/json' "$1"
}

probe_service() {
  local port=$1 label=$2 expected_hash=$3 expected_authority=$4
  local health identity normal pve
  health=$(http_json "http://127.0.0.1:$port/healthz")
  assert_health_ready "$health" "$label"
  identity=$(http_json "http://127.0.0.1:$port/catalog/identity")
  assert_catalog_identity "$identity" "$label" "$expected_hash" "$expected_authority"
  normal=$(http_json "http://127.0.0.1:$port/rooms")
  assert_empty_rooms "$normal" "$label normal rooms"
  pve=$(http_json "http://127.0.0.1:$port/rooms?mode=pve")
  assert_empty_rooms "$pve" "$label pve rooms"
}

probe_both_services() {
  local expected_hash=$1 expected_authority=$2
  probe_service "$GAME_PORT" game "$expected_hash" "$expected_authority"
  probe_service "$OFFICIAL_PORT" official "$expected_hash" "$expected_authority"
}

probe_service_ready_once() {
  local port=$1 expected_hash=$2 expected_authority=$3
  local health identity
  health=$(http_json "http://127.0.0.1:$port/healthz") || return 1
  health_ready "$health" || return 1
  identity=$(http_json "http://127.0.0.1:$port/catalog/identity") || return 1
  catalog_identity_matches "$identity" "$expected_hash" "$expected_authority" || return 1
}

probe_both_services_ready_once() {
  local expected_hash=$1 expected_authority=$2
  probe_service_ready_once "$GAME_PORT" "$expected_hash" "$expected_authority" || return 1
  probe_service_ready_once "$OFFICIAL_PORT" "$expected_hash" "$expected_authority" || return 1
}

panel_request() {
  local method=$1 endpoint=$2 body=${3:-}
  local panel_url
  [[ -f "$PANEL_URL_FILE" && ! -L "$PANEL_URL_FILE" ]] || die 'official control-panel.url must be a regular file'
  panel_url=$(<"$PANEL_URL_FILE") || die 'cannot read official control-panel.url'
  RVB_PANEL_URL=$panel_url RVB_PANEL_METHOD=$method RVB_PANEL_ENDPOINT=$endpoint RVB_PANEL_BODY=$body "$NODE" --input-type=module <<'NODE'
const panel = new URL(process.env.RVB_PANEL_URL)
if (panel.protocol !== 'http:' || panel.hostname !== '127.0.0.1' || !/^\d+$/.test(panel.port) || !/^[A-Za-z0-9_-]{32,128}$/.test(panel.hash.slice(1))) process.exit(2)
const origin = panel.origin
const request = {
  method: process.env.RVB_PANEL_METHOD,
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${panel.hash.slice(1)}`,
    Origin: origin,
    ...(process.env.RVB_PANEL_METHOD === 'POST' ? { 'Content-Type': 'application/json' } : {}),
  },
  ...(process.env.RVB_PANEL_METHOD === 'POST' ? { body: process.env.RVB_PANEL_BODY } : {}),
  signal: AbortSignal.timeout(10000),
}
const response = await fetch(new URL(process.env.RVB_PANEL_ENDPOINT, `${origin}/`), request)
if (!response.ok) process.exit(1)
let value
try { value = await response.json() } catch { process.exit(1) }
process.stdout.write(JSON.stringify(value))
NODE
}

panel_snapshot() {
  panel_request GET /api/snapshot
}

panel_maintenance() {
  local value=$1
  local body
  body=$(RVB_RELEASE_ID=$RELEASE_ID "$NODE" --input-type=module -e '
const value = process.argv[1]; const release = process.env.RVB_RELEASE_ID;
process.stdout.write(JSON.stringify({ action: "maintenance", value, reason: `RED-245 release ${release}` }));
' "$value") || return 1
  panel_request POST /api/action "$body" >/dev/null || return 1
}

assert_snapshot() {
  local snapshot=$1 expected_maintenance=$2
  if ! snapshot_matches "$snapshot" "$expected_maintenance"; then
    die 'control panel snapshot is not in the expected idle state'
  fi
}

snapshot_matches() {
  local snapshot=$1 expected_maintenance=$2
  local maintenance active queued
  maintenance=$(json_field "$snapshot" settings.maintenance) || return 1
  active=$(json_field "$snapshot" counts.active) || return 1
  queued=$(json_field "$snapshot" counts.queued) || return 1
  [[ "$maintenance" == "$expected_maintenance" && "$active" == 0 && "$queued" == 0 ]]
}

wait_for_services_ready() {
  local expected_hash=$1 expected_authority=$2
  local attempt snapshot
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if probe_both_services_ready_once "$expected_hash" "$expected_authority" \
      && snapshot=$(panel_request GET /api/snapshot) \
      && snapshot_matches "$snapshot" true; then
      return 0
    fi
    sleep 1
  done
  return 1
}

assert_db_idle() {
  local status
  status=$(sudo -u postgres psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DATABASE" -c \
    "SELECT (SELECT count(*)::int FROM official_matches WHERE status='assigned') || '|' || (SELECT count(*)::int FROM official_queue WHERE seen_at>now()-interval '20 seconds');") \
    || die 'database idle query failed'
  status=${status//$'\r'/}
  status=${status//$'\n'/}
  [[ "$status" == '0|0' ]] || die "database is not idle: $status"
}

assert_authority_rooms_idle() {
  local database=$1 status
  status=$(sudo -u postgres psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$database" -c \
    "SELECT count(*)::int FROM battle_room_authority WHERE terminal IS NOT TRUE;") \
    || die "authority room idle query failed for $database"
  status=${status//$'\r'/}
  status=${status//$'\n'/}
  [[ "$status" == 0 ]] || die "database has non-terminal authority rooms: $database ($status)"
}

assert_complete_activation_evidence() {
  # The current approved read-only controls do not expose a trustworthy
  # ordinary-game ingress fence or the canonical durable PVE lease aggregate.
  # Never turn an empty public room listing into an activation decision.  Keep
  # this explicit blocker until operations supplies an existing audited
  # evidence source; do not replace it with an operator checkbox or a new API.
  die 'automatic activation blocked: ordinary game ingress freeze and durable PVE lease evidence are unavailable'
}

backup_before_stop() {
  local backup_root=/var/backups/rvb/RED-245-$(date -u +%Y%m%dT%H%M%SZ)-$$
  mkdir -p "$backup_root" || die 'cannot create the RED-245 evidence directory'
  chmod 700 "$backup_root" || die 'cannot protect the RED-245 evidence directory'
  sudo -u postgres pg_dump -Fc "$DATABASE" > "$backup_root/database.dump.tmp" || die 'database backup failed'
  mv -f "$backup_root/database.dump.tmp" "$backup_root/database.dump" || die 'database backup commit failed'
  for state in "$GAME_STATE" "$OFFICIAL_STATE"; do
    [[ -d "$state/resource-pack" && ! -L "$state/resource-pack" ]] || die "missing resource-pack state: $state"
  done
  tar -C "$GAME_STATE" -czf "$backup_root/game-resource-pack.tar.gz.tmp" resource-pack || die 'game resource state backup failed'
  mv -f "$backup_root/game-resource-pack.tar.gz.tmp" "$backup_root/game-resource-pack.tar.gz" || die 'game resource backup commit failed'
  tar -C "$OFFICIAL_STATE" -czf "$backup_root/official-resource-pack.tar.gz.tmp" resource-pack || die 'official resource state backup failed'
  mv -f "$backup_root/official-resource-pack.tar.gz.tmp" "$backup_root/official-resource-pack.tar.gz" || die 'official resource backup commit failed'
  printf 'Evidence backup: %s\n' "$backup_root"
}

profile_command() {
  local command=$1 state_root=$2
  sudo -u rvb -- "$NODE" "$CANDIDATE_ROOT/install-profile.mjs" "$command" \
    --app-root "$CANDIDATE_ROOT" --state-root "$state_root" "${@:3}"
}

profile_install() {
  local state_root=$1
  # The canonical helper may commit before stdout is read.  Mark the state
  # dirty before invocation so an output/transport failure still rolls back.
  if [[ "$state_root" == "$GAME_STATE" ]]; then GAME_PROFILE_CHANGED=1; else OFFICIAL_PROFILE_CHANGED=1; fi
  local output
  output=$(profile_command install "$state_root" --archive "$CANDIDATE_ROOT/content.rvbpack" \
    --expected-stable "$EXPECTED_OLD_PROFILE" --expected-new "$EXPECTED_NEW_PROFILE" \
    --expected-package "$EXPECTED_PACKAGE_HASH") || die "profile install failed for $state_root"
  local stable previous
  stable=$(json_field "$output" stable.resolvedProfileHash) || die "profile helper returned invalid identity for $state_root"
  previous=$(json_field "$output" previousStable.resolvedProfileHash) || die "profile helper returned no previous identity for $state_root"
  [[ "$stable" == "$EXPECTED_NEW_PROFILE" && "$previous" == "$EXPECTED_OLD_PROFILE" ]] || die "profile install identity mismatch for $state_root"
}

profile_rollback() {
  local state_root=$1
  local output stable previous
  if ! output=$(profile_command inspect "$state_root"); then
    # A failed install can leave a canonical activation journal after the
    # helper has already stopped.  The rollback command is the only allowed
    # recovery writer; after it runs, prove that the desired old stable is
    # readable before allowing service restart.
    profile_command rollback "$state_root" --expected-stable "$EXPECTED_NEW_PROFILE" \
      --expected-previous "$EXPECTED_OLD_PROFILE" >/dev/null || return 1
    output=$(profile_command inspect "$state_root") || return 1
    stable=$(json_field "$output" stable.resolvedProfileHash) || return 1
    [[ "$stable" == "$EXPECTED_OLD_PROFILE" ]] || return 1
    return 0
  fi
  stable=$(json_field "$output" stable.resolvedProfileHash) || return 1
  if [[ "$stable" == "$EXPECTED_OLD_PROFILE" ]]; then
    return 0
  fi
  [[ "$stable" == "$EXPECTED_NEW_PROFILE" ]] || return 1
  previous=$(json_field "$output" previousStable.resolvedProfileHash) || return 1
  [[ "$previous" == "$EXPECTED_OLD_PROFILE" ]] || return 1
  output=$(profile_command rollback "$state_root" --expected-stable "$EXPECTED_NEW_PROFILE" \
    --expected-previous "$EXPECTED_OLD_PROFILE") || return 1
  stable=$(json_field "$output" stable.resolvedProfileHash) || return 1
  previous=$(json_field "$output" previousStable.resolvedProfileHash) || return 1
  [[ "$stable" == "$EXPECTED_OLD_PROFILE" && "$previous" == "$EXPECTED_NEW_PROFILE" ]]
}

inspect_profile() {
  local state_root=$1 expected=$2 output stable
  output=$(profile_command inspect "$state_root" --expected-stable "$expected") || die "profile state inspection failed for $state_root"
  stable=$(json_field "$output" stable.resolvedProfileHash) || die "profile state inspection returned invalid identity for $state_root"
  [[ "$stable" == "$expected" ]] || die "profile state identity mismatch for $state_root"
  local authority
  authority=$(json_field "$output" stable.authorityContentHash) || die "profile state inspection returned no authority identity for $state_root"
  if [[ "$expected" == "$EXPECTED_OLD_PROFILE" ]]; then
    if [[ -z "$OLD_AUTHORITY" ]]; then OLD_AUTHORITY=$authority; else [[ "$OLD_AUTHORITY" == "$authority" ]] || die 'game and official old authority identities differ'; fi
  fi
}

atomic_link_update() {
  local link=$1 target=$2 temporary="${link}.red245-tmp-$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || die "temporary link already exists: $temporary"
  ln -s "$target" "$temporary" || die "cannot stage link $link"
  mv -Tf "$temporary" "$link" || die "cannot atomically update $link"
}

restore_old_links() {
  atomic_link_update "$GAME_LINK" "$OLD_ROOT"
  atomic_link_update "$OFFICIAL_LINK" "$OLD_ROOT"
}

stop_services() {
  SERVICES_STOPPED=1
  systemctl stop "$GAME_UNIT" "$OFFICIAL_UNIT" || return 1
  assert_service_stopped "$GAME_UNIT"
  assert_service_stopped "$OFFICIAL_UNIT"
}

start_services() {
  systemctl start "$GAME_UNIT" "$OFFICIAL_UNIT" || return 1
  SERVICES_STOPPED=0
}

restore_maintenance_after_verified_services() {
  [[ "$MAINTENANCE_STARTED" == 1 ]] || return 0
  if [[ "$ORIGINAL_MAINTENANCE" == false ]]; then
    panel_maintenance off || return 1
    local snapshot
    snapshot=$(panel_snapshot) || return 1
    snapshot_matches "$snapshot" false || return 1
  else
    local snapshot
    snapshot=$(panel_snapshot) || return 1
    snapshot_matches "$snapshot" true || return 1
  fi
  MAINTENANCE_STARTED=0
}

rollback_after_failure() {
  [[ "$ROLLING_BACK" == 0 ]] || return 0
  ROLLING_BACK=1
  set +e
  local ok=1
  # Always stop both units before changing either the release links or the
  # canonical profile pointers.  A partially stopped service is never
  # allowed to race with rollback.
  systemctl stop "$GAME_UNIT" "$OFFICIAL_UNIT" >/dev/null 2>&1 || ok=0
  systemctl is-active --quiet "$GAME_UNIT" && ok=0
  systemctl is-active --quiet "$OFFICIAL_UNIT" && ok=0
  if [[ "$ok" == 1 && "$LINKS_CHANGED" == 1 ]]; then restore_old_links || ok=0; fi
  if [[ "$ok" == 1 && "$GAME_PROFILE_CHANGED" == 1 ]]; then profile_rollback "$GAME_STATE" || ok=0; fi
  if [[ "$ok" == 1 && "$OFFICIAL_PROFILE_CHANGED" == 1 ]]; then profile_rollback "$OFFICIAL_STATE" || ok=0; fi
  if [[ "$ok" == 1 ]] && start_services; then
    if ! wait_for_services_ready "$EXPECTED_OLD_PROFILE" "$OLD_AUTHORITY" \
      || ! probe_both_services "$EXPECTED_OLD_PROFILE" "$OLD_AUTHORITY"; then
      ok=0
    fi
  elif [[ "$ok" == 1 ]]; then
    ok=0
  fi
  if [[ "$ok" == 1 ]]; then
    if ! restore_maintenance_after_verified_services; then ok=0; fi
  else
    printf 'Maintenance remains enabled; old service verification failed.\n' >&2
  fi
  set -e
  return "$((ok == 1 ? 0 : 1))"
}

on_exit() {
  local status=$?
  if [[ "$status" -ne 0 && "$DEPLOY_SUCCEEDED" == 0 && "$MAINTENANCE_STARTED" == 1 ]]; then
    if [[ "$CUTOVER_STARTED" == 1 ]]; then
      rollback_after_failure || true
    else
      # Before the first stop the live services and any active match remain
      # authoritative.  Only undo the audited maintenance switch; never stop
      # or rewrite a running service while a preflight/backup gate failed.
      restore_maintenance_after_verified_services || printf 'Maintenance remains enabled; pre-cutover cleanup failed.\n' >&2
    fi
  fi
  if [[ "$status" -ne 0 ]]; then
    printf 'RED-245 deployment stopped; inspect service state and retain maintenance if reported.\n' >&2
  fi
  exit "$status"
}
trap on_exit EXIT

parse_args "$@"
assert_runtime
exec 9>"$LOCK_FILE"
flock -n 9 || die 'another RED-245 deployment is already running'

CANDIDATE_ROOT="$RVB_ROOT/releases/$RELEASE_ID"
OLD_ROOT="$RVB_ROOT/releases/$PREVIOUS_RELEASE_ID"
assert_release_directory "$OLD_ROOT"
verify_manifest "$CANDIDATE_ROOT"
verify_build_metadata "$CANDIDATE_ROOT"

assert_current_link_and_unit "$GAME_LINK" "$GAME_UNIT" "$GAME_ENTRY" "$OLD_ROOT"
assert_current_link_and_unit "$OFFICIAL_LINK" "$OFFICIAL_UNIT" "$OFFICIAL_ENTRY" "$OLD_ROOT"
assert_service_account "$GAME_UNIT"
assert_service_account "$OFFICIAL_UNIT"
assert_profile_ownership "$GAME_STATE"
assert_profile_ownership "$OFFICIAL_STATE"

inspect_profile "$GAME_STATE" "$EXPECTED_OLD_PROFILE"
inspect_profile "$OFFICIAL_STATE" "$EXPECTED_OLD_PROFILE"
[[ -n "$OLD_AUTHORITY" ]] || die 'old authority identity is unavailable'
probe_both_services "$EXPECTED_OLD_PROFILE" "$OLD_AUTHORITY"

[[ -f "$PANEL_URL_FILE" && ! -L "$PANEL_URL_FILE" ]] || die 'official control-panel.url must be a regular file'
PANEL_URL=$(<"$PANEL_URL_FILE")
[[ "$PANEL_URL" =~ ^http://127\.0\.0\.1:[0-9]+/#([A-Za-z0-9_-]{32,128})$ ]] || die 'official control-panel.url is not a loopback token URL'
snapshot=$(panel_snapshot) || die 'official control panel snapshot failed'
ORIGINAL_MAINTENANCE=$(json_field "$snapshot" settings.maintenance) || die 'cannot read original maintenance state'
[[ "$ORIGINAL_MAINTENANCE" == true || "$ORIGINAL_MAINTENANCE" == false ]] || die 'invalid original maintenance state'
if [[ "$ORIGINAL_MAINTENANCE" == false ]]; then
  MAINTENANCE_STARTED=1
  panel_maintenance on || die 'official maintenance on action failed'
fi
MAINTENANCE_STARTED=1
snapshot=$(panel_snapshot) || die 'official control panel snapshot failed after maintenance on'
assert_snapshot "$snapshot" true
probe_both_services "$EXPECTED_OLD_PROFILE" "$OLD_AUTHORITY"
assert_db_idle
assert_authority_rooms_idle "$GAME_DATABASE"
assert_authority_rooms_idle "$DATABASE"
assert_complete_activation_evidence
backup_before_stop

CUTOVER_STARTED=1
stop_services || die 'could not stop both game and official services'
profile_install "$GAME_STATE"
profile_install "$OFFICIAL_STATE"

LINKS_CHANGED=1
atomic_link_update "$GAME_LINK" "$CANDIDATE_ROOT"
atomic_link_update "$OFFICIAL_LINK" "$CANDIDATE_ROOT"
start_services || die 'could not start both game and official services'

NEW_AUTHORITY=$(json_field "$(profile_command inspect "$GAME_STATE" --expected-stable "$EXPECTED_NEW_PROFILE")" stable.authorityContentHash) || die 'new profile authority identity unavailable'
wait_for_services_ready "$EXPECTED_NEW_PROFILE" "$NEW_AUTHORITY" || die 'services did not become ready within the bounded startup window'
probe_both_services "$EXPECTED_NEW_PROFILE" "$NEW_AUTHORITY"
[[ "$(realpath -e "$GAME_LINK")" == "$CANDIDATE_ROOT" && "$(realpath -e "$OFFICIAL_LINK")" == "$CANDIDATE_ROOT" ]] || die 'active release links changed unexpectedly'
snapshot=$(panel_snapshot) || die 'official control panel snapshot failed after candidate start'
assert_snapshot "$snapshot" true
restore_maintenance_after_verified_services
DEPLOY_SUCCEEDED=1
printf 'RED-245 deployment verified: %s\n' "$RELEASE_ID"
