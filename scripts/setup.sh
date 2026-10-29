#!/bin/sh
# For a run from the repo (pnpm dev): writes ~/.claude-ide/start-bridge.json and
# start-bridge.sh, which the mod, other CLIs and the IDE call to make sure one bridge
# runs (bridge/start.ts), and the switchboard command. The installed app writes its own
# at each start (src/main/runtime.ts). Run again after moving the repo.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
DIR="$HOME/.claude-ide"
mkdir -p "$DIR"
chmod 700 "$DIR"

"$NODE" -e '
const [dir, node, start] = process.argv.slice(1)
require("node:fs").writeFileSync(dir + "/start-bridge.json", JSON.stringify({ argv: [node, start], env: {} }, null, 2) + "\n", { mode: 0o600 })
' "$DIR" "$NODE" "$REPO/bridge/start.ts"

cat > "$DIR/start-bridge.sh" <<EOF2
#!/bin/sh
exec "$NODE" "$REPO/bridge/start.ts"
EOF2
chmod +x "$DIR/start-bridge.sh"
echo "wrote $DIR/start-bridge.json and start-bridge.sh (node: $NODE, repo: $REPO)"

# The switchboard command (scripts/switchboard.ts) for shells and scripts.
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
cat > "$BIN/switchboard" <<EOF2
#!/bin/sh
exec "$NODE" "$REPO/scripts/switchboard.ts" "\$@"
EOF2
chmod +x "$BIN/switchboard"
echo "wrote $BIN/switchboard"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "add $BIN to PATH to run switchboard from any folder" ;;
esac
