#!/usr/bin/env bash
# install-all.sh — Install dependencies across the workspace and standalone folders

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${BOLD}Installing Stexio dependencies...${NC}"

# 1. Monorepo dependencies (pnpm installs apps/, packages/, and examples/)
echo -e "\n${GREEN}[workspace]${NC} Running pnpm install at root..."
pnpm install

echo -e "\n${BOLD}All dependencies installed successfully!${NC}"
