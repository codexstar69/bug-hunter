from fastapi import Header, HTTPException
from .models import User

SESSIONS: dict[str, User] = {}

async def current_user(x_session: str = Header()) -> User:
    user = SESSIONS.get(x_session)
    if user is None:
        raise HTTPException(status_code=401)
    return user
