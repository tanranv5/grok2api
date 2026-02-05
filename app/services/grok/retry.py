"""
Grok API 重试工具

提供可配置的重试机制，支持:
- 可配置的重试次数
- 可配置的重试状态码
- 仅记录最后一次失败
"""

import asyncio
from typing import Callable, Any, Optional, List
from functools import wraps

from app.core.logger import logger
from app.core.config import get_config
from app.core.exceptions import UpstreamException


class RetryConfig:
    """重试配置"""
    
    @staticmethod
    def get_max_retry() -> int:
        """获取最大重试次数"""
        return get_config("grok.max_retry", 1)
    
    @staticmethod
    def get_retry_codes() -> List[int]:
        """获取可重试的状态码"""
        return get_config("grok.retry_status_codes", [401, 429, 403])

    @staticmethod
    def get_retry_on_network_error() -> bool:
        """是否对网络异常重试"""
        return bool(get_config("grok.retry_on_network_error", True))

    @staticmethod
    def get_retry_backoff_base() -> float:
        """获取重试退避基数（秒）"""
        return float(get_config("grok.retry_backoff_base", 1))

    @staticmethod
    def get_retry_backoff_factor() -> float:
        """获取重试退避倍率"""
        return float(get_config("grok.retry_backoff_factor", 2))

    @staticmethod
    def get_retry_backoff_max() -> float:
        """获取重试退避上限（秒）"""
        return float(get_config("grok.retry_backoff_max", 30))

    @staticmethod
    def get_backoff_delay(attempt: int) -> float:
        """计算退避等待时间（秒）"""
        base = max(0.0, RetryConfig.get_retry_backoff_base())
        factor = max(1.0, RetryConfig.get_retry_backoff_factor())
        max_delay = max(0.0, RetryConfig.get_retry_backoff_max())
        steps = max(0, attempt - 1)
        delay = base * (factor ** steps)
        return min(delay, max_delay) if max_delay > 0 else delay

    @staticmethod
    def get_network_error_keywords() -> List[str]:
        """网络异常关键字（用于判定是否重试）"""
        return [
            "connection reset",
            "recv failure",
            "connection aborted",
            "connection refused",
            "connection closed",
            "connection error",
            "timed out",
            "timeout",
            "network is unreachable",
            "broken pipe",
            "tls",
            "ssl",
            "eof",
            "curl",
        ]


class RetryContext:
    """重试上下文"""
    
    def __init__(self):
        self.attempt = 0
        self.max_retry = RetryConfig.get_max_retry()
        self.retry_codes = RetryConfig.get_retry_codes()
        self.last_error = None
        self.last_status = None
    
    def should_retry(self, status_code: int) -> bool:
        """判断是否重试"""
        return (
            self.attempt < self.max_retry and 
            status_code in self.retry_codes
        )
    
    def record_error(self, status_code: int, error: Exception):
        """记录错误信息"""
        self.last_status = status_code
        self.last_error = error
        self.attempt += 1


def _get_error_message(e: Exception) -> str:
    if isinstance(e, UpstreamException):
        details = e.details or {}
        raw = details.get("error")
        if isinstance(raw, str) and raw:
            return raw
    return str(e)


def _is_network_error(e: Exception) -> bool:
    # 直接异常类型
    if isinstance(e, (asyncio.TimeoutError, ConnectionError, OSError)):
        return True
    msg = _get_error_message(e).lower()
    if not msg:
        return False
    return any(k in msg for k in RetryConfig.get_network_error_keywords())


async def retry_on_status(
    func: Callable,
    *args,
    extract_status: Callable[[Exception], Optional[int]] = None,
    on_retry: Callable[[int, int, Exception], None] = None,
    **kwargs
) -> Any:
    """
    通用重试函数
    
    Args:
        func: 重试的异步函数
        *args: 函数参数
        extract_status: 异常提取状态码的函数
        on_retry: 重试时的回调函数
        **kwargs: 函数关键字参数
        
    Returns:
        函数执行结果
        
    Raises:
        最后一次失败的异常
    """
    ctx = RetryContext()
    
    # 状态码提取器
    if extract_status is None:
        def extract_status(e: Exception) -> Optional[int]:
            if isinstance(e, UpstreamException):
                return e.details.get("status") if e.details else None
            return None
    
    while ctx.attempt <= ctx.max_retry:
        try:
            result = await func(*args, **kwargs)
            
            # 记录日志
            if ctx.attempt > 0:
                logger.info(
                    f"Retry succeeded after {ctx.attempt} attempts"
                )
            
            return result
            
        except Exception as e:
            # 提取状态码
            status_code = extract_status(e)
            
            if status_code is None:
                # 无状态码，尝试判定是否为网络错误
                if RetryConfig.get_retry_on_network_error() and _is_network_error(e):
                    ctx.record_error(0, e)
                    if ctx.attempt <= ctx.max_retry:
                        delay = RetryConfig.get_backoff_delay(ctx.attempt)
                        logger.warning(
                            f"Retry {ctx.attempt}/{ctx.max_retry} for network error, "
                            f"waiting {delay}s"
                        )
                        if on_retry:
                            on_retry(ctx.attempt, 0, e)
                        await asyncio.sleep(delay)
                        continue
                    logger.error(f"Retry exhausted after {ctx.max_retry} attempts (network error)")
                else:
                    logger.error(f"Non-retryable error: {e}")
                raise
            
            # 记录错误
            ctx.record_error(status_code, e)
            
            # 判断是否重试
            if ctx.should_retry(status_code):
                delay = RetryConfig.get_backoff_delay(ctx.attempt)
                logger.warning(
                    f"Retry {ctx.attempt}/{ctx.max_retry} for status {status_code}, "
                    f"waiting {delay}s"
                )
                
                # 回调
                if on_retry:
                    on_retry(ctx.attempt, status_code, e)
                
                await asyncio.sleep(delay)
                continue
            else:
                # 不可重试或重试次数耗尽
                if status_code in ctx.retry_codes:
                    # 打印当前尝试次数（包括最后一次）
                    logger.warning(
                        f"Retry {ctx.attempt}/{ctx.max_retry} for status {status_code}, failed"
                    )
                    logger.error(
                        f"Retry exhausted after {ctx.max_retry} attempts, "
                        f"last status: {status_code}"
                    )
                else:
                    logger.error(
                        f"Non-retryable status code: {status_code}"
                    )
                
                # 抛出最后一次的错误
                raise


def with_retry(
    extract_status: Callable[[Exception], Optional[int]] = None,
    on_retry: Callable[[int, int, Exception], None] = None
):
    """
    重试装饰器
    
    Usage:
        @with_retry()
        async def my_api_call():
            ...
    """
    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            return await retry_on_status(
                func,
                *args,
                extract_status=extract_status,
                on_retry=on_retry,
                **kwargs
            )
        return wrapper
    return decorator


__all__ = [
    "RetryConfig",
    "RetryContext",
    "retry_on_status",
    "with_retry",
]
