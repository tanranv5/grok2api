"""
Grok 模型管理服务
"""

import json
from enum import Enum
from pathlib import Path
from typing import Optional, Tuple
from pydantic import BaseModel, Field

from app.core.exceptions import ValidationException
from app.core.logger import logger


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
    DEFAULT_ALIASES = {
        "grok-imagine": "grok-imagine-1.0",
    }
    DEFAULT_MODELS = [
        {
            "id": "grok-3",
            "grok_model": "grok-3",
            "model_mode": "MODEL_MODE_AUTO",
            "rate_limit_model": "grok-3",
            "display_name": "Grok 3",
            "description": "Standard Grok 3 model",
            "tier": "basic",
            "cost": "low",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-3-fast",
            "grok_model": "grok-3",
            "model_mode": "MODEL_MODE_FAST",
            "rate_limit_model": "grok-3",
            "display_name": "Grok 3 Fast",
            "description": "Fast and efficient Grok 3 model",
            "tier": "basic",
            "cost": "low",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-4",
            "grok_model": "grok-4",
            "model_mode": "MODEL_MODE_AUTO",
            "rate_limit_model": "grok-4",
            "display_name": "Grok 4",
            "description": "Standard Grok 4 model",
            "tier": "basic",
            "cost": "low",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-4-mini",
            "grok_model": "grok-4-mini-thinking-tahoe",
            "model_mode": "MODEL_MODE_GROK_4_MINI_THINKING",
            "rate_limit_model": "grok-4-mini-thinking-tahoe",
            "display_name": "Grok 4 Mini",
            "description": "Grok 4 Mini Thinking model",
            "tier": "basic",
            "cost": "low",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-4-fast",
            "grok_model": "grok-4",
            "model_mode": "MODEL_MODE_FAST",
            "rate_limit_model": "grok-4",
            "display_name": "Grok 4 Fast",
            "description": "Fast version of Grok 4",
            "tier": "basic",
            "cost": "low",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-4-fast-expert",
            "grok_model": "grok-4-mini-thinking-tahoe",
            "model_mode": "MODEL_MODE_EXPERT",
            "rate_limit_model": "grok-4-mini-thinking-tahoe",
            "display_name": "Grok 4 Fast Expert",
            "description": "Expert mode of Grok 4 Mini Thinking",
            "tier": "basic",
            "cost": "high",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-4-expert",
            "grok_model": "grok-4",
            "model_mode": "MODEL_MODE_EXPERT",
            "rate_limit_model": "grok-4",
            "display_name": "Grok 4 Expert",
            "description": "Full Grok 4 model with expert mode capabilities",
            "tier": "basic",
            "cost": "high",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-4-heavy",
            "grok_model": "grok-4",
            "model_mode": "MODEL_MODE_HEAVY",
            "rate_limit_model": "grok-4",
            "display_name": "Grok 4 Heavy",
            "description": "Most powerful Grok model. Requires Super Token for access.",
            "tier": "super",
            "cost": "high",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-4.1",
            "grok_model": "grok-4-1-thinking-1129",
            "model_mode": "MODEL_MODE_AUTO",
            "rate_limit_model": "grok-4-1-thinking-1129",
            "display_name": "Grok 4.1",
            "description": "Grok 4.1 model",
            "tier": "basic",
            "cost": "low",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-4.1-thinking",
            "grok_model": "grok-4-1-thinking-1129",
            "model_mode": "MODEL_MODE_GROK_4_1_THINKING",
            "rate_limit_model": "grok-4-1-thinking-1129",
            "display_name": "Grok 4.1 Thinking",
            "description": "Grok 4.1 model with advanced thinking and tool capabilities",
            "tier": "basic",
            "cost": "high",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-4.20-beta",
            "grok_model": "grok-420",
            "model_mode": "MODEL_MODE_GROK_420",
            "rate_limit_model": "grok-420",
            "display_name": "Grok 4.20 Beta",
            "description": "Grok 4.20 beta model",
            "tier": "basic",
            "cost": "low",
            "is_image": False,
            "is_video": False,
        },
        {
            "id": "grok-imagine-1.0",
            "grok_model": "grok-3",
            "model_mode": "MODEL_MODE_FAST",
            "rate_limit_model": "grok-3",
            "display_name": "Grok Imagine 1.0",
            "description": "Image generation model",
            "tier": "basic",
            "cost": "high",
            "is_image": True,
            "is_video": False,
        },
        {
            "id": "grok-imagine-1.0-video",
            "grok_model": "grok-3",
            "model_mode": "MODEL_MODE_FAST",
            "rate_limit_model": "grok-3",
            "display_name": "Grok Imagine 1.0 Video",
            "description": "Video generation model",
            "tier": "basic",
            "cost": "high",
            "is_image": False,
            "is_video": True,
        },
        {
            "id": "grok-imagine-0.9",
            "grok_model": "grok-3",
            "model_mode": "MODEL_MODE_FAST",
            "rate_limit_model": "grok-3",
            "display_name": "Grok Imagine 0.9",
            "description": "Image and video generation model. Supports text-to-image and image-to-video generation.",
            "tier": "basic",
            "cost": "high",
            "is_image": True,
            "is_video": True,
        },
    ]

    @staticmethod
    def _safe_enum(enum_cls, value, default):
        try:
            return enum_cls(value)
        except Exception:
            return default

    @classmethod
    def _build_models(cls, raw_models):
        models = []
        for item in raw_models:
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
        return models

    @classmethod
    def _load_model_data(cls):
        try:
            raw = json.loads(cls.MODEL_DATA_PATH.read_text(encoding="utf-8"))
            aliases = raw.get("aliases") or {}
            models_raw = raw.get("models") or []
            models = cls._build_models(models_raw)
            if not models:
                raise RuntimeError("Empty model list")
            return aliases, models
        except Exception as e:
            logger.warning(f"模型清单加载失败，回退内置配置: {e}")
            return cls.DEFAULT_ALIASES, cls._build_models(cls.DEFAULT_MODELS)

    ALIASES: dict = {}
    MODELS: list[ModelInfo] = []
    _map: dict = {}
    
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

# 初始化模型清单（避免类体内调用 @classmethod 导致异常）
ModelService.ALIASES, ModelService.MODELS = ModelService._load_model_data()
ModelService._map = {m.model_id: m for m in ModelService.MODELS}
