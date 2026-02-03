"""
API 认证模块
"""
from typing import Optional, Dict
from fastapi import Depends, HTTPException, status, Security, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.core.config import get_config
from app.services.api_keys import api_key_manager

# 定义 Bearer Scheme
security = HTTPBearer(
    auto_error=False,
    scheme_name="API Key",
    description="Enter your API Key in the format: Bearer <key>"
)


async def verify_api_key(
    request: Request,
    auth: Optional[HTTPAuthorizationCredentials] = Security(security)
) -> Optional[Dict]:
    """
    验证 Bearer Token
    
    - 支持全局单 Key
    - 支持多 Key 管理
    - 未配置且无多 Key 时放行
    """
    api_key = get_config("app.api_key", "")
    
    # 初始化 Key 管理器
    await api_key_manager.init()
    
    if not auth:
        # 无任何 Key 配置时允许放行（开发模式）
        if not api_key and not api_key_manager.get_all_keys():
            request.state.key_info = {"key": None, "name": "Anonymous", "is_admin": True}
            return None
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )
        
    token = auth.credentials
    key_info = api_key_manager.validate_key(token)
    if not key_info:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    request.state.key_info = key_info
    return key_info


async def verify_app_key(
    auth: Optional[HTTPAuthorizationCredentials] = Security(security)
) -> Optional[str]:
    """
    验证后台登录密钥（app_key）。
    
    如果未配置 app_key，则跳过验证。
    """
    app_key = get_config("app.app_key", "")

    if not app_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="App key is not configured",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not auth:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if auth.credentials != app_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return auth.credentials
