"""API Key 管理器 - 多用户密钥管理"""

import orjson
import time
import secrets
import asyncio
from typing import List, Dict, Optional
from pathlib import Path

from app.core.logger import logger
from app.core.config import get_config


class ApiKeyManager:
    """API Key 管理服务"""
    
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self):
        if hasattr(self, '_initialized'):
            return
            
        self.file_path = Path(__file__).parents[2] / "data" / "api_keys.json"
        self._keys: List[Dict] = []
        self._lock = asyncio.Lock()
        self._loaded = False
        
        self._initialized = True
        logger.debug(f"[ApiKey] 初始化完成: {self.file_path}")

    async def init(self):
        """初始化加载数据"""
        if not self._loaded:
            await self._load_data()

    async def _load_data(self):
        """加载 API Keys"""
        if self._loaded:
            return

        if not self.file_path.exists():
            self._keys = []
            self._loaded = True
            return

        try:
            async with self._lock:
                if self.file_path.exists():
                    content = await asyncio.to_thread(self.file_path.read_bytes)
                    if content:
                        self._keys = orjson.loads(content)
                        self._loaded = True
                        logger.debug(f"[ApiKey] 加载了 {len(self._keys)} 个 API Key")
        except Exception as e:
            logger.error(f"[ApiKey] 加载失败: {e}")
            self._keys = []
            self._loaded = True # 即使加载失败也认为已尝试加载，防止后续保存清空数据（或者抛出异常）

    async def _save_data(self):
        """保存 API Keys"""
        if not self._loaded:
            logger.warning("[ApiKey] 尝试在数据未加载时保存，已取消操作以防覆盖数据")
            return
            
        try:
            # 确保目录存在
            self.file_path.parent.mkdir(parents=True, exist_ok=True)
            
            async with self._lock:
                content = orjson.dumps(self._keys, option=orjson.OPT_INDENT_2)
                await asyncio.to_thread(self.file_path.write_bytes, content)
        except Exception as e:
            logger.error(f"[ApiKey] 保存失败: {e}")

    def generate_key(self) -> str:
        """生成一个新的 sk- 开头的 key"""
        return f"sk-{secrets.token_urlsafe(24)}"

    async def add_key(self, name: str) -> Dict:
        """添加 API Key"""
        new_key = {
            "key": self.generate_key(),
            "name": name,
            "created_at": int(time.time()),
            "is_active": True
        }
        self._keys.append(new_key)
        await self._save_data()
        logger.info(f"[ApiKey] 添加新Key: {name}")
        return new_key

    async def batch_add_keys(self, name_prefix: str, count: int) -> List[Dict]:
        """批量添加 API Key"""
        new_keys = []
        for i in range(1, count + 1):
            name = f"{name_prefix}-{i}" if count > 1 else name_prefix
            new_keys.append({
                "key": self.generate_key(),
                "name": name,
                "created_at": int(time.time()),
                "is_active": True
            })
        
        self._keys.extend(new_keys)
        await self._save_data()
        logger.info(f"[ApiKey] 批量添加 {count} 个 Key, 前缀: {name_prefix}")
        return new_keys

    async def delete_key(self, key: str) -> bool:
        """删除 API Key"""
        initial_len = len(self._keys)
        self._keys = [k for k in self._keys if k["key"] != key]
        
        if len(self._keys) != initial_len:
            await self._save_data()
            logger.info(f"[ApiKey] 删除Key: {key[:10]}...")
            return True
        return False

    async def batch_delete_keys(self, keys: List[str]) -> int:
        """批量删除 API Key"""
        initial_len = len(self._keys)
        self._keys = [k for k in self._keys if k["key"] not in keys]
        
        deleted_count = initial_len - len(self._keys)
        if deleted_count > 0:
            await self._save_data()
            logger.info(f"[ApiKey] 批量删除 {deleted_count} 个 Key")
        return deleted_count

    async def update_key_status(self, key: str, is_active: bool) -> bool:
        """更新 Key 状态"""
        for k in self._keys:
            if k["key"] == key:
                k["is_active"] = is_active
                await self._save_data()
                return True
        return False
        
    async def batch_update_keys_status(self, keys: List[str], is_active: bool) -> int:
        """批量更新 Key 状态"""
        updated_count = 0
        for k in self._keys:
            if k["key"] in keys:
                if k["is_active"] != is_active:
                    k["is_active"] = is_active
                    updated_count += 1
        
        if updated_count > 0:
            await self._save_data()
            logger.info(f"[ApiKey] 批量更新 {updated_count} 个 Key 状态为: {is_active}")
        return updated_count

    async def update_key_name(self, key: str, name: str) -> bool:
        """更新 Key 备注"""
        for k in self._keys:
            if k["key"] == key:
                k["name"] = name
                await self._save_data()
                return True
        return False

    def validate_key(self, key: str) -> Optional[Dict]:
        """验证 Key，返回 Key 信息"""
        # 1. 检查全局配置的 Key (作为默认 admin key)
        global_key = get_config("app.api_key", "")
        if global_key and key == global_key:
            return {
                "key": global_key,
                "name": "默认管理员",
                "is_active": True,
                "is_admin": True
            }
            
        # 2. 检查多 Key 列表
        for k in self._keys:
            if k["key"] == key:
                if k["is_active"]:
                    return {**k, "is_admin": False} # 普通 Key 也可以视为非管理员? 暂不区分权限，只做身份识别
                return None
                
        return None

    def get_all_keys(self) -> List[Dict]:
        """获取所有 Keys"""
        return self._keys


# 全局实例
api_key_manager = ApiKeyManager()
