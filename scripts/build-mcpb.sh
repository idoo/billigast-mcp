#!/bin/sh
# Build the Claude Desktop bundle: dist/billigast-mcp-<version>.mcpb plus
# dist/billigast-mcp-<version>.mcpb.sha256.
#
# Bundle layout: manifest.json, LICENSE, server/billigast-mcp.js (the esbuild
# stdio bundle; Claude Desktop runs it with its own Node). The manifest's tool
# list is read from the built server over stdio, so new tools flow through.
#
# Usage: scripts/build-mcpb.sh   (version from package.json; needs node, npm ci done, jq)
set -eu

mcpb_cli_version=2.1.2

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
version=$(node -p 'require("./package.json").version')

npm run --silent build:stdio

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT INT TERM
mkdir -p "$stage/server"
cp dist/billigast-mcp.js "$stage/server/billigast-mcp.js"
cp LICENSE "$stage/"

node scripts/list-tools.mjs node dist/billigast-mcp.js >"$stage/tools.json"
jq --arg v "$version" --slurpfile tools "$stage/tools.json" '.version = $v | .tools = $tools[0]' \
	packaging/mcpb/manifest.json >"$stage/manifest.json"
rm "$stage/tools.json"

npx -y "@anthropic-ai/mcpb@$mcpb_cli_version" validate "$stage/manifest.json" >&2

out="$root/dist/billigast-mcp-$version.mcpb"
rm -f "$out" "$out.sha256"
npx -y "@anthropic-ai/mcpb@$mcpb_cli_version" pack "$stage" "$out" >&2
if command -v sha256sum >/dev/null 2>&1; then
	sum=$(sha256sum "$out" | awk '{ print $1 }')
else
	sum=$(shasum -a 256 "$out" | awk '{ print $1 }')
fi
# "<sha256>  <name>" so `sha256sum -c` works.
printf '%s  %s\n' "$sum" "billigast-mcp-$version.mcpb" >"$out.sha256"
echo "$out"
