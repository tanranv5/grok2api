"""
响应中间件
Response Middleware

用于记录请求日志、生成 TraceID 和计算请求耗时
"""

import time
import uuid
from typing import Optional
import orjson
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.types import ASGIApp

from app.core.logger import logger
from app.services.request_logger import request_logger
from app.services.request_stats import request_stats

class ResponseLoggerMiddleware(BaseHTTPMiddleware):
    """
    请求日志/响应追踪中间件
    Request Logging and Response Tracking Middleware
    """
    
    @staticmethod
    def _get_client_ip(request: Request) -> str:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
        return request.client.host if request.client else ""
    
    @staticmethod
    def _extract_model(path: str, payload: Optional[dict]) -> str:
        if not payload:
            return "unknown"
        if "model" in payload and isinstance(payload.get("model"), str):
            return payload["model"]
        return "unknown"
    
    async def dispatch(self, request: Request, call_next):
        # 生成请求 ID
        trace_id = str(uuid.uuid4())
        request.state.trace_id = trace_id
        
        start_time = time.time()
        payload = None
        should_track = request.method in {"POST", "PUT", "PATCH"} and request.url.path.startswith("/v1/")
        if should_track:
            try:
                content_type = request.headers.get("content-type", "")
                if content_type.startswith("application/json"):
                    body = await request.body()
                    if body and len(body) <= 1024 * 1024:
                        payload = orjson.loads(body)
            except Exception:
                payload = None
        
        # 记录请求信息
        logger.info(
            f"Request: {request.method} {request.url.path}",
            extra={
                "traceID": trace_id,
                "method": request.method,
                "path": request.url.path
            }
        )
        
        try:
            response = await call_next(request)
            
            # 计算耗时
            duration = (time.time() - start_time) * 1000
            
            # 记录响应信息
            logger.info(
                f"Response: {request.method} {request.url.path} - {response.status_code} ({duration:.2f}ms)",
                extra={
                    "traceID": trace_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "duration_ms": round(duration, 2)
                }
            )
            
            if should_track:
                model = self._extract_model(request.url.path, payload)
                key_info = getattr(request.state, "key_info", {}) or {}
                key_name = key_info.get("name", "Unknown")
                token_value = key_info.get("key") or ""
                token_suffix = token_value[-6:] if token_value else ""
                ip = self._get_client_ip(request)
                
                await request_stats.record_request(model=model, success=response.status_code < 400)
                await request_logger.add_log(
                    ip=ip,
                    model=model,
                    duration=round(duration, 2),
                    status=response.status_code,
                    key_name=key_name,
                    token_suffix=token_suffix
                )
            
            return response
            
        except Exception as e:
            duration = (time.time() - start_time) * 1000
            logger.error(
                f"Response Error: {request.method} {request.url.path} - {str(e)} ({duration:.2f}ms)",
                extra={
                    "traceID": trace_id,
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": round(duration, 2),
                    "error": str(e)
                }
            )
            
            if should_track:
                model = self._extract_model(request.url.path, payload)
                key_info = getattr(request.state, "key_info", {}) or {}
                key_name = key_info.get("name", "Unknown")
                token_value = key_info.get("key") or ""
                token_suffix = token_value[-6:] if token_value else ""
                ip = self._get_client_ip(request)
                
                await request_stats.record_request(model=model, success=False)
                await request_logger.add_log(
                    ip=ip,
                    model=model,
                    duration=round(duration, 2),
                    status=500,
                    key_name=key_name,
                    token_suffix=token_suffix,
                    error=str(e)
                )
            raise e
