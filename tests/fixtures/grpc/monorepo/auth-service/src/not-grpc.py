def GetUser(user_id):
    """A local helper that happens to share a name with the RPC."""
    return {"id": user_id, "name": "local"}
