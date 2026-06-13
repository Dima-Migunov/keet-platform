"""Keet platform Hermes plugin.

This __init__.py is bundled with the plugin directory so that Hermes can
discover it via its plugin loading machinery.  The try/except ensures that
unit tests which import adapter.py directly do not crash on the relative
import.
"""
try:
    from .adapter import register
    __all__ = ["register"]
except ImportError:
    # Running outside the Hermes plugin loader (e.g. unit tests)
    register = None
    __all__ = []
