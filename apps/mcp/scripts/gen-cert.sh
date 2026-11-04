#!/usr/bin/env bash
# Generate a self-signed TLS certificate and a bearer token for the MCP HTTP transport.
#
# Usage: gen-cert.sh <out-dir> <hostname-or-ip> [more hostnames/IPs...]
#   e.g. gen-cert.sh ~/.config/finance-mcp my-server my-server.lan 192.168.1.10
#
# Writes <out-dir>/server.crt, server.key (0600) and token (0600, only if missing).
# Copy server.crt to the agent host and trust it there; never copy server.key.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <out-dir> <hostname-or-ip> [more...]" >&2
  exit 1
fi

out="$1"; shift
mkdir -p "$out"
chmod 700 "$out"

san=""
for name in "$@"; do
  if [[ "$name" =~ ^[0-9.]+$ || "$name" == *:* ]]; then
    san+="IP:${name},"
  else
    san+="DNS:${name},"
  fi
done
san="${san%,}"

umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$out/server.key" -out "$out/server.crt" -days 825 \
  -subj "/CN=$1" \
  -addext "subjectAltName=${san}" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null
chmod 644 "$out/server.crt"

if [ ! -f "$out/token" ]; then
  openssl rand -hex 32 > "$out/token"
  echo "Generated new token: $out/token"
else
  echo "Kept existing token: $out/token"
fi

echo "Certificate: $out/server.crt (SAN: $san, valid 825 days)"
echo "Key:         $out/server.key"
openssl x509 -in "$out/server.crt" -noout -fingerprint -sha256
