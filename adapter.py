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


def _node_path_env() -> dict[str, str]:
    """Return env with PATH extended so node/npm are found in subprocesses.

    The gateway may have a stripped PATH; ensure common Node.js locations
    are included so npm's '#!env node' shebang works.
    """
    env = dict(os.environ)
    node_bin = os.path.dirname(
        shutil.which("node") or "/usr/local/bin/node"
    )
    extra_bins = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin"]
    path = env.get("PATH", "")
    path_parts = [p for p in path.split(os.pathsep) if p]
    for item in [node_bin] + extra_bins:
        if item and item not in path_parts:
            path_parts.append(item)
    env["PATH"] = os.pathsep.join(path_parts)
    return env


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
        env=_node_path_env(),
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
        self._bridge_ready = asyncio.Event()
        self._startup_stderr: list[str] = []
        self._last_invite_url: Optional[str] = None

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
            env=_node_path_env(),
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
        """Build the Node.js command for the bridge.

        Uses 'node' to run index.js directly — no Pear Runtime dependency.
        Falls back to 'pear run' if KEET_USE_PEAR env var is set.
        """
        if os.environ.get("KEET_USE_PEAR", "").lower() == "true":
            pear = _pear_cmd()
            if not self._bridge_dir:
                return pear + ["run", "index.js"]
            return pear + ["run", os.path.join(self._bridge_dir, "index.js")]
        # Default: run directly with Node.js
        node = (
            shutil.which("node")
            or os.environ.get("KEET_NODE_PATH")
            or "/usr/local/bin/node"
        )
        if not self._bridge_dir:
            return [node, "index.js"]
        return [node, os.path.join(self._bridge_dir, "index.js")]

    async def connect(self) -> bool:
        """Connect to the Keet Bridge daemon.

        Ensures npm dependencies are installed before spawning the bridge.
        Waits for bridge to signal readiness (identity event) or fail.
        """
        if not await _ensure_node_deps():
            logger.error("[Keet] Node dependencies check failed")
            return False

        if not await self._ensure_bridge_deps():
            logger.error("[Keet] Bridge dependency check failed")
            return False

        try:
            await self._spawn_bridge()

            # Wait for bridge readiness OR process exit
            ready_task = asyncio.create_task(self._wait_bridge_ready())
            exit_task = asyncio.create_task(self._wait_process_exit())

            done, pending = await asyncio.wait(
                [ready_task, exit_task],
                timeout=30.0,
                return_when=asyncio.FIRST_COMPLETED,
            )

            for task in pending:
                task.cancel()

            # If the process exited before we got a ready signal, it's a failure
            if exit_task in done:
                exit_code = exit_task.result()
                stderr_log = "\n".join(self._startup_stderr[-20:])
                logger.error(
                    "[Keet] Bridge exited during startup (code %d). Stderr:\n%s",
                    exit_code or -1,
                    stderr_log or "(empty)",
                )
                self._connected = False
                return False

            self._connected = True
            logger.info("[Keet] Adapter connected")
            logger.info("[Keet] Bridge public key: %s", self._bridge_public_key)
            logger.info("[Keet] Welcome room key: %s", self._welcome_room_key)
            return True

        except asyncio.TimeoutError:
            logger.error("[Keet] Bridge startup timed out after 30s")
            self._connected = False
            return False
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

    async def _wait_bridge_ready(self) -> None:
        """Wait for bridge to signal readiness (identity event)."""
        await self._bridge_ready.wait()

    async def _wait_process_exit(self) -> Optional[int]:
        """Wait for the bridge process to exit unexpectedly during startup."""
        if not self._process:
            return None
        return await self._process.wait()

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
        """Log and capture bridge stderr for startup diagnostics."""
        while self._process and self._process.stderr:
            try:
                line = await self._process.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if text:
                    self._startup_stderr.append(text)
                    logger.debug("[Keet] Bridge: %s", text)
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
            pubkey = event.get("public_key", "")
            self._bridge_public_key = pubkey
            logger.info("[Keet] Bridge identity: %s", pubkey)
            # Don't set _bridge_ready yet — wait for welcome_room_ready
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
            logger.info("[Keet] Welcome room ready: %s", room_key)
            self._bridge_ready.set()
        elif event_type == "invite_created":
            url = event.get("url", "")
            self._last_invite_url = url
            logger.info("[Keet] Invite created: %s", url)
        elif event_type == "pairing_request":
            logger.info("[Keet] Pairing request from %s for ticket %s",
                        event.get("pubkey", "?")[:16],
                        event.get("ticket", "?")[:16])
        elif event_type == "member_joined":
            pubkey = event.get("pubkey", "")
            room_key = event.get("room_key", "")
            logger.info("[Keet] Member joined: %s in %s", pubkey[:16], room_key[:16] if room_key else "?")
            self.add_allowed_user(pubkey)
        elif event_type == "pairing_result":
            logger.info("[Keet] Pairing result: candidate %s → %s",
                        event.get("candidate_id", "?")[:16],
                        event.get("status", "?"))
        elif event_type == "cancel_invite_result":
            logger.info("[Keet] Invite %s: %s",
                        event.get("ticket", "?")[:16],
                        event.get("status", "?"))
        elif event_type == "pairing_list":
            logger.info("[Keet] Pairing list received: %d sessions, %d pending",
                        len(event.get("sessions", [])),
                        len(event.get("pending", [])))

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

    async def create_invite(self, room_key: Optional[str] = None) -> None:
        """Send a command to create an invite URL.

        The URL arrives via the 'invite_created' event and is
        stored in self._last_invite_url.
        """
        cmd: dict = {"command": "create_invite"}
        if room_key:
            cmd["room_key"] = room_key
        await self._send_command(cmd)

    async def accept_pairing(self, candidate_id: str) -> None:
        """Accept a pending pairing request."""
        await self._send_command({"command": "accept_pairing", "candidate_id": candidate_id})

    async def decline_pairing(self, candidate_id: str) -> None:
        """Decline a pending pairing request."""
        await self._send_command({"command": "decline_pairing", "candidate_id": candidate_id})

    async def cancel_invite(self, ticket: str) -> None:
        """Cancel an invite by ticket."""
        await self._send_command({"command": "cancel_invite", "ticket": ticket})

    async def invite_cancel(self, ticket: str) -> None:
        """Alias for cancel_invite (naming from TZ)."""
        await self.cancel_invite(ticket)

    async def pairing_list(self) -> None:
        """Request the list of active invite sessions and pending candidates."""
        await self._send_command({"command": "pairing_list"})

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
    """Check that Node.js and the bridge dependencies are available.

    The bridge runs directly via Node.js — Pear Runtime is no longer
    required unless KEET_USE_PEAR env is explicitly set.
    """
    node = shutil.which("node") or "/usr/local/bin/node"
    if not os.path.exists(node) or not os.access(node, os.X_OK):
        logger.error(
            "[Keet] Node.js not found at %s. Install Node.js >= 18: "
            "https://nodejs.org/en/download/",
            node,
        )
        return False

    bridge_dir = _PLUGIN_DIR / "bridge"
    if not (bridge_dir / "node_modules").is_dir():
        logger.warning(
            "[Keet] Bridge dependencies not installed — "
            "will run npm install on connect."
        )
        # Not a hard blocker — _ensure_bridge_deps will handle it

    # If KEET_USE_PEAR is set, also check for pear
    if os.environ.get("KEET_USE_PEAR", "").lower() == "true":
        pear = shutil.which("pear")
        local_pear = _PLUGIN_DIR / "node_modules" / ".bin" / "pear"
        if pear:
            _check_pear_path()
            return True
        if local_pear.is_file():
            return True
        logger.error(
            "[Keet] KEET_USE_PEAR is set but Pear Runtime is not found. "
            "Install: npm i -g pear, or run 'npm install' in plugin root."
        )
        return False

    return True


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
            "[Keet] Validation failed — Node.js is required. "
            "Install Node.js >= 18: https://nodejs.org/en/download/"
        )
    return ok


def is_connected(config: "PlatformConfig") -> bool:
    """Check if Node.js is available."""
    if not shutil.which("node"):
        return False
    bridge_dir = _PLUGIN_DIR / "bridge" / "node_modules"
    return bridge_dir.is_dir()


def _env_enablement() -> dict:
    """Load env vars from platform config section."""
    env = {}
    home = os.environ.get(HOME_CHANNEL_ENV, "")
    if not home:
        home = os.environ.get("KEET_HOME_CHANNEL", "")
    if home:
        env["home_channel"] = home

    allowed = os.environ.get(ALLOWED_USERS_ENV, "")
    if not allowed:
        allowed = os.environ.get("KEET_ALLOWED_USERS", "")
    if allowed:
        env["allowed_users"] = allowed

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
            "Requires Node.js >= 18. "
            "Bridge is auto-detected and auto-started — no manual config needed. "
            "Pear Runtime (npm i -g pear) is optional; set KEET_USE_PEAR=true to use it."
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
