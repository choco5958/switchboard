#!/bin/sh
# Writes ~/.claude-ide/start-bridge.sh, which the mod and the IDE both call to
# make sure one bridge is running. Run again after moving the repo.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
DIR="$HOME/.claude-ide"
mkdir -p "$DIR"

cat > "$DIR/start-bridge.sh" <<EOF
#!/bin/sh
SOCK="\${CLAUDE_IDE_SOCKET:-\$HOME/.claude-ide/bridge.sock}"
healthy() { curl -sf --max-time 1 --unix-socket "\$SOCK" http://bridge/health >/dev/null 2>&1; }
healthy && exit 0
nohup "$NODE" "$REPO/bridge/server.ts" >> "\$HOME/.claude-ide/bridge.log" 2>&1 &
i=0
while [ \$i -lt 30 ]; do
  healthy && exit 0
  sleep 0.1
  i=\$((i + 1))
done
echo "bridge did not start; see ~/.claude-ide/bridge.log" >&2
exit 1
EOF
chmod +x "$DIR/start-bridge.sh"
echo "wrote $DIR/start-bridge.sh (node: $NODE, repo: $REPO)"
