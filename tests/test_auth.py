"""Tests for Garmin credential resolution (ingest/auth.py).

Covers the security-relevant precedence in ``get_credentials()``:
- the container env-var fallback (GARMIN_EMAIL/GARMIN_PASSWORD) wins WITHOUT
  ever touching the Keychain, and
- a broken/unavailable keyring backend (KeyringError) degrades to ``None``
  rather than crashing.

``prompt_and_store`` (interactive input/getpass) is intentionally not covered.
"""
from __future__ import annotations

import keyring
import keyring.errors

from local_fitness.ingest import auth


def _clear_garmin_env(monkeypatch):
    monkeypatch.delenv("GARMIN_EMAIL", raising=False)
    monkeypatch.delenv("GARMIN_PASSWORD", raising=False)


# --- env-var precedence: container fallback wins, Keychain untouched -------

def test_env_vars_win_without_touching_keyring(monkeypatch):
    monkeypatch.setenv("GARMIN_EMAIL", "env@example.com")
    monkeypatch.setenv("GARMIN_PASSWORD", "env-pw")

    def _boom(*a, **k):  # any keyring access would be a precedence bug
        raise AssertionError("keyring must not be consulted when env vars set")

    monkeypatch.setattr(keyring, "get_password", _boom)
    assert auth.get_credentials() == ("env@example.com", "env-pw")


def test_only_email_env_falls_through_to_keyring(monkeypatch):
    # One env var alone must NOT short-circuit — both are required.
    _clear_garmin_env(monkeypatch)
    monkeypatch.setenv("GARMIN_EMAIL", "env@example.com")
    calls: list[tuple[str, str]] = []

    def _get(service, key):
        calls.append((service, key))
        return None

    monkeypatch.setattr(keyring, "get_password", _get)
    assert auth.get_credentials() is None
    assert calls  # fell through to the Keychain branch


# --- KeyringError -> None (no usable backend in a container) ---------------

def test_keyring_error_returns_none(monkeypatch):
    _clear_garmin_env(monkeypatch)

    def _raise(*a, **k):
        raise keyring.errors.KeyringError("no backend")

    monkeypatch.setattr(keyring, "get_password", _raise)
    assert auth.get_credentials() is None


# --- Keychain primacy when env unset: round-trip via in-memory backend -----

def _install_memory_keyring(monkeypatch):
    """Back keyring with a simple in-memory store for the duration of a test."""
    store: dict[tuple[str, str], str] = {}

    def _set(service, key, value):
        store[(service, key)] = value

    def _get(service, key):
        return store.get((service, key))

    monkeypatch.setattr(keyring, "set_password", _set)
    monkeypatch.setattr(keyring, "get_password", _get)
    return store


def test_store_then_get_round_trip(monkeypatch):
    _clear_garmin_env(monkeypatch)
    _install_memory_keyring(monkeypatch)

    auth.store_credentials("user@example.com", "s3cret")
    assert auth.get_credentials() == ("user@example.com", "s3cret")


def test_no_stored_email_returns_none(monkeypatch):
    _clear_garmin_env(monkeypatch)
    _install_memory_keyring(monkeypatch)  # empty store
    assert auth.get_credentials() is None


def test_email_present_but_no_password_returns_none(monkeypatch):
    _clear_garmin_env(monkeypatch)
    _install_memory_keyring(monkeypatch)
    # Email key set, but password under that email absent.
    keyring.set_password(auth.SERVICE, auth.EMAIL_KEY, "user@example.com")
    assert auth.get_credentials() is None
