#!/usr/bin/env bash
# start-all.sh — Start all Stexio services in parallel
# Usage: bash start-all.sh
# Ctrl+C stops all processes

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

cleanup() {
  echo -e "\n${YELLOW}Stopping all services...${NC}"
  # Remove traps to prevent recursive execution
  trap - INT TERM EXIT
  pids=$(jobs -p)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
  fi
  # Send SIGTERM to the entire process group to catch children (like node/pnpm)
  kill 0 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${BOLD}Starting Stexio services...${NC}"
echo ""

# Proxy — port 3006
(pnpm --filter=proxy dev 2>&1 | while IFS= read -r line; do
  echo -e "${GREEN}[proxy]${NC} $line"
done) &

# App (frontend) — port 3000
(pnpm --filter=app dev 2>&1 | while IFS= read -r line; do
  echo -e "${YELLOW}[app]${NC} $line"
done) &

# Test client — port 3001
(pnpm --filter=stexio-test-client dev -p 3001 2>&1 | while IFS= read -r line; do
  echo -e "${CYAN}[test-client]${NC} $line"
done) &

echo -e "${GREEN}proxy${NC}       → http://localhost:3006"
echo -e "${YELLOW}app${NC}         → http://localhost:3000"
echo -e "${CYAN}test-client${NC} → http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop all services"

wait
