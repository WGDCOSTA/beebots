#!/bin/sh
# Writes an OKX Agent Trade Kit profile for every supported slot, all on site "eea".
# They hold NO keys. The engine passes each bee's key from .env into that one CLI call's environment,
# which the kit gives precedence over the profile. So secrets live only in .env (hard rule 8).
# Safe to re-run: it only writes the file if it does not exist yet.
set -eu
dir="$HOME/.okx"
file="$dir/config.toml"
mkdir -p "$dir"
chmod 700 "$dir"
if [ -f "$file" ]; then
  echo "~/.okx/config.toml already exists; not touching it. Add [profiles.bee1] through [profiles.bee9] with site = \"eea\" if missing."
  exit 0
fi
umask 077
cat > "$file" <<'EOF'
# beebots: one profile per bee. No keys here; they come from .env at call time.
[profiles.bee1]
site = "eea"

[profiles.bee2]
site = "eea"

[profiles.bee3]
site = "eea"

[profiles.bee4]
site = "eea"

[profiles.bee5]
site = "eea"

[profiles.bee6]
site = "eea"

[profiles.bee7]
site = "eea"

[profiles.bee8]
site = "eea"

[profiles.bee9]
site = "eea"
EOF
echo "wrote ~/.okx/config.toml with profiles bee1 through bee9 (site eea, no keys)"
