set -eu
action=$1
service=$2
database=$3
release=$4
case "$service" in rvb-game|rvb-relay|rvb-official) ;; *) exit 2;; esac
base=/opt/rvb
case "$action" in backup|prepare|verify|activate)
  exec 9>/var/lock/rvb-admin.lock
  flock -n 9 || { echo '另一个管理操作正在进行'; exit 1; }
esac
case "$service" in
  rvb-game) link=$base/current; entry=colyseus-server.mjs; port=2567 ;;
  rvb-relay) link=$base/relay-current; entry=relay.mjs; port=8080 ;;
  rvb-official) link=$base/official-current; entry=official-server.mjs; port=2568 ;;
esac
backup() {
  mkdir -p /var/backups/rvb
  chmod 700 /var/backups/rvb
  file=/var/backups/rvb/${database}-$(date -u +%Y%m%dT%H%M%S)-$$.dump
  if runuser -u postgres -- pg_dump -Fc "$database" > "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "数据库备份：$file"
  else
    rm -f "$file.tmp"
    return 1
  fi
}
case "$action" in
 status)
  systemctl show "$service" --property=ActiveState,SubState,MainPID,WorkingDirectory
  echo "当前版本：$(readlink -f "$link" || true)"
  df -h /opt/rvb
  echo '可用版本：'
  find /opt/rvb/releases -mindepth 1 -maxdepth 1 -type d -printf '%f\n'
  ;;
 logs) journalctl -u "$service" -n 150 --no-pager -o short-iso ;;
 backup) backup ;;
 prepare)
  mkdir -p "$base/releases"
  mkdir "$base/releases/$release"
  ;;
 verify)
  cd "$base/releases/$release"
  sha256sum --check --strict SHA256SUMS >/dev/null
  test -f "$entry"
  echo '版本文件校验通过'
  ;;
 activate)
  # Only managed symlinks may switch. Never rewrite an existing unit or directory.
  test -L "$link" || { echo '服务尚未采用版本链接，请先完成一次部署配置。'; exit 1; }
  unit=$(systemctl show "$service" --property=ExecStart --value)
  printf '%s' "$unit" | grep -F "$link/$entry " >/dev/null || { echo '服务启动路径与版本链接不匹配，未切换。'; exit 1; }
  target=$base/releases/$release
  test -d "$target"
  test ! -L "$target"
  cd "$target"
  sha256sum --check --strict SHA256SUMS >/dev/null
  test -f "$entry"
  previous=$(readlink -f "$link")
  case "$previous" in /opt/rvb/releases/*) ;; *) echo '旧版本不在版本目录，未切换'; exit 1;; esac
  switched=0
  success=0
  recover() {
    if [ "$success" = 0 ]; then
      systemctl stop "$service" || { echo '停止异常版本失败，请人工恢复服务。'; return; }
      if [ "$switched" = 1 ]; then ln -sfn "$previous" "$link"; fi
      if systemctl start "$service" && systemctl is-active --quiet "$service"; then
        echo '更新未完成，旧版本服务已重新启动；请检查建房联机。'
      else echo '恢复旧版本失败，请人工检查服务日志。'; fi
    fi
  }
  trap recover EXIT
  systemctl stop "$service"
  if [ "$service" != rvb-relay ]; then backup; fi
  ln -sfn "$target" "$link"
  switched=1
  systemctl start "$service"
  for attempt in $(seq 1 20); do
    if systemctl is-active --quiet "$service" && (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null; then
      success=1
      echo "已启用 $release；进程和监听端口正常。请继续验收建房联机。"
      exit 0
    fi
    sleep 1
  done
  exit 1
  ;;
 *) exit 2 ;;
esac
