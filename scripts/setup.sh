#!/usr/bin/env bash
# Keet Platform — auto-install script
# Run from plugin root or any cwd:  bash scripts/setup.sh
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Locate plugin root (directory containing this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

info "Keet Platform setup"
info "Plugin directory: $PLUGIN_DIR"
echo ""

# 1. Check Node.js
info "Checking Node.js..."
if ! command -v node &>/dev/null; then
    error "Node.js is required. Install Node.js >= 18:"
    error "  https://nodejs.org/en/download/"
    exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
info "Node.js $(node -v) found"
if [ "$NODE_VER" -lt 18 ]; then
    error "Node.js >= 18 required, found $(node -v)"
    exit 1
fi
echo ""

# 2. Check npm
info "Checking npm..."
if ! command -v npm &>/dev/null; then
    error "npm is required. Install Node.js (includes npm):"
    error "  https://nodejs.org/en/download/"
    exit 1
fi
info "npm $(npm -v) found"
echo ""

# 3. Check/Install Pear Runtime
info "Checking Pear Runtime..."
PEAR_FOUND=false
if command -v pear &>/dev/null; then
    info "Pear Runtime found: $(which pear)"
    PEAR_FOUND=true
elif [ -f "$PLUGIN_DIR/node_modules/.bin/pear" ]; then
    info "Pear Runtime found locally in node_modules"
    PEAR_FOUND=true
else
    warn "Pear Runtime not found."
    echo ""
    echo -e "${YELLOW}Pear Runtime can be installed automatically via npm.${NC}"
    read -r -p "Install Pear Runtime now? (Y/n): " CONFIRM
    CONFIRM="${CONFIRM:-Y}"
    if [[ "$CONFIRM" =~ ^[YyДд] ]]; then
        info "Installing Pear Runtime..."
        cd "$PLUGIN_DIR"
        npm install --ignore-scripts
        info "Pear Runtime installed locally in node_modules"
        PEAR_FOUND=true
    else
        warn "Skipping Pear Runtime installation."
        warn "The plugin will attempt to find 'pear' on PATH at runtime."
        echo ""
        warn "To install Pear manually:"
        warn "  cd $PLUGIN_DIR"
        warn "  npm install"
    fi
fi
echo ""

# 4. Install bridge dependencies
info "Setting up Keet Bridge..."
if [ -f "$PLUGIN_DIR/bridge/package.json" ]; then
    cd "$PLUGIN_DIR/bridge"
    if [ ! -d node_modules ]; then
        info "Installing bridge dependencies..."
        npm install --no-audit --no-fund
    else
        info "Bridge dependencies already installed"
    fi
else
    warn "Bridge package.json not found at $PLUGIN_DIR/bridge/"
fi
echo ""

# 5. Verify
info "Verifying installation..."
VERIFY_FAIL=0
if [ "$PEAR_FOUND" = true ]; then
    info "  ✓ Pear Runtime available"
else
    warn "  ✗ Pear Runtime not available"
    VERIFY_FAIL=1
fi
if [ -f "$PLUGIN_DIR/bridge/node_modules/.package-lock.json" ] || [ -d "$PLUGIN_DIR/bridge/node_modules" ]; then
    info "  ✓ Bridge dependencies installed"
else
    warn "  ✗ Bridge dependencies missing"
    VERIFY_FAIL=1
fi
echo ""

if [ "$VERIFY_FAIL" -eq 0 ]; then
    info "Setup completed successfully!"
    info "You can now enable the plugin:"
    info "  hermes plugins enable keet-platform"
    info "  hermes gateway restart"
else
    warn "Setup completed with warnings. Some features may not work."
fi
