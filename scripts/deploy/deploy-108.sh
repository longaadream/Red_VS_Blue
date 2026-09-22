set -eux
exec 9>/var/lock/rvb-admin.lock
flock -n 9
STAGING="$(dirname "$(realpath "$0")")"
TARGET_NAME="${1:?Usage: bash deploy.sh <target-name>}"
node=/opt/rvb/runtime/node-v24.21.0-linux-x64/bin/node
target="/opt/rvb/releases/$TARGET_NAME"
previous="$(readlink -f /opt/rvb/current)"
echo "Checking symlinks..."
test "$(readlink -f /opt/rvb/official-current)" = "$previous" || { echo "official-current != current"; exit 1; }
echo "Checking target directory..."
if [ -e "$target" ]; then
 if [ "$previous" = "$target" ]; then
  echo "Redeploying current version, will replace in-place"
  rm -rf "$target"
 else
  echo "Target already exists but not current: $target"
  exit 1
 fi
fi
check_idle() {
 echo "Checking idle state..."
 live=$(runuser -u postgres -- psql rvb_official -At -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM official_matches WHERE status='assigned') + (SELECT count(*) FROM official_queue WHERE seen_at>now()-interval '20 seconds')")
 test "$live" = 0 || { echo 'Active ranked matches or queue; refusing restart'; return 1; }
 for port in 2567 2568; do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
   for suffix in rooms 'rooms?mode=pve'; do curl -fsS "http://127.0.0.1:$port/$suffix" | "$node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const j=JSON.parse(s);if(!Array.isArray(j.rooms)||j.rooms.length)process.exit(1)})'; done
  else
   echo "Port $port not responding, skipping idle check"
  fi
 done
 if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
  curl -fsS http://127.0.0.1:8080/hosts | "$node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const j=JSON.parse(s);if(!Array.isArray(j.hosts)||j.hosts.length)process.exit(1)})'
 else
  echo "Port 8080 not responding, skipping idle check"
 fi
 echo "Idle check passed"
}
check_idle
echo "Creating target directory..."
mkdir "$target"
echo "Extracting server..."
tar -xzf "$STAGING/server.tar.gz" -C "$target"
cd "$target"
echo "Verifying checksums..."
sha256sum --check --strict SHA256SUMS >/dev/null
echo "Copying install files..."
echo "Copying install files..."
cp "$STAGING/install-profile.cjs" "$target/install-profile.cjs"
mkdir -p "$target/config"
cp "$STAGING/content-script-publishers.json" "$target/config/content-script-publishers.json"
cp "$STAGING/content.rvbpack" "$target/content.rvbpack"
echo "Regenerating checksums..."
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
chown -R rvb:rvb "$target"
echo "Creating backup directory..."
backup="/var/backups/rvb/$TARGET_NAME-$(date -u +%Y%m%dT%H%M%S)"
mkdir -m 700 "$backup"
echo "Saving service units..."
systemctl cat rvb-game rvb-official rvb-relay > "$backup/units.txt"
echo "Checking relay changes..."
echo "Checking relay changes..."
relay_changed=0
if [ -f "$target/relay.mjs" ]; then
 cp -a /opt/rvb/relay-v1/relay.mjs "$backup/relay.mjs"
 if ! cmp -s /opt/rvb/relay-v1/relay.mjs "$target/relay.mjs"; then relay_changed=1; fi
fi
echo "Stopping services..."
systemctl stop nginx
systemctl stop rvb-game rvb-official
test "$relay_changed" = 1 && systemctl stop rvb-relay
echo "Backing up database..."
db_fp_before=$(runuser -u postgres -- psql rvb_official -At -v ON_ERROR_STOP=1 -c "SELECT md5(string_agg(tableoid::regclass::text||':'||count(*),';' ORDER BY 1)) FROM information_schema.tables t JOIN LATERAL (SELECT count(*) FROM only information_schema.tables) _ ON true" 2>/dev/null || runuser -u postgres -- pg_dump --schema-only rvb_official | md5sum | awk '{print $1}')
runuser -u postgres -- pg_dump -Fc rvb_official > "$backup/rvb_official.pgdump"
echo "Installing resource pack..."
echo "Installing resource pack..."
if [ -d /var/lib/rvb ]; then
 APP_ROOT_DIR="$target" USER_DATA_DIR=/var/lib/rvb "$node" "$target/install-profile.cjs" "$target/content.rvbpack"
fi
if [ -d /var/lib/rvb-official ]; then
 APP_ROOT_DIR="$target" USER_DATA_DIR=/var/lib/rvb-official "$node" "$target/install-profile.cjs" "$target/content.rvbpack"
fi
echo "Updating symlinks..."
ln -sfn "$target" /opt/rvb/next
mv -Tf /opt/rvb/next /opt/rvb/current
ln -sfn "$target" /opt/rvb/official-current
echo "Updating relay if needed..."
if [ -f "$target/relay.mjs" ]; then
 cp -f "$target/relay.mjs" /opt/rvb/relay-v1/relay.mjs
fi
echo "Starting services..."
systemctl start rvb-game rvb-official
test "$relay_changed" = 1 && systemctl start rvb-relay
echo "Waiting for healthz..."
echo "Waiting for healthz..."
for attempt in $(seq 1 30); do
 ok=1
 for port in 2567 2568; do
  curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 || ok=0
 done
 test "$ok" = 1 && break
 sleep 2
done
test "$ok" = 1 || { echo 'Services failed healthz after 60s'; exit 1; }
echo "Verifying profile hashes..."
hash_2567=$("$node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.profileIdentity?.resolvedProfileHash||j.resolvedProfileHash||"")})' < <(curl -fsS "http://127.0.0.1:2567/catalog/identity"))
hash_2568=$("$node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.profileIdentity?.resolvedProfileHash||j.resolvedProfileHash||"")})' < <(curl -fsS "http://127.0.0.1:2568/catalog/identity"))
echo "Port 2567 hash: $hash_2567"
echo "Port 2568 hash: $hash_2568"
test -n "$hash_2567" || { echo "Port 2567 returned empty hash"; exit 1; }
test -n "$hash_2568" || { echo "Port 2568 returned empty hash"; exit 1; }
if [ "$hash_2567" != "$hash_2568" ]; then
 echo "Port hash mismatch: 2567=$hash_2567, 2568=$hash_2568"
 exit 1
fi
echo "Checking database fingerprint..."
echo "Checking database fingerprint..."
db_fp_after=$(runuser -u postgres -- psql rvb_official -At -v ON_ERROR_STOP=1 -c "SELECT md5(string_agg(tableoid::regclass::text||':'||count(*),';' ORDER BY 1)) FROM information_schema.tables t JOIN LATERAL (SELECT count(*) FROM only information_schema.tables) _ ON true" 2>/dev/null || runuser -u postgres -- pg_dump --schema-only rvb_official | md5sum | awk '{print $1}')
if [ "$db_fp_before" != "$db_fp_after" ]; then
 echo "WARNING: DB fingerprint changed during deploy (before=$db_fp_before after=$db_fp_after)"
fi
echo "Starting nginx..."
systemctl start nginx
echo "Deploy complete. Profile hash: $hash_2567"
