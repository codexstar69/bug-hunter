from fastapi import APIRouter, Depends, HTTPException
from typing import Literal
from .auth import current_user
from .models import User

router = APIRouter()

async def owned_account(owner: str, user: User = Depends(current_user)) -> str:
    if owner != user.id:
        raise HTTPException(status_code=403)
    return owner

@router.get("/accounts/{owner}")
async def account(owned: str = Depends(owned_account)):
    return {"id": owned}

@router.get("/admin/export")
async def export(user: User = Depends(current_user)):
    if user.role != "admin":
        raise HTTPException(status_code=403)
    return {"ok": True}

@router.get("/search")
async def search(order: Literal["name", "created"] = "name", user: User = Depends(current_user)):
    column = {"name": "name", "created": "created_at"}[order]
    return {"statement": f"SELECT id FROM accounts ORDER BY {column}", "requester": user.id}
