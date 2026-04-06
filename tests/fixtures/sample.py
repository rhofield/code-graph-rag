# tests/fixtures/sample.py

"""Sample Python module for testing."""

import os
from pathlib import Path


def greet(name: str) -> str:
    """Greets a user by name."""
    return f"Hello, {name}!"


class UserService:
    """Handles user operations."""

    def create_user(self, name: str, email: str) -> dict:
        """Creates a new user."""
        validated = validate_email(email)
        return {"name": name, "email": validated}

    def get_user(self, user_id: int) -> dict | None:
        return None


def validate_email(email: str) -> str:
    if "@" not in email:
        raise ValueError("Invalid email")
    return email.lower()
