#!/bin/bash
# texgen.sh <name> <prompt> : one image via Codex ($imagegen skill), saved into game/public/tex/gen/<name>
OUT=/home/shikhar/Projects/samurai/game/public/tex/gen
name="$1"; prompt="$2"
[ -f "$OUT/$name" ] && { echo "skip $name"; exit 0; }
codex exec --skip-git-repo-check -s workspace-write -C "$OUT" -o "$OUT/.log_$name.txt" \
  "\$imagegen $prompt Then copy the generated PNG into the current directory as $name (keep the alpha channel if any). Do not create any other files." >/dev/null 2>&1
[ -f "$OUT/$name" ] && echo "ok $name" || echo "FAIL $name"
