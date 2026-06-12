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


class KeetAdapter(BasePlatformAdapter):
    """Adapter for Keet P2P messenger via the Keet Bridge daemon."""

    PLATFORM = PLATFORM
    
    def __init__(self, config: Optional["PlatformConfig"] = None, **kwargs):
        from gateway.config import Platform
        platform = Platform(PLATFORM)
        super().__init__(config=config, platform=platform, **kwargs)
        self._bridge_dir = self._detect_bridge_dir()
        self._process: Optional[asyncio.subprocess.Process] = None
        self._connected = False
        self._tasks: set = set()
        self._buffer = ""
        self._allowed_users = self._parse_allowed()
        self._home_channel = os.environ.get(HOME_CHANNEL_ENV, "").strip()
        self._bridge_public_key = ""

    def _detect_bridge_dir(self) -> Optional[str]:
        """Locate the bridge directory relative to the plugin."""
        import pathlib
        plugin_dir = pathlib.Path(__file__).resolve().parent
        bridge_dir = plugin_dir / "bridge"
        if bridge_dir.is_dir() and (bridge_dir / "package.json").exists():
            return str(bridge_dir)
        return None

    async def _ensure_bridge_deps(self) -> bool:
        """Run npm install if node_modules is missing."""
        if not self._bridge_dir:
            return False
        node_modules = os.path.join(self._bridge_dir, "node_modules")
        if os.path.isdir(node_modules):
            return True  # already installed
        logger.info("[Keet] Installing bridge dependencies (npm install)...")
        proc = await asyncio.create_subprocess_exec(
            "npm", "install", "--no-audit", "--no-fund",
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
        if self._allowed_users is None:
            return True
        return user_key in self._allowed_users

    def _bridge_node_cmd(self) -> list[str]:
        """Build the Pear run command for the bridge."""
        if not self._bridge_dir:
            return ["pear", "run", "index.js"]
        return ["pear", "run", os.path.join(self._bridge_dir, "index.js")]

    async def connect(self) -> bool:
        """Connect to the Keet Bridge daemon."""
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

    async def _on_message(self, event: dict):
        """Handle an incoming message from Keet."""
        chat_id = event.get("chat_id", "")
        sender = event.get("from", "")
        text = event.get("text", "")
        ts = event.get("ts", 0)

        if not self._is_allowed(sender):
            logger.info("[Keet] Ignoring %s (unauthorized)", sender)
            return

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

    async def get_identity(self) -> dict:
        """Request bridge identity info."""
        await self._send_command({"command": "get_identity"})
        return {}  # response arrives via _handle_bridge_event

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
    """Check that Pear Runtime is available."""
    import shutil
    if not shutil.which("pear"):
        return False
    return True


def validate_config(config: "PlatformConfig") -> bool:
    """Validate keet platform configuration."""
    return check_requirements()


def is_connected(config: "PlatformConfig") -> bool:
    """Check if Pear Runtime is available."""
    import shutil
    return shutil.which("pear") is not None


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
        setup_fn=None,
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
