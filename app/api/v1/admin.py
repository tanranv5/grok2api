from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import HTMLResponse
from app.core.auth import verify_api_key, verify_app_key
from app.core.config import config, get_config
from app.core.storage import get_storage, LocalStorage, RedisStorage, SQLStorage
import os
from pathlib import Path
import aiofiles
import asyncio
from app.core.logger import logger
from app.services.api_keys import api_key_manager
from app.services.request_logger import request_logger
from app.services.request_stats import request_stats


router = APIRouter()

TEMPLATE_DIR = Path(__file__).parent.parent.parent / "static"
ADMIN_TEMPLATE_DIR = Path(__file__).parent.parent.parent / "template"

async def render_template(filename: str):
    """渲染旧版管理后台模板"""
    template_path = TEMPLATE_DIR / filename
    if not template_path.exists():
        return HTMLResponse(f"Template {filename} not found.", status_code=404)
    async with aiofiles.open(template_path, "r", encoding="utf-8") as f:
        content = await f.read()
    return HTMLResponse(content)

async def render_admin_template(filename: str):
    """渲染管理后台模板（Workers 版静态页）"""
    template_path = ADMIN_TEMPLATE_DIR / filename
    if not template_path.exists():
        return HTMLResponse(f"Admin template {filename} not found.", status_code=404)
    async with aiofiles.open(template_path, "r", encoding="utf-8") as f:
        content = await f.read()
    return HTMLResponse(content)

@router.get("/admin", response_class=HTMLResponse, include_in_schema=False)
async def admin_login_page():
    """管理后台登录页"""
    # 统一使用模板版管理后台
    return await render_admin_template("login.html")

@router.get("/login", response_class=HTMLResponse, include_in_schema=False)
async def admin_login_page_alias():
    """管理后台登录页（兼容 Workers 路径）"""
    return await render_admin_template("login.html")

@router.get("/manage", response_class=HTMLResponse, include_in_schema=False)
async def admin_manage_page():
    """管理后台主界面（兼容 Workers 路径）"""
    return await render_admin_template("admin.html")

@router.get("/admin/config", response_class=HTMLResponse, include_in_schema=False)
async def admin_config_page():
    """配置管理页（统一后台）"""
    return await render_admin_template("admin.html")

@router.get("/admin/token", response_class=HTMLResponse, include_in_schema=False)
async def admin_token_page():
    """Token 管理页（统一后台）"""
    return await render_admin_template("admin.html")

@router.post("/api/v1/admin/login", dependencies=[Depends(verify_app_key)])
async def admin_login_api():
    """管理后台登录验证（使用 app_key）"""
    return {"status": "success", "api_key": get_config("app.api_key", "")}

@router.get("/api/v1/admin/keys", dependencies=[Depends(verify_api_key)])
async def list_api_keys():
    """获取所有 API Keys"""
    await api_key_manager.init()
    return {"status": "success", "data": api_key_manager.get_all_keys()}

@router.post("/api/v1/admin/keys", dependencies=[Depends(verify_api_key)])
async def add_api_key(data: dict):
    """添加 API Key"""
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Missing name")
    key = await api_key_manager.add_key(name)
    return {"status": "success", "data": key}

@router.post("/api/v1/admin/keys/batch", dependencies=[Depends(verify_api_key)])
async def batch_add_api_keys(data: dict):
    """批量添加 API Key"""
    name_prefix = (data.get("name_prefix") or "").strip()
    count = int(data.get("count") or 0)
    if not name_prefix or count <= 0:
        raise HTTPException(status_code=400, detail="Invalid name_prefix or count")
    keys = await api_key_manager.batch_add_keys(name_prefix, count)
    return {"status": "success", "data": keys}

@router.post("/api/v1/admin/keys/delete", dependencies=[Depends(verify_api_key)])
async def delete_api_keys(data: dict):
    """删除 API Key（单个或批量）"""
    keys = data.get("keys")
    key = data.get("key")
    if isinstance(keys, list):
        deleted = await api_key_manager.batch_delete_keys(keys)
        return {"status": "success", "deleted": deleted}
    if key:
        ok = await api_key_manager.delete_key(key)
        return {"status": "success", "deleted": 1 if ok else 0}
    raise HTTPException(status_code=400, detail="Missing key(s)")

@router.post("/api/v1/admin/keys/status", dependencies=[Depends(verify_api_key)])
async def update_api_keys_status(data: dict):
    """更新 API Key 状态（单个或批量）"""
    keys = data.get("keys")
    key = data.get("key")
    is_active = data.get("is_active")
    if is_active is None:
        raise HTTPException(status_code=400, detail="Missing is_active")
    if isinstance(keys, list):
        updated = await api_key_manager.batch_update_keys_status(keys, bool(is_active))
        return {"status": "success", "updated": updated}
    if key:
        ok = await api_key_manager.update_key_status(key, bool(is_active))
        return {"status": "success", "updated": 1 if ok else 0}
    raise HTTPException(status_code=400, detail="Missing key(s)")

@router.post("/api/v1/admin/keys/name", dependencies=[Depends(verify_api_key)])
async def update_api_key_name(data: dict):
    """更新 API Key 备注"""
    key = data.get("key")
    name = (data.get("name") or "").strip()
    if not key or not name:
        raise HTTPException(status_code=400, detail="Missing key or name")
    ok = await api_key_manager.update_key_name(key, name)
    return {"status": "success", "updated": 1 if ok else 0}

@router.get("/api/v1/admin/logs", dependencies=[Depends(verify_api_key)])
async def get_request_logs(limit: int = 200):
    """获取请求日志"""
    await request_logger.init()
    logs = await request_logger.get_logs(limit=limit)
    return {"status": "success", "data": logs}

@router.post("/api/v1/admin/logs/clear", dependencies=[Depends(verify_api_key)])
async def clear_request_logs():
    """清空请求日志"""
    await request_logger.clear_logs()
    return {"status": "success"}

@router.get("/api/v1/admin/stats", dependencies=[Depends(verify_api_key)])
async def get_request_stats(hours: int = 24, days: int = 7):
    """获取请求统计"""
    await request_stats.init()
    return {"status": "success", "data": request_stats.get_stats(hours=hours, days=days)}

@router.post("/api/v1/admin/stats/reset", dependencies=[Depends(verify_api_key)])
async def reset_request_stats():
    """重置请求统计"""
    await request_stats.reset()
    return {"status": "success"}

@router.get("/api/v1/admin/config", dependencies=[Depends(verify_api_key)])
async def get_config_api():
    """获取当前配置"""
    # 暴露原始配置字典
    return config._config

@router.post("/api/v1/admin/config", dependencies=[Depends(verify_api_key)])
async def update_config_api(data: dict):
    """更新配置"""
    try:
        await config.update(data)
        return {"status": "success", "message": "配置已更新"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/api/v1/admin/storage", dependencies=[Depends(verify_api_key)])
async def get_storage_info():
    """获取当前存储模式"""
    storage_type = os.getenv("SERVER_STORAGE_TYPE", "local").lower()
    logger.info(f"Storage type: {storage_type}")
    if not storage_type:
        storage_type = str(get_config("storage.type", "")).lower()
    if not storage_type:
        storage = get_storage()
        if isinstance(storage, LocalStorage):
            storage_type = "local"
        elif isinstance(storage, RedisStorage):
            storage_type = "redis"
        elif isinstance(storage, SQLStorage):
            if storage.dialect in ("mysql", "mariadb"):
                storage_type = "mysql"
            elif storage.dialect in ("postgres", "postgresql", "pgsql"):
                storage_type = "pgsql"
            else:
                storage_type = storage.dialect
    return {"type": storage_type or "local"}

@router.get("/api/v1/admin/tokens", dependencies=[Depends(verify_api_key)])
async def get_tokens_api():
    """获取所有 Token"""
    storage = get_storage()
    tokens = await storage.load_tokens()
    return tokens or {}

@router.post("/api/v1/admin/tokens", dependencies=[Depends(verify_api_key)])
async def update_tokens_api(data: dict):
    """更新 Token 信息"""
    storage = get_storage()
    try:
        from app.services.token.manager import get_token_manager
        async with storage.acquire_lock("tokens_save", timeout=10):
            await storage.save_tokens(data)
            mgr = await get_token_manager()
            await mgr.reload()
        return {"status": "success", "message": "Token 已更新"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/api/v1/admin/tokens/refresh", dependencies=[Depends(verify_api_key)])
async def refresh_tokens_api(data: dict):
    """刷新 Token 状态"""
    from app.services.token.manager import get_token_manager
    
    try:
        mgr = await get_token_manager()
        tokens = []
        if "token" in data:
            tokens.append(data["token"])
        if "tokens" in data and isinstance(data["tokens"], list):
            tokens.extend(data["tokens"])
            
        if not tokens:
             raise HTTPException(status_code=400, detail="No tokens provided")
             
        unique_tokens = list(set(tokens))
        
        sem = asyncio.Semaphore(10)
        
        async def _refresh_one(t):
            async with sem:
                return t, await mgr.sync_usage(t, "grok-3", consume_on_fail=False, is_usage=False)
        
        results_list = await asyncio.gather(*[_refresh_one(t) for t in unique_tokens])
        results = dict(results_list)
            
        return {"status": "success", "results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/admin/cache", response_class=HTMLResponse, include_in_schema=False)
async def admin_cache_page():
    """缓存管理页（统一后台）"""
    return await render_admin_template("admin.html")

@router.get("/admin-legacy", response_class=HTMLResponse, include_in_schema=False)
async def admin_legacy_login_page():
    """旧版管理后台登录页"""
    return await render_template("login/login.html")

@router.get("/admin-legacy/config", response_class=HTMLResponse, include_in_schema=False)
async def admin_legacy_config_page():
    """旧版配置管理页"""
    return await render_template("config/config.html")

@router.get("/admin-legacy/token", response_class=HTMLResponse, include_in_schema=False)
async def admin_legacy_token_page():
    """旧版 Token 管理页"""
    return await render_template("token/token.html")

@router.get("/admin-legacy/cache", response_class=HTMLResponse, include_in_schema=False)
async def admin_legacy_cache_page():
    """旧版缓存管理页"""
    return await render_template("cache/cache.html")

@router.get("/api/v1/admin/cache", dependencies=[Depends(verify_api_key)])
async def get_cache_stats_api(request: Request):
    """获取缓存统计"""
    from app.services.grok.assets import DownloadService, ListService
    from app.services.token.manager import get_token_manager
    
    try:
        dl_service = DownloadService()
        image_stats = dl_service.get_stats("image")
        video_stats = dl_service.get_stats("video")
        
        mgr = await get_token_manager()
        pools = mgr.pools
        accounts = []
        for pool_name, pool in pools.items():
            for info in pool.list():
                raw_token = info.token[4:] if info.token.startswith("sso=") else info.token
                masked = f"{raw_token[:8]}...{raw_token[-16:]}" if len(raw_token) > 24 else raw_token
                accounts.append({
                    "token": raw_token,
                    "token_masked": masked,
                    "pool": pool_name,
                    "status": info.status,
                    "last_asset_clear_at": info.last_asset_clear_at
                })

        scope = request.query_params.get("scope")
        selected_token = request.query_params.get("token")
        tokens_param = request.query_params.get("tokens")
        selected_tokens = []
        if tokens_param:
            selected_tokens = [t.strip() for t in tokens_param.split(",") if t.strip()]

        online_stats = {"count": 0, "status": "unknown", "token": None, "last_asset_clear_at": None}
        online_details = []
        account_map = {a["token"]: a for a in accounts}
        batch_size = get_config("performance.admin_assets_batch_size", 10)
        try:
            batch_size = int(batch_size)
        except Exception:
            batch_size = 10
        batch_size = max(1, batch_size)

        async def _fetch_assets(token: str):
            list_service = ListService()
            try:
                return await list_service.count(token)
            finally:
                await list_service.close()

        async def _fetch_detail(token: str):
            account = account_map.get(token)
            try:
                count = await _fetch_assets(token)
                return ({
                    "token": token,
                    "token_masked": account["token_masked"] if account else token,
                    "count": count,
                    "status": "ok",
                    "last_asset_clear_at": account["last_asset_clear_at"] if account else None
                }, count)
            except Exception as e:
                return ({
                    "token": token,
                    "token_masked": account["token_masked"] if account else token,
                    "count": 0,
                    "status": f"error: {str(e)}",
                    "last_asset_clear_at": account["last_asset_clear_at"] if account else None
                }, 0)

        if selected_tokens:
            total = 0
            for i in range(0, len(selected_tokens), batch_size):
                chunk = selected_tokens[i:i + batch_size]
                results = await asyncio.gather(*[_fetch_detail(token) for token in chunk])
                for detail, count in results:
                    online_details.append(detail)
                    total += count
            online_stats = {"count": total, "status": "ok" if selected_tokens else "no_token", "token": None, "last_asset_clear_at": None}
            scope = "selected"
        elif scope == "all":
            total = 0
            tokens = [account["token"] for account in accounts]
            for i in range(0, len(tokens), batch_size):
                chunk = tokens[i:i + batch_size]
                results = await asyncio.gather(*[_fetch_detail(token) for token in chunk])
                for detail, count in results:
                    online_details.append(detail)
                    total += count
            online_stats = {"count": total, "status": "ok" if accounts else "no_token", "token": None, "last_asset_clear_at": None}
        else:
            token = selected_token
            if token:
                try:
                    count = await _fetch_assets(token)
                    match = next((a for a in accounts if a["token"] == token), None)
                    online_stats = {
                        "count": count,
                        "status": "ok",
                        "token": token,
                        "token_masked": match["token_masked"] if match else token,
                        "last_asset_clear_at": match["last_asset_clear_at"] if match else None
                    }
                except Exception as e:
                    match = next((a for a in accounts if a["token"] == token), None)
                    online_stats = {
                        "count": 0,
                        "status": f"error: {str(e)}",
                        "token": token,
                        "token_masked": match["token_masked"] if match else token,
                        "last_asset_clear_at": match["last_asset_clear_at"] if match else None
                    }
            else:
                online_stats = {"count": 0, "status": "not_loaded", "token": None, "last_asset_clear_at": None}
            
        return {
            "local_image": image_stats,
            "local_video": video_stats,
            "online": online_stats,
            "online_accounts": accounts,
            "online_scope": scope or "none",
            "online_details": online_details
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/api/v1/admin/cache/clear", dependencies=[Depends(verify_api_key)])
async def clear_local_cache_api(data: dict):
    """清理本地缓存"""
    from app.services.grok.assets import DownloadService
    cache_type = data.get("type", "image")
    
    try:
        dl_service = DownloadService()
        result = dl_service.clear(cache_type)
        return {"status": "success", "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/api/v1/admin/cache/list", dependencies=[Depends(verify_api_key)])
async def list_local_cache_api(
    cache_type: str = "image",
    type_: str = Query(default=None, alias="type"),
    page: int = 1,
    page_size: int = 1000
):
    """列出本地缓存文件"""
    from app.services.grok.assets import DownloadService
    try:
        if type_:
            cache_type = type_
        dl_service = DownloadService()
        result = dl_service.list_files(cache_type, page, page_size)
        return {"status": "success", **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/api/v1/admin/cache/item/delete", dependencies=[Depends(verify_api_key)])
async def delete_local_cache_item_api(data: dict):
    """删除单个本地缓存文件"""
    from app.services.grok.assets import DownloadService
    cache_type = data.get("type", "image")
    name = data.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Missing file name")
    try:
        dl_service = DownloadService()
        result = dl_service.delete_file(cache_type, name)
        return {"status": "success", "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/api/v1/admin/cache/online/clear", dependencies=[Depends(verify_api_key)])
async def clear_online_cache_api(data: dict):
    """清理在线缓存"""
    from app.services.grok.assets import DeleteService
    from app.services.token.manager import get_token_manager
    
    delete_service = None
    try:
        mgr = await get_token_manager()
        tokens = data.get("tokens")
        delete_service = DeleteService()

        if isinstance(tokens, list):
            token_list = [t.strip() for t in tokens if isinstance(t, str) and t.strip()]
            if not token_list:
                raise HTTPException(status_code=400, detail="No tokens provided")

            results = {}
            batch_size = get_config("performance.admin_assets_batch_size", 10)
            try:
                batch_size = int(batch_size)
            except Exception:
                batch_size = 10
            batch_size = max(1, batch_size)

            async def _clear_one(t: str):
                try:
                    result = await delete_service.delete_all(t)
                    await mgr.mark_asset_clear(t)
                    return t, {"status": "success", "result": result}
                except Exception as e:
                    return t, {"status": "error", "error": str(e)}

            for i in range(0, len(token_list), batch_size):
                chunk = token_list[i:i + batch_size]
                res_list = await asyncio.gather(*[_clear_one(t) for t in chunk])
                for t, res in res_list:
                    results[t] = res

            return {"status": "success", "results": results}

        token = data.get("token") or mgr.get_token()
        if not token:
            raise HTTPException(status_code=400, detail="No available token to perform cleanup")

        result = await delete_service.delete_all(token)
        await mgr.mark_asset_clear(token)
        return {"status": "success", "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if delete_service:
            await delete_service.close()


# ========== Workers 风格管理后台 API 兼容层 ==========

def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 10:
        return key
    return f"{key[:6]}...{key[-4:]}"


@router.post("/api/login")
async def worker_admin_login(data: dict):
    """兼容 Workers 管理后台登录"""
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    expected_user = (get_config("app.admin_username", "admin") or "").strip()
    expected_pass = (get_config("app.app_key", "") or "").strip()

    if expected_user and username and username != expected_user:
        return {"success": False, "message": "用户名或密码错误"}
    if not expected_pass or password != expected_pass:
        return {"success": False, "message": "用户名或密码错误"}

    api_key = get_config("app.api_key", "") or ""
    if not api_key:
        await api_key_manager.init()
        keys = api_key_manager.get_all_keys()
        if keys:
            api_key = keys[0].get("key", "") or ""

    return {"success": True, "token": api_key, "message": "登录成功"}


@router.post("/api/logout", dependencies=[Depends(verify_api_key)])
async def worker_admin_logout():
    """兼容 Workers 管理后台登出"""
    return {"success": True, "message": "登出成功"}


@router.get("/api/settings", dependencies=[Depends(verify_api_key)])
async def worker_get_settings():
    """兼容 Workers 管理后台配置读取"""
    def _to_str_list(value):
        if isinstance(value, list):
            return ",".join([str(v).strip() for v in value if str(v).strip()])
        if value is None:
            return ""
        return str(value)

    global_cfg = {
        "admin_username": get_config("app.admin_username", "admin"),
        "log_level": get_config("app.log_level", "INFO"),
        "image_cache_max_size_mb": get_config("cache.limit_mb", 1024),
        "video_cache_max_size_mb": get_config("cache.video_limit_mb", get_config("cache.limit_mb", 1024)),
        "image_mode": get_config("app.image_format", "url"),
        "base_url": get_config("app.app_url", ""),
    }

    grok_cfg = {
        "api_key": get_config("app.api_key", ""),
        "proxy_url": get_config("grok.base_proxy_url", ""),
        "proxy_pool_url": get_config("grok.proxy_pool_url", ""),
        "proxy_pool_interval": get_config("grok.proxy_pool_interval", 300),
        "cache_proxy_url": get_config("grok.asset_proxy_url", ""),
        "cf_clearance": get_config("grok.cf_clearance", ""),
        "x_statsig_id": get_config("grok.x_statsig_id", ""),
        "dynamic_statsig": get_config("grok.dynamic_statsig", True),
        "filtered_tags": _to_str_list(get_config("grok.filter_tags", "")),
        "show_thinking": get_config("grok.thinking", True),
        "temporary": get_config("grok.temporary", True),
        "stream_chunk_timeout": get_config("grok.stream_chunk_timeout", 120),
        "stream_first_response_timeout": get_config("grok.stream_first_response_timeout", 30),
        "stream_total_timeout": get_config("grok.stream_total_timeout", 600),
        "max_retry": get_config("grok.max_retry", 3),
        "retry_status_codes": get_config("grok.retry_status_codes", [401, 429, 403]),
    }
    return {"success": True, "data": {"global": global_cfg, "grok": grok_cfg}}


@router.post("/api/settings", dependencies=[Depends(verify_api_key)])
async def worker_save_settings(data: dict):
    """兼容 Workers 管理后台配置更新"""
    global_cfg = data.get("global_config") or {}
    grok_cfg = data.get("grok_config") or {}

    def _split_tags(value: str):
        if not value:
            return []
        return [t.strip() for t in str(value).split(",") if t.strip()]

    def _prune_none(obj):
        if isinstance(obj, dict):
            return {k: _prune_none(v) for k, v in obj.items() if v is not None}
        return obj

    update_cfg = {
        "app": {
            "admin_username": global_cfg.get("admin_username"),
            "app_key": global_cfg.get("admin_password") or get_config("app.app_key", ""),
            "log_level": global_cfg.get("log_level"),
            "image_format": global_cfg.get("image_mode"),
            "app_url": global_cfg.get("base_url"),
        },
        "cache": {
            "limit_mb": global_cfg.get("image_cache_max_size_mb"),
            "video_limit_mb": global_cfg.get("video_cache_max_size_mb"),
        },
        "grok": {
            "base_proxy_url": grok_cfg.get("proxy_url"),
            "proxy_pool_url": grok_cfg.get("proxy_pool_url"),
            "proxy_pool_interval": grok_cfg.get("proxy_pool_interval"),
            "asset_proxy_url": grok_cfg.get("cache_proxy_url"),
            "cf_clearance": grok_cfg.get("cf_clearance"),
            "x_statsig_id": grok_cfg.get("x_statsig_id"),
            "dynamic_statsig": grok_cfg.get("dynamic_statsig"),
            "filter_tags": _split_tags(grok_cfg.get("filtered_tags")),
            "thinking": grok_cfg.get("show_thinking"),
            "temporary": grok_cfg.get("temporary"),
            "stream_chunk_timeout": grok_cfg.get("stream_chunk_timeout"),
            "stream_first_response_timeout": grok_cfg.get("stream_first_response_timeout"),
            "stream_total_timeout": grok_cfg.get("stream_total_timeout"),
            "max_retry": grok_cfg.get("max_retry"),
            "retry_status_codes": grok_cfg.get("retry_status_codes"),
        },
        "app_override": {
            "api_key": grok_cfg.get("api_key"),
        }
    }

    # 修正 app.api_key 写入到 app 节点
    if update_cfg["app_override"].get("api_key") is not None:
        update_cfg["app"]["api_key"] = update_cfg["app_override"]["api_key"]
    update_cfg.pop("app_override", None)
    update_cfg = _prune_none(update_cfg)

    await config.update(update_cfg)
    return {"success": True, "message": "配置已更新"}


@router.get("/api/storage/mode", dependencies=[Depends(verify_api_key)])
async def worker_storage_mode():
    """兼容 Workers 管理后台存储模式"""
    info = await get_storage_info()
    mode = str(info.get("type", "local")).lower()
    if mode in ("mysql", "mariadb", "pgsql", "postgres", "postgresql"):
        return {"success": True, "data": {"mode": "MYSQL" if mode in ("mysql", "mariadb") else "PGSQL"}}
    if mode == "redis":
        return {"success": True, "data": {"mode": "REDIS"}}
    return {"success": True, "data": {"mode": "FILE"}}


@router.get("/api/keys", dependencies=[Depends(verify_api_key)])
async def worker_list_keys():
    await api_key_manager.init()
    data = []
    for k in api_key_manager.get_all_keys():
        item = {**k}
        item["display_key"] = _mask_key(k.get("key", ""))
        data.append(item)
    return {"success": True, "data": data}


@router.post("/api/keys/add", dependencies=[Depends(verify_api_key)])
async def worker_add_key(data: dict):
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Missing name")
    key = await api_key_manager.add_key(name)
    key["display_key"] = _mask_key(key.get("key", ""))
    return {"success": True, "data": key}


@router.post("/api/keys/batch-add", dependencies=[Depends(verify_api_key)])
async def worker_batch_add_keys(data: dict):
    name_prefix = (data.get("name_prefix") or "").strip()
    count = int(data.get("count") or 0)
    if not name_prefix or count <= 0:
        raise HTTPException(status_code=400, detail="Invalid name_prefix or count")
    keys = await api_key_manager.batch_add_keys(name_prefix, count)
    for item in keys:
        item["display_key"] = _mask_key(item.get("key", ""))
    return {"success": True, "data": keys}


@router.post("/api/keys/batch-delete", dependencies=[Depends(verify_api_key)])
async def worker_batch_delete_keys(data: dict):
    keys = data.get("keys") or []
    deleted = await api_key_manager.batch_delete_keys(keys)
    return {"success": True, "deleted": deleted}


@router.post("/api/keys/batch-status", dependencies=[Depends(verify_api_key)])
async def worker_batch_update_keys_status(data: dict):
    keys = data.get("keys") or []
    is_active = data.get("is_active")
    if is_active is None:
        raise HTTPException(status_code=400, detail="Missing is_active")
    updated = await api_key_manager.batch_update_keys_status(keys, bool(is_active))
    return {"success": True, "updated": updated}


@router.post("/api/keys/delete", dependencies=[Depends(verify_api_key)])
async def worker_delete_key(data: dict):
    key = data.get("key")
    if not key:
        raise HTTPException(status_code=400, detail="Missing key")
    ok = await api_key_manager.delete_key(key)
    return {"success": True, "deleted": 1 if ok else 0}


@router.post("/api/keys/status", dependencies=[Depends(verify_api_key)])
async def worker_update_key_status(data: dict):
    key = data.get("key")
    is_active = data.get("is_active")
    if not key or is_active is None:
        raise HTTPException(status_code=400, detail="Missing key or is_active")
    ok = await api_key_manager.update_key_status(key, bool(is_active))
    return {"success": True, "updated": 1 if ok else 0}


@router.post("/api/keys/name", dependencies=[Depends(verify_api_key)])
async def worker_update_key_name(data: dict):
    key = data.get("key")
    name = (data.get("name") or "").strip()
    if not key or not name:
        raise HTTPException(status_code=400, detail="Missing key or name")
    ok = await api_key_manager.update_key_name(key, name)
    return {"success": True, "updated": 1 if ok else 0}


@router.get("/api/logs", dependencies=[Depends(verify_api_key)])
async def worker_get_logs(limit: int = 200):
    await request_logger.init()
    logs = await request_logger.get_logs(limit=limit)
    return {"success": True, "data": logs}


@router.post("/api/logs/clear", dependencies=[Depends(verify_api_key)])
async def worker_clear_logs():
    await request_logger.clear_logs()
    return {"success": True, "message": "日志已清空"}


@router.get("/api/stats", dependencies=[Depends(verify_api_key)])
async def worker_get_stats(hours: int = 24, days: int = 7):
    await request_stats.init()
    return {"success": True, "data": request_stats.get_stats(hours=hours, days=days)}


@router.get("/api/request-stats", dependencies=[Depends(verify_api_key)])
async def worker_get_request_stats(hours: int = 24, days: int = 7):
    await request_stats.init()
    return {"success": True, "data": request_stats.get_stats(hours=hours, days=days)}


def _token_type_from_pool(pool_name: str) -> str:
    return "ssoSuper" if "super" in pool_name.lower() else "sso"


def _token_status_label(status) -> str:
    try:
        from app.services.token.models import TokenStatus
        if status == TokenStatus.EXPIRED:
            return "失效"
        if status == TokenStatus.COOLING:
            return "冷却中"
        if status == TokenStatus.DISABLED:
            return "禁用"
    except Exception:
        pass
    return "正常"


async def _build_worker_tokens():
    from app.services.token.manager import get_token_manager
    mgr = await get_token_manager()
    tokens = []
    for pool_name, pool in mgr.pools.items():
        token_type = _token_type_from_pool(pool_name)
        for info in pool.list():
            remaining = int(info.quota) if info.quota is not None else -1
            heavy_remaining = remaining if token_type == "ssoSuper" else -1
            status_label = _token_status_label(info.status)
            limit_reason = "cooldown" if status_label == "冷却中" else ("exhausted" if remaining == 0 else "")
            tokens.append({
                "token": info.token,
                "token_type": token_type,
                "created_time": info.created_at,
                "remaining_queries": remaining,
                "heavy_remaining_queries": heavy_remaining,
                "status": status_label,
                "tags": list(info.tags or []),
                "note": info.note or "",
                "cooldown_until": None,
                "last_failure_time": info.last_fail_at,
                "last_failure_reason": info.last_fail_reason or "",
                "limit_reason": limit_reason,
                "cooldown_remaining": 0,
            })
    return tokens


@router.get("/api/tokens", dependencies=[Depends(verify_api_key)])
async def worker_list_tokens():
    tokens = await _build_worker_tokens()
    return {"success": True, "data": tokens, "total": len(tokens)}


@router.post("/api/tokens/add", dependencies=[Depends(verify_api_key)])
async def worker_add_tokens(data: dict):
    from app.services.token.service import TokenService
    tokens = data.get("tokens") or []
    token_type = data.get("token_type") or "sso"
    pool = "ssoSuper" if token_type == "ssoSuper" else "ssoBasic"
    added = 0
    for t in tokens:
        if isinstance(t, str) and t.strip():
            ok = await TokenService.add_token(t.strip(), pool)
            if ok:
                added += 1
    return {"success": True, "message": f"添加成功({added})"}


@router.post("/api/tokens/delete", dependencies=[Depends(verify_api_key)])
async def worker_delete_tokens(data: dict):
    from app.services.token.service import TokenService
    tokens = data.get("tokens") or []
    deleted = 0
    for t in tokens:
        if isinstance(t, str) and t.strip():
            ok = await TokenService.remove_token(t.strip())
            if ok:
                deleted += 1
    return {"success": True, "message": f"删除成功({deleted})"}


@router.post("/api/tokens/tags", dependencies=[Depends(verify_api_key)])
async def worker_update_token_tags(data: dict):
    from app.services.token.manager import get_token_manager
    token = data.get("token") or ""
    tags = data.get("tags") or []
    if not token:
        raise HTTPException(status_code=400, detail="Missing token")
    mgr = await get_token_manager()
    raw = token.replace("sso=", "")
    for pool in mgr.pools.values():
        info = pool.get(raw)
        if info:
            info.tags = [t.strip() for t in tags if isinstance(t, str) and t.strip()]
            await mgr._save()
            return {"success": True, "message": "标签更新成功", "tags": info.tags}
    return {"success": False, "message": "Token 不存在"}


@router.post("/api/tokens/note", dependencies=[Depends(verify_api_key)])
async def worker_update_token_note(data: dict):
    from app.services.token.manager import get_token_manager
    token = data.get("token") or ""
    note = (data.get("note") or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="Missing token")
    mgr = await get_token_manager()
    raw = token.replace("sso=", "")
    for pool in mgr.pools.values():
        info = pool.get(raw)
        if info:
            info.note = note
            await mgr._save()
            return {"success": True, "message": "备注更新成功", "note": info.note}
    return {"success": False, "message": "Token 不存在"}


@router.get("/api/tokens/tags/all", dependencies=[Depends(verify_api_key)])
async def worker_get_all_tags():
    tokens = await _build_worker_tokens()
    tags = sorted({t for item in tokens for t in (item.get("tags") or [])})
    return {"success": True, "data": tags}


@router.post("/api/tokens/test", dependencies=[Depends(verify_api_key)])
async def worker_test_token(data: dict):
    from app.services.token.manager import get_token_manager
    token = data.get("token") or ""
    if not token:
        raise HTTPException(status_code=400, detail="Missing token")
    mgr = await get_token_manager()
    raw = token.replace("sso=", "")
    for pool_name, pool in mgr.pools.items():
        info = pool.get(raw)
        if info:
            status_label = _token_status_label(info.status)
            if status_label == "失效":
                return {"success": True, "data": {"valid": False, "error_type": "expired"}}
            if status_label == "冷却中":
                return {"success": True, "data": {"valid": False, "error_type": "cooldown", "cooldown_remaining": 0}}
            if info.quota == 0:
                return {"success": True, "data": {"valid": False, "error_type": "exhausted"}}
            remaining = int(info.quota)
            heavy_remaining = remaining if _token_type_from_pool(pool_name) == "ssoSuper" else -1
            return {
                "success": True,
                "data": {
                    "valid": True,
                    "remaining_queries": remaining,
                    "heavy_remaining_queries": heavy_remaining,
                },
            }
    return {"success": True, "data": {"valid": False, "error_type": "expired"}}


@router.post("/api/tokens/refresh-all", dependencies=[Depends(verify_api_key)])
async def worker_refresh_all_tokens():
    from app.services.token.manager import get_token_manager
    mgr = await get_token_manager()
    result = await mgr.refresh_cooling_tokens()
    return {"success": True, "data": result}


@router.get("/api/tokens/refresh-progress", dependencies=[Depends(verify_api_key)])
async def worker_refresh_progress():
    return {"success": True, "data": {"status": "idle"}}


@router.get("/api/cache/size", dependencies=[Depends(verify_api_key)])
async def worker_cache_size():
    from app.services.grok.assets import DownloadService
    dl_service = DownloadService()
    image_stats = dl_service.get_stats("image")
    video_stats = dl_service.get_stats("video")
    image_mb = float(image_stats.get("size_mb") or 0)
    video_mb = float(video_stats.get("size_mb") or 0)
    total_mb = image_mb + video_mb
    return {
        "success": True,
        "data": {
            "image_size": f"{image_mb:.2f} MB",
            "video_size": f"{video_mb:.2f} MB",
            "total_size": f"{total_mb:.2f} MB",
            "image_size_bytes": int(image_mb * 1024 * 1024),
            "video_size_bytes": int(video_mb * 1024 * 1024),
            "total_size_bytes": int(total_mb * 1024 * 1024),
        },
    }


@router.get("/api/cache/list", dependencies=[Depends(verify_api_key)])
async def worker_cache_list(
    cache_type: str = "image",
    limit: int = 50,
    offset: int = 0,
):
    from app.services.grok.assets import DownloadService
    media_type = "video" if str(cache_type).lower() == "video" else "image"
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    page = offset // limit + 1
    dl_service = DownloadService()
    result = dl_service.list_files(media_type, page=page, page_size=limit)
    items = []
    for item in result.get("items", []):
        size_mb = float(item.get("size_bytes", 0)) / 1024 / 1024
        items.append({
            "name": item.get("name"),
            "size": f"{size_mb:.2f} MB",
            "mtime": item.get("mtime_ms"),
            "url": item.get("view_url"),
        })
    return {
        "success": True,
        "data": {
            "items": items,
            "total": result.get("total", 0),
            "offset": offset,
        },
    }


@router.post("/api/cache/clear", dependencies=[Depends(verify_api_key)])
async def worker_cache_clear(data: dict):
    from app.services.grok.assets import DownloadService
    cache_type = (data.get("type") or "image").lower()
    media_type = "video" if cache_type == "video" else "image"
    dl_service = DownloadService()
    result = dl_service.clear(media_type)
    return {"success": True, "result": result}


@router.post("/api/cache/clear/images", dependencies=[Depends(verify_api_key)])
async def worker_cache_clear_images():
    from app.services.grok.assets import DownloadService
    dl_service = DownloadService()
    result = dl_service.clear("image")
    return {"success": True, "result": result}


@router.post("/api/cache/clear/videos", dependencies=[Depends(verify_api_key)])
async def worker_cache_clear_videos():
    from app.services.grok.assets import DownloadService
    dl_service = DownloadService()
    result = dl_service.clear("video")
    return {"success": True, "result": result}
