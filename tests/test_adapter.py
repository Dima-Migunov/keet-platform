"""Tests for keet-platform adapter."""

import os
import sys
from unittest.mock import patch

# Allow importing adapter.py from the plugin root
_plugin_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

import adapter


def test_check_requirements_pear_found():
    """check_requirements returns True when pear is on PATH."""
    with patch("shutil.which", return_value="/usr/local/bin/pear"):
        assert adapter.check_requirements() is True


def test_check_requirements_pear_missing():
    """check_requirements returns False when pear is not found."""
    with patch("shutil.which", return_value=None):
        assert adapter.check_requirements() is False


def test_check_requirements_calls_pear_path_check():
    """When pear is found, _check_pear_path is called."""
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
        """When _bridge_dir is None, returns ['pear', 'run', 'index.js']."""
        a = adapter.KeetAdapter.__new__(adapter.KeetAdapter)
        a._bridge_dir = None
        assert a._bridge_node_cmd() == ["pear", "run", "index.js"]

    def test_with_bridge_dir(self):
        """When _bridge_dir is set, returns full path to index.js."""
        a = adapter.KeetAdapter.__new__(adapter.KeetAdapter)
        a._bridge_dir = "/some/path/bridge"
        expected = ["pear", "run", "/some/path/bridge/index.js"]
        assert a._bridge_node_cmd() == expected

    def test_command_starts_with_pear_run(self):
        """The first two elements are always pear and run."""
        a = adapter.KeetAdapter.__new__(adapter.KeetAdapter)
        a._bridge_dir = None
        cmd = a._bridge_node_cmd()
        assert cmd[:2] == ["pear", "run"]
