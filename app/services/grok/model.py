"""
Grok 模型管理服务
"""

import json
from enum import Enum
from pathlib import Path
from typing import Optional, Tuple
from pydantic import BaseModel, Field

from app.core.exceptions import ValidationException


class Tier(str, Enum):
    """模型档位"""
    BASIC = "basic"
    SUPER = "super"


class Cost(str, Enum):
    """计费类型"""
    LOW = "low"
    HIGH = "high"


class ModelInfo(BaseModel):
    """模型信息"""
    model_id: str
    grok_model: str
    model_mode: str
    tier: Tier = Field(default=Tier.BASIC)
    cost: Cost = Field(default=Cost.LOW)
    display_name: str
    description: str = ""
    is_video: bool = False
    is_image: bool = False


class ModelService:
    """模型管理服务"""

    MODEL_DATA_PATH = Path(__file__).resolve().parents[3] / "shared" / "models.json"

    @staticmethod
    def _safe_enum(enum_cls, value, default):
        try:
            return enum_cls(value)
        except Exception:
            return default

    @classmethod
    def _load_model_data(cls):
        try:
            raw = json.loads(cls.MODEL_DATA_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            raise RuntimeError(f"Failed to load model data: {e}") from e

        aliases = raw.get("aliases") or {}
        models = []
        for item in raw.get("models", []):
            tier = cls._safe_enum(Tier, item.get("tier"), Tier.BASIC)
            cost = cls._safe_enum(Cost, item.get("cost"), Cost.LOW)
            models.append(
                ModelInfo(
                    model_id=item["id"],
                    grok_model=item["grok_model"],
                    model_mode=item.get("model_mode") or "MODEL_MODE_FAST",
                    tier=tier,
                    cost=cost,
                    display_name=item.get("display_name") or "",
                    description=item.get("description") or "",
                    is_video=bool(item.get("is_video", False)),
                    is_image=bool(item.get("is_image", False)),
                )
            )
        return aliases, models

    ALIASES, MODELS = _load_model_data()

    _map = {m.model_id: m for m in MODELS}
    
    @classmethod
    def get(cls, model_id: str) -> Optional[ModelInfo]:
        """获取模型信息"""
        model_id = cls.normalize(model_id)
        return cls._map.get(model_id)
    
    @classmethod
    def list(cls) -> list[ModelInfo]:
        """获取所有模型"""
        return list(cls._map.values())
    
    @classmethod
    def valid(cls, model_id: str) -> bool:
        """模型是否有效"""
        model_id = cls.normalize(model_id)
        return model_id in cls._map

    @classmethod
    def to_grok(cls, model_id: str) -> Tuple[str, str]:
        """转换为 Grok 参数"""
        model = cls.get(model_id)
        if not model:
            raise ValidationException(f"Invalid model ID: {model_id}")
        return model.grok_model, model.model_mode

    @classmethod
    def pool_for_model(cls, model_id: str) -> str:
        """根据模型选择 Token 池"""
        model = cls.get(model_id)
        if model and model.tier == Tier.SUPER:
            return "ssoSuper"
        return "ssoBasic"
    
    @classmethod
    def normalize(cls, model_id: str) -> str:
        """归一化模型名（处理别名）"""
        return cls.ALIASES.get(model_id, model_id)


__all__ = ["ModelService"]
