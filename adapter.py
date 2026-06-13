"""
Keet platform adapter for Hermes Agent.

Connects to the Keet Bridge daemon via stdio JSON protocol and relays
messages between Keet contacts/rooms and the Hermes agent.
Bridge runs as a Pear Runtime app — uses Pear's shared DHT and storage.
"""

import asyncio
import json
import logging
import os
import pathlib
import shutil
from typing import Optional, Callable

logger = logging.getLogger(__name__)

try:
    from gateway.platforms.base import (
        BasePlatformAdapter,
        MessageEvent,
        SendResult,
        cache_image_from_url,
    )
    from gateway.config import PlatformConfig
    from gateway.session import SessionSource
except ImportError:
    # Allow standalone import for testing
    BasePlatformAdapter = object
    MessageEvent = object
    SendResult = object
    PlatformConfig = object
    SessionSource = object


PLATFORM = "keet"
HOME_CHANNEL_ENV = "KEET_HOME_CHANNEL"
ALLOWED_USERS_ENV = "KEET_ALLOWED_USERS"
ALLOW_ALL_ENV = "KEET_ALLOW_ALL_USERS"

# Welcome message sent to new contacts on first message
WELCOME_MESSAGE = (
    "Hello! You're now connected to the Hermes AI assistant. "
    "Feel free to ask me anything — I'm here to help."
)

# Plugin root directory — used for node_modules/.bin discovery
_PLUGIN_DIR = pathlib.Path(__file__).resolve().parent


def _add_bin_to_path() -> None:
    """Add the plugin's node_modules/.bin directory to PATH if present.

    This ensures locally-installed Pear and other Node.js tools
    can be found without a global install.
    """
    bin_dir = _PLUGIN_DIR / "node_modules" / ".bin"
    if bin_dir.is_dir():
        current_path = os.environ.get("PATH", "")
        bin_str = str(bin_dir)
        if bin_str not in current_path:
            os.environ["PATH"] = f"{bin_str}{os.pathsep}{current_path}"
            logger.debug("[Keet] Added %s to PATH", bin_str)


def _npm_cmd() -> str:
    """Resolve the npm command with a full path.

    Uses shutil.which() first, then checks common installation paths.
    Falls back to bare 'npm' (will fail at runtime if not on PATH).
    """
    npm = shutil.which("npm")
    if npm:
        return npm
    for p in ("/usr/local/bin/npm", "/usr/bin/npm", "/opt/homebrew/bin/npm"):
        if pathlib.Path(p).is_file():
            return p
    return "npm"


async def _ensure_node_deps() -> bool:
    """Install root-level npm dependencies (pear) if node_modules is missing.

    Returns True if dependencies are already installed or were installed
    successfully. Returns False on failure.
    """
    node_modules = _PLUGIN_DIR / "node_modules"
    if node_modules.is_dir():
        return True

    npm = _npm_cmd()
    logger.info("[Keet] Installing Node.js dependencies (%s install)...", npm)
    proc = await asyncio.create_subprocess_exec(
        npm, "install", "--ignore-scripts",
        cwd=str(_PLUGIN_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.error("[Keet] npm install failed: %s", stderr.decode()[:500])
        return False
    _add_bin_to_path()
    logger.info("[Keet] Node.js dependencies installed")
    return True


def _pear_cmd() -> list[str]:
    """Resolve the 'pear' command, searching in order:
    1. System PATH (shutil.which)
    2. Local node_modules/.bin
    3. Fallback: just 'pear' (trust it's on PATH at runtime)

    Returns e.g. ['/usr/local/bin/pear'] or ['node_modules/.bin/pear'] or ['pear'].
    """
    # 1. System PATH
    system_pear = shutil.which("pear")
    if system_pear:
        return [system_pear]

    # 2. Local node_modules
    local_pear = _PLUGIN_DIR / "node_modules" / ".bin" / "pear"
    if local_pear.is_file():
        return [str(local_pear)]

    # 3. Fallback
    return ["pear"]


class KeetAdapter(BasePlatformAdapter):
    """Adapter for Keet P2P messenger via the Keet Bridge daemon."""

    PLATFORM = PLATFORM

    def __init__(self, config: Optional["PlatformConfig"] = None, **kwargs):
        from gateway.config import Platform
        platform = Platform(PLATFORM)
        super().__init__(config=config, platform=platform, **kwargs)
        _add_bin_to_path()
        self._bridge_dir = self._detect_bridge_dir()
        self._process: Optional[asyncio.subprocess.Process] = None
        self._connected = False
        self._tasks: set = set()
        self._buffer = ""
        self._allowed_users = self._parse_allowed()
        self._home_channel = os.environ.get(HOME_CHANNEL_ENV, "").strip()
        self._bridge_public_key = ""
        self._welcome_room_key = ""
        self._dynamic_allowed: set[str] = set()
        self._welcomed_contacts: set = set()

    def _detect_bridge_dir(self) -> Optional[str]:
        """Locate the bridge directory relative to the plugin."""
        bridge_dir = _PLUGIN_DIR / "bridge"
        if bridge_dir.is_dir() and (bridge_dir / "package.json").exists():
            return str(bridge_dir)
        return None

    async def _ensure_bridge_deps(self) -> bool:
        """Run npm install if node_modules is missing in the bridge dir."""
        if not self._bridge_dir:
            return False
        node_modules = os.path.join(self._bridge_dir, "node_modules")
        if os.path.isdir(node_modules):
            return True
        logger.info("[Keet] Installing bridge dependencies (npm install)...")
        npm = _npm_cmd()
        proc = await asyncio.create_subprocess_exec(
            npm, "install", "--no-audit", "--no-fund",
            cwd=self._bridge_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            logger.error("[Keet] npm install failed: %s", stderr.decode()[:500])
            return False
        logger.info("[Keet] Bridge dependencies installed")
        return True

    def _parse_allowed(self) -> Optional[set]:
        raw = os.environ.get(ALLOWED_USERS_ENV, "").strip()
        if raw:
            return set(u.strip() for u in raw.split(",") if u.strip())
        return None

    def _allow_all(self) -> bool:
        return os.environ.get(ALLOW_ALL_ENV, "").lower() == "true"

    def _is_allowed(self, user_key: str) -> bool:
        if self._allow_all():
            return True
        # Check .env list
        if self._allowed_users is not None and user_key in self._allowed_users:
            return True
        # Check dynamic list
        if self._dynamic_allowed and user_key in self._dynamic_allowed:
            return True
        return False

    def _bridge_node_cmd(self) -> list[str]:
        """Build the Pear run command for the bridge.

        Uses _pear_cmd() to resolve the pear binary — supports
        global install, local node_modules, or fallback.
        """
        pear = _pear_cmd()
        if not self._bridge_dir:
            return pear + ["run", "index.js"]
        return pear + ["run", os.path.join(self._bridge_dir, "index.js")]

    async def connect(self) -> bool:
        """Connect to the Keet Bridge daemon.

        Ensures npm dependencies are installed before spawning the bridge.
        """
        if not await _ensure_node_deps():
            logger.error("[Keet] Node dependencies check failed")
            return False

        if not await self._ensure_bridge_deps():
            logger.error("[Keet] Bridge dependency check failed")
            return False

        try:
            await self._spawn_bridge()
            self._connected = True
            logger.info("[Keet] Adapter connected")
            return True
        except Exception as e:
            logger.error("[Keet] Failed to connect: %s", e)
            self._connected = False
            return False

    async def _spawn_bridge(self):
        """Spawn the Keet Bridge daemon via Pear Runtime."""
        cmd_parts = self._bridge_node_cmd()
        self._process = await asyncio.create_subprocess_exec(
            *cmd_parts,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._bridge_dir,
        )

        task = asyncio.create_task(self._read_bridge_output())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

        task_err = asyncio.create_task(self._read_bridge_stderr())
        self._tasks.add(task_err)
        task_err.add_done_callback(self._tasks.discard)

        logger.info("[Keet] Bridge spawned via Pear: %s", " ".join(cmd_parts))

    async def _read_bridge_output(self):
        """Read and process JSON lines from bridge stdout."""
        while self._process and self._process.stdout:
            try:
                line = await self._process.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                await self._handle_bridge_event(text)
            except Exception as e:
                logger.error("[Keet] Bridge read error: %s", e)
                break

    async def _read_bridge_stderr(self):
        """Log bridge stderr."""
        while self._process and self._process.stderr:
            try:
                line = await self._process.stderr.readline()
                if not line:
                    break
                logger.debug("[Keet] Bridge: %s", line.decode("utf-8", errors="replace").strip())
            except Exception:
                break

    async def _handle_bridge_event(self, line: str):
        """Process a JSON event from the bridge."""
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("[Keet] Invalid JSON: %s", line[:200])
            return

        event_type = event.get("type")
        logger.debug("[Keet] Event: %s", event_type)

        if event_type == "message":
            await self._on_message(event)
        elif event_type == "chat_list":
            logger.info("[Keet] Chats: %d", len(event.get("chats", [])))
        elif event_type == "error":
            logger.error("[Keet] Bridge error: %s", event.get("message", "?"))
        elif event_type == "send_result":
            logger.info("[Keet] Sent: seq=%s", event.get("seq"))
        elif event_type == "pong":
            logger.debug("[Keet] Bridge ping-pong ok")
        elif event_type == "identity":
            logger.info("[Keet] Bridge identity: %s", event.get("public_key", "?")[:16])
            self._bridge_public_key = event.get("public_key", "")
        elif event_type == "connect_result":
            logger.info("[Keet] Connected to peer: %s", event.get("pubkey", "?")[:16])
        elif event_type == "join_result":
            logger.info("[Keet] Joined room: %s", event.get("room_key", "?")[:16])
        elif event_type == "send_welcome_result":
            logger.info("[Keet] Welcome sent to %s: %s",
                        event.get("pubkey", "?")[:16], event.get("status", "?"))
        elif event_type == "welcome_room_ready":
            room_key = event.get("room_key", "")
            self._welcome_room_key = room_key
            logger.info("[Keet] Welcome room ready: %s", room_key[:16] if room_key else "?")

    async def _on_message(self, event: dict):
        """Handle an incoming message from Keet."""
        chat_id = event.get("chat_id", "")
        sender = event.get("from", "")
        text = event.get("text", "")
        ts = event.get("ts", 0)

        if not self._is_allowed(sender):
            logger.info("[Keet] Ignoring %s (unauthorized)", sender[:16])
            return

        # Ignore messages from self (loop prevention)
        if sender and sender == self._bridge_public_key:
            logger.debug("[Keet] Ignoring self-message from %s", sender[:16])
            return

        # Send welcome on first message from a new contact
        if sender not in self._welcomed_contacts:
            self._welcomed_contacts.add(sender)
            logger.info("[Keet] First contact from %s — sending welcome", sender[:16])
            await self.send(chat_id, WELCOME_MESSAGE)

        source = SessionSource(
            platform=PLATFORM,
            chat_id=chat_id,
            user_id=sender,
            thread_id=chat_id,
        )
        msg_event = MessageEvent(
            platform=PLATFORM,
            source=source,
            text=text,
            message_id=str(ts),
            timestamp=ts,
        )
        await self.on_message(msg_event)

    async def send(
        self,
        chat_id: str,
        text: str,
        reply_to_message_id: Optional[str] = None,
        **kwargs
    ) -> "SendResult":
        """Send a text message to a Keet room."""
        if not self._connected or not self._process:
            return SendResult(ok=False, error="Not connected")

        cmd = json.dumps({
            "command": "send_message",
            "chat_id": chat_id,
            "text": text,
        }) + "\n"

        if self._process.stdin:
            self._process.stdin.write(cmd.encode("utf-8"))
            await self._process.stdin.drain()
            return SendResult(ok=True)
        return SendResult(ok=False, error="No stdin")

    async def send_image(
        self,
        chat_id: str,
        url: str,
        caption: Optional[str] = None,
        **kwargs
    ) -> "SendResult":
        """Send an image to a Keet room."""
        if not self._connected or not self._process:
            return SendResult(ok=False, error="Not connected")

        cmd = json.dumps({
            "command": "send_image",
            "chat_id": chat_id,
            "path": url,
            "caption": caption or "",
        }) + "\n"

        if self._process.stdin:
            self._process.stdin.write(cmd.encode("utf-8"))
            await self._process.stdin.drain()
            return SendResult(ok=True)
        return SendResult(ok=False, error="No stdin")

    async def _send_command(self, cmd: dict) -> None:
        """Send a JSON command to the bridge stdin."""
        if not self._process or not self._process.stdin:
            return
        line = json.dumps(cmd) + "\n"
        self._process.stdin.write(line.encode("utf-8"))
        await self._process.stdin.drain()

    # ── Public API ────────────────────────────────────────────────────────

    def get_bridge_pubkey(self) -> str:
        """Return the bridge's full public key for contact discovery."""
        return self._bridge_public_key

    def get_welcome_room_key(self) -> str:
        """Return the welcome room key."""
        return self._welcome_room_key

    def add_allowed_user(self, pubkey: str) -> bool:
        """Add a pubkey to the in-memory allowed list.

        Does NOT persist to .env — only lasts while the adapter is running.
        Returns True if added, False if already present.
        """
        if pubkey in self._dynamic_allowed:
            return False
        self._dynamic_allowed.add(pubkey)
        logger.info("[Keet] Added dynamic allowed user: %s", pubkey[:16])
        return True

    def get_allowed_users(self) -> list[str]:
        """Return all allowed users from .env and dynamic list combined."""
        users: set[str] = set()
        if self._allowed_users:
            users.update(self._allowed_users)
        users.update(self._dynamic_allowed)
        return sorted(users)

    async def send_welcome(self, pubkey: str) -> bool:
        """Send a welcome message to a user by their public key."""
        await self._send_command({"command": "send_welcome", "pubkey": pubkey})
        return True

    async def get_identity(self) -> dict:
        """Request bridge identity info."""
        await self._send_command({"command": "get_identity"})
        return {}

    async def join_room(self, room_key: str) -> None:
        """Tell bridge to join a Keet room's swarm topic."""
        await self._send_command({"command": "join_room", "room_key": room_key})

    async def connect_to_user(self, pubkey: str, room_key: Optional[str] = None) -> None:
        """Tell bridge to connect to a user by their public key."""
        cmd = {"command": "connect_to_user", "pubkey": pubkey}
        if room_key:
            cmd["room_key"] = room_key
        await self._send_command(cmd)

    async def get_chat_info(self, chat_id: str) -> dict:
        """Return basic chat info."""
        return {"chat_id": chat_id, "type": "dm", "name": chat_id}

    async def disconnect(self):
        """Stop the bridge and disconnect."""
        self._connected = False
        if self._process and self._process.stdin:
            try:
                self._process.stdin.close()
            except Exception:
                pass
        if self._process:
            try:
                self._process.terminate()
                await self._process.wait()
            except Exception:
                pass
        for task in list(self._tasks):
            task.cancel()
        logger.info("[Keet] Disconnected")

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def cron_deliver_env_var(self) -> Optional[str]:
        return HOME_CHANNEL_ENV

    async def standalone_sender(self, chat_id: str, text: str, **kwargs) -> "SendResult":
        """Send a message without a running gateway (for cron delivery)."""
        return await self.send(chat_id, text, **kwargs)


# ── Requirements check ──────────────────────────────────────────────────

def check_requirements() -> bool:
    """Check that Pear Runtime is available.

    Checks both system PATH and local node_modules/.bin.
    """
    # Check system PATH
    if shutil.which("pear"):
        _check_pear_path()
        return True

    # Check local node_modules
    local_pear = _PLUGIN_DIR / "node_modules" / ".bin" / "pear"
    if local_pear.is_file():
        return True

    logger.error(
        "[Keet] Pear Runtime not found. "
        "Install: npm i -g pear, or run 'npm install' in plugin root."
    )
    return False


def _check_pear_path() -> None:
    """Check that Pear's own bin dir is on PATH (avoids startup warning)."""
    pear_bin = pathlib.Path.home() / ".config" / "pear" / "bin"
    if pear_bin.is_dir() and str(pear_bin) not in os.environ.get("PATH", ""):
        logger.warning(
            "[Keet] Pear bin dir (%s) not in PATH. "
            "Run 'pear run pear://runtime' to fix, "
            "or manually append it to your shell rc file.",
            pear_bin
        )


def validate_config(config: "PlatformConfig") -> bool:
    """Validate keet platform configuration."""
    ok = check_requirements()
    if not ok:
        logger.error(
            "[Keet] Validation failed — Pear Runtime is required. "
            "Install: npm i -g pear"
        )
    return ok


def is_connected(config: "PlatformConfig") -> bool:
    """Check if Pear Runtime is available — system or local."""
    if shutil.which("pear"):
        return True
    local_pear = _PLUGIN_DIR / "node_modules" / ".bin" / "pear"
    return local_pear.is_file()


def _env_enablement(config: "PlatformConfig") -> dict:
    """Load env vars from platform config section."""
    env = {}
    home = os.environ.get(HOME_CHANNEL_ENV, "")
    if not home:
        home = (config.extra or {}).get("home_channel", "")
    if home:
        env[HOME_CHANNEL_ENV] = home

    allowed = os.environ.get(ALLOWED_USERS_ENV, "")
    if not allowed:
        allowed = (config.extra or {}).get("allowed_users", "")
    if allowed:
        env[ALLOWED_USERS_ENV] = allowed

    return env


def _standalone_send(chat_id: str, text: str, **kwargs) -> dict:
    """Standalone sender for cron delivery."""
    adapter = KeetAdapter()
    result = asyncio.run(adapter.send(chat_id, text))
    return {"ok": result.ok, "error": result.error}


# ── Auto-install setup function ────────────────────────────────────────

def _setup_fn(config: "PlatformConfig") -> None:
    """Run the interactive setup script via setup.sh.

    Called by Hermes on 'hermes gateway setup' when setup_fn is configured.
    """
    import subprocess
    import sys
    import pathlib as _plib

    setup_script = _PLUGIN_DIR / "scripts" / "setup.sh"
    if not setup_script.is_file():
        logger.error("[Keet] setup.sh not found at %s", setup_script)
        print(f"Error: setup.sh not found at {setup_script}", file=sys.stderr)
        return

    logger.info("[Keet] Running setup script...")
    result = subprocess.run(
        ["bash", str(setup_script)],
        cwd=str(_PLUGIN_DIR),
    )
    if result.returncode != 0:
        logger.error("[Keet] Setup script failed (exit %d)", result.returncode)
    else:
        logger.info("[Keet] Setup completed successfully")


# ── Registration ────────────────────────────────────────────────────────

def register(ctx) -> None:
    """Plugin entry point — called by the Hermes plugin system at startup."""
    ctx.register_platform(
        name=PLATFORM,
        label="Keet",
        adapter_factory=lambda cfg: KeetAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[],
        install_hint=(
            "Requires Pear Runtime (npm i -g pear) and Node.js >= 20. "
            "Bridge is auto-detected and auto-started — no manual config needed."
        ),
        setup_fn=_setup_fn,
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var=HOME_CHANNEL_ENV,
        standalone_sender_fn=_standalone_send,
        allowed_users_env=ALLOWED_USERS_ENV,
        allow_all_env=ALLOW_ALL_ENV,
        max_message_length=4096,
        pii_safe=True,
        emoji="🔒",
        allow_update_command=True,
        platform_hint=(
            "You are communicating via Keet, a P2P encrypted messenger. "
            "Messages are end-to-end encrypted and sent directly peer-to-peer. "
            "Plain text only — markdown is not rendered."
        ),
    )
