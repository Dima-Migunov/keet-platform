"""Tests for keet-platform adapter."""

import os
import sys
from unittest.mock import AsyncMock, patch

# Allow importing adapter.py from the plugin root
_plugin_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

import adapter

# Mock SessionSource and MessageEvent so tests that reach message forwarding don't crash
from unittest.mock import MagicMock
adapter.SessionSource = MagicMock()
adapter.MessageEvent = MagicMock()


def test_check_requirements_pear_found():
    """check_requirements returns True when pear is on PATH."""
    with patch("shutil.which", return_value="/usr/local/bin/pear"):
        assert adapter.check_requirements() is True


def test_check_requirements_pear_missing():
    """check_requirements returns False when pear is not found."""
    with patch("shutil.which", return_value=None):
        assert adapter.check_requirements() is False


def test_check_requirements_pear_local():
    """check_requirements returns True when pear is in local node_modules/.bin."""
    with patch("shutil.which", return_value=None):
        with patch("pathlib.Path.is_file", return_value=True):
            assert adapter.check_requirements() is True


def test_check_requirements_calls_pear_path_check():
    """When pear is found on system PATH, _check_pear_path is called."""
    with patch("shutil.which", return_value="/usr/local/bin/pear"):
        with patch.object(adapter, "_check_pear_path") as mock:
            adapter.check_requirements()
            mock.assert_called_once()


def test_check_pear_path_does_not_log_when_dir_missing():
    """_check_pear_path does not warn if ~/.config/pear/bin does not exist."""
    with patch("pathlib.Path.is_dir", return_value=False):
        with patch("adapter.logger.warning") as mock:
            adapter._check_pear_path()
            mock.assert_not_called()


def test_check_pear_path_logs_when_not_in_path():
    """_check_pear_path warns when Pear bin dir exists but is not in PATH."""
    with patch("pathlib.Path.is_dir", return_value=True):
        with patch("os.environ", {"PATH": "/usr/bin:/bin"}):
            with patch("adapter.logger.warning") as mock:
                adapter._check_pear_path()
                mock.assert_called_once()


def test_check_pear_path_silent_when_in_path():
    """_check_pear_path does not warn when Pear bin dir is already in PATH."""
    from pathlib import Path as _Path
    fake_home = _Path("/home/user")
    with patch("pathlib.Path.is_dir", return_value=True):
        with patch("pathlib.Path.home", return_value=fake_home):
            with patch.dict(os.environ, {"PATH": "/home/user/.config/pear/bin:/usr/bin"}):
                with patch("adapter.logger.warning") as mock:
                    adapter._check_pear_path()
                    mock.assert_not_called()


class TestBridgeNodeCmd:
    """Tests for KeetAdapter._bridge_node_cmd."""

    def test_no_bridge_dir_found(self):
        """When _bridge_dir is None, uses _pear_cmd() + ['run', 'index.js']."""
        a = adapter.KeetAdapter.__new__(adapter.KeetAdapter)
        a._bridge_dir = None
        cmd = a._bridge_node_cmd()
        # First element should be a pear path (from _pear_cmd())
        assert len(cmd) == 3
        assert cmd[1] == "run"
        assert cmd[2] == "index.js"

    def test_with_bridge_dir(self):
        """When _bridge_dir is set, returns full path to index.js."""
        a = adapter.KeetAdapter.__new__(adapter.KeetAdapter)
        a._bridge_dir = "/some/path/bridge"
        cmd = a._bridge_node_cmd()
        assert len(cmd) == 3
        assert cmd[1] == "run"
        assert cmd[2] == "/some/path/bridge/index.js"

    def test_command_starts_with_pear_run(self):
        """The second and third elements are always 'run' and the script."""
        a = adapter.KeetAdapter.__new__(adapter.KeetAdapter)
        a._bridge_dir = None
        cmd = a._bridge_node_cmd()
        assert cmd[1] == "run"


class TestPearCmd:
    """Tests for _pear_cmd()."""

    def test_pear_cmd_system(self):
        """Returns [path] from shutil.which when pear is on PATH."""
        with patch("shutil.which", return_value="/usr/local/bin/pear"):
            result = adapter._pear_cmd()
            assert result == ["/usr/local/bin/pear"]

    def test_pear_cmd_local(self):
        """Returns [path] from node_modules/.bin/pear when not on PATH."""
        with patch("shutil.which", return_value=None):
            with patch("pathlib.Path.is_file", return_value=True):
                result = adapter._pear_cmd()
                assert len(result) == 1
                assert result[0].endswith("pear")

    def test_pear_cmd_fallback(self):
        """Returns ['pear'] when not found anywhere."""
        with patch("shutil.which", return_value=None):
            with patch("pathlib.Path.is_file", return_value=False):
                result = adapter._pear_cmd()
                assert result == ["pear"]


class TestAddBinToPath:
    """Tests for _add_bin_to_path()."""

    def test_adds_bin_dir_when_missing(self):
        """Adds node_modules/.bin to PATH when dir exists and not already in PATH."""
        with patch("pathlib.Path.is_dir", return_value=True):
            with patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}, clear=True):
                adapter._add_bin_to_path()
                path = os.environ.get("PATH", "")
                assert "node_modules/.bin" in path

    def test_does_not_duplicate_when_already_in_path(self):
        """Does not add node_modules/.bin if already present."""
        # Compute the actual bin dir that _add_bin_to_path would check
        actual_bin = str(adapter._PLUGIN_DIR / "node_modules" / ".bin")
        with patch("pathlib.Path.is_dir", return_value=True):
            with patch.dict(os.environ, {"PATH": f"{actual_bin}:/usr/bin"}, clear=True):
                adapter._add_bin_to_path()
                count = os.environ["PATH"].count(actual_bin)
                assert count == 1

    def test_skips_when_dir_does_not_exist(self):
        """Does nothing when node_modules/.bin does not exist."""
        with patch("pathlib.Path.is_dir", return_value=False):
            with patch.dict(os.environ, {"PATH": "/usr/bin"}, clear=True):
                adapter._add_bin_to_path()
                assert os.environ["PATH"] == "/usr/bin"


class TestWelcomeOnFirstContact:
    """Tests for welcome message on first contact."""

    async def _make_adapter(self, allowed: str = "") -> adapter.KeetAdapter:
        """Helper to create a KeetAdapter with patched dependencies."""
        a = adapter.KeetAdapter.__new__(adapter.KeetAdapter)
        a._bridge_dir = None
        a._process = None
        a._connected = False
        a._tasks = set()
        a._buffer = ""
        a._home_channel = ""
        a._bridge_public_key = ""
        a._welcomed_contacts = set()
        if allowed:
            a._allowed_users = {k.strip() for k in allowed.split(",") if k.strip()}
        else:
            a._allowed_users = None  # allow all
        # on_message is defined on the parent — set a noop for standalone tests
        a.on_message = AsyncMock()
        return a

    async def test_first_message_sends_welcome(self):
        """First message from an allowed user triggers welcome."""
        a = await self._make_adapter()
        event = {"chat_id": "room1", "from": "user_pubkey", "text": "hello", "ts": 100}

        with patch.object(a, "send") as mock_send:
            await a._on_message(event)

        mock_send.assert_awaited_once_with("room1", adapter.WELCOME_MESSAGE)

    async def test_welcome_sent_once_per_user(self):
        """Subsequent messages from the same user don't send welcome again."""
        a = await self._make_adapter()
        event = {"chat_id": "room1", "from": "user_pubkey", "text": "hello", "ts": 100}

        with patch.object(a, "send") as mock_send:
            await a._on_message(event)  # first — sends welcome
            await a._on_message(event)  # second — no welcome

        assert mock_send.await_count == 1
        mock_send.assert_awaited_with("room1", adapter.WELCOME_MESSAGE)

    async def test_welcome_not_sent_to_unauthorized(self):
        """Unauthorized contacts don't get a welcome."""
        a = await self._make_adapter(allowed="other_user")
        event = {"chat_id": "room1", "from": "unauthorized", "text": "hi", "ts": 100}

        with patch.object(a, "send") as mock_send:
            await a._on_message(event)

        mock_send.assert_not_awaited()

    async def test_welcome_does_not_block_message_forwarding(self):
        """The message is still forwarded to on_message after welcome."""
        a = await self._make_adapter()
        event = {"chat_id": "room1", "from": "user_pk", "text": "hello", "ts": 100}

        with patch.object(a, "send"):
            with patch.object(a, "on_message") as mock_on_msg:
                await a._on_message(event)

        mock_on_msg.assert_awaited_once()
