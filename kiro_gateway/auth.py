# -*- coding: utf-8 -*-

# KiroGate
# Based on kiro-openai-gateway by Jwadow (https://github.com/Jwadow/kiro-openai-gateway)
# Original Copyright (C) 2025 Jwadow
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""
Kiro API Authentication Manager.

Manages access token lifecycle:
- Load credentials from .env or JSON file
- Auto-refresh token on expiration
- Thread-safe refresh using asyncio.Lock
"""

import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from loguru import logger

from kiro_gateway.config import (
    TOKEN_REFRESH_THRESHOLD,
    get_kiro_refresh_url,
    get_kiro_api_host,
    get_kiro_q_host,
    get_oidc_token_url,
)
from kiro_gateway.utils import get_machine_fingerprint


class KiroAuthManager:
    """
    Manages token lifecycle for Kiro API access.

    Supports:
    - Loading credentials from .env or JSON file
    - Auto-refresh token on expiration
    - Checking expiration time (expiresAt)
    - Saving updated tokens to file

    Attributes:
        profile_arn: AWS CodeWhisperer profile ARN
        region: AWS region
        api_host: API host for current region
        q_host: Q API host for current region
        fingerprint: Unique machine fingerprint

    Example:
        >>> auth_manager = KiroAuthManager(
        ...     refresh_token="your_refresh_token",
        ...     region="us-east-1"
        ... )
        >>> token = await auth_manager.get_access_token()
    """

    def __init__(
        self,
        refresh_token: Optional[str] = None,
        profile_arn: Optional[str] = None,
        region: str = "us-east-1",
        oidc_client_id: Optional[str] = None,
        oidc_client_secret: Optional[str] = None,
        use_oidc_refresh: bool = True,
        sso_cache_dir: Optional[str] = None,
    ):
        """
        Initialize authentication manager.

        Args:
            refresh_token: Refresh token for obtaining access token
            profile_arn: AWS CodeWhisperer profile ARN
            region: AWS region (default us-east-1)
            creds_file: Path to JSON credentials file (optional)
        """
        self._refresh_token = refresh_token
        self._profile_arn = profile_arn
        self._region = region
        self._oidc_client_id = oidc_client_id
        self._oidc_client_secret = oidc_client_secret
        self._oidc_token_url = get_oidc_token_url(region)
        self._sso_cache_dir = sso_cache_dir

        if not (self._oidc_client_id and self._oidc_client_secret):
            self._auto_load_oidc_client_from_cache(self._sso_cache_dir)

        if not self._refresh_token:
            self._auto_load_refresh_from_sso_cache(self._sso_cache_dir)

        self._use_oidc_refresh = use_oidc_refresh and bool(
            self._oidc_client_id and self._oidc_client_secret
        )

        self._access_token: Optional[str] = None
        self._expires_at: Optional[datetime] = None
        self._lock = asyncio.Lock()

        # Dynamic URLs based on region
        self._refresh_url = get_kiro_refresh_url(region)
        self._api_host = get_kiro_api_host(region)
        self._q_host = get_kiro_q_host(region)

        # Fingerprint for User-Agent
        self._fingerprint = get_machine_fingerprint()

    @staticmethod
    def _is_url(path: str) -> bool:
        """Check if path is a URL."""
        return path.startswith(("http://", "https://"))

    def _load_credentials_from_file(self, file_path: str) -> None:
        """
        Load credentials from JSON file or remote URL.

        Supported fields in JSON:
        - refreshToken: Refresh token
        - accessToken: Access token (if already available)
        - profileArn: Profile ARN
        - region: AWS region
        - expiresAt: Token expiration time (ISO 8601)

        Args:
            file_path: Path to JSON file or remote URL (http/https)
        """
        try:
            if self._is_url(file_path):
                # Fetch from remote URL
                response = httpx.get(file_path, timeout=10.0, follow_redirects=True)
                response.raise_for_status()
                data = response.json()
                logger.info(f"Credentials loaded from URL: {file_path}")
            else:
                # Load from local file
                path = Path(file_path).expanduser()
                if not path.exists():
                    logger.warning(f"Credentials file not found: {file_path}")
                    return

                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                logger.info(f"Credentials loaded from file: {file_path}")

            if "refreshToken" in data:
                self._refresh_token = data["refreshToken"]
            if "accessToken" in data:
                self._access_token = data["accessToken"]
            if "profileArn" in data:
                self._profile_arn = data["profileArn"]
            if "region" in data:
                self._region = data["region"]
                # Update URLs for new region
                self._refresh_url = get_kiro_refresh_url(self._region)
                self._api_host = get_kiro_api_host(self._region)
                self._q_host = get_kiro_q_host(self._region)

            # Parse expiresAt
            if "expiresAt" in data:
                try:
                    expires_str = data["expiresAt"]
                    if expires_str.endswith("Z"):
                        self._expires_at = datetime.fromisoformat(
                            expires_str.replace("Z", "+00:00")
                        )
                    else:
                        self._expires_at = datetime.fromisoformat(expires_str)
                except Exception as e:
                    logger.warning(f"Failed to parse expiresAt: {e}")

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error loading credentials from URL: {e}")
        except httpx.RequestError as e:
            logger.error(f"Request error loading credentials from URL: {e}")
        except Exception as e:
            logger.error(f"Error loading credentials: {e}")

    def is_token_expiring_soon(self) -> bool:
        """
        Check if token is expiring soon.

        Returns:
            True if token expires within TOKEN_REFRESH_THRESHOLD seconds
            or if expiration info is missing
        """
        if not self._expires_at:
            return True

        now = datetime.now(timezone.utc)
        threshold = now.timestamp() + TOKEN_REFRESH_THRESHOLD

        return self._expires_at.timestamp() <= threshold

    async def _refresh_token_request(self) -> None:
        """
        Execute token refresh request with exponential backoff retry.

        Supports two strategies:
        - OIDC (AWS SSO) token endpoint (default if OIDC client configured)
        - Legacy Kiro refresh endpoint
        """
        if not self._refresh_token:
            raise ValueError("Refresh token is not set")

        if self._use_oidc_refresh:
            data = await self._refresh_token_request_oidc()
        else:
            data = await self._refresh_token_request_kiro()

        self._apply_refresh_response(data)

    def _auto_load_oidc_client_from_cache(
        self, cache_dir: Optional[str] = None
    ) -> None:
        """
        Auto-load OIDC clientId/clientSecret from AWS SSO cache if not provided.

        Scans ~/.aws/sso/cache/*.json (or provided cache_dir) for clientId/clientSecret,
        preferring the most recently modified file.
        """
        try:
            base_dir = self._get_sso_cache_dir(cache_dir)
            if not base_dir.exists():
                return

            files = sorted(
                base_dir.glob("*.json"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            for f in files:
                try:
                    with open(f, "r", encoding="utf-8") as fp:
                        data = json.load(fp)
                    cid = data.get("clientId")
                    csec = data.get("clientSecret")
                    if cid and csec:
                        self._oidc_client_id = cid
                        self._oidc_client_secret = csec
                        logger.info(f"Loaded OIDC clientId/clientSecret from {f}")
                        return
                except Exception as inner:
                    logger.debug(f"Skip cache file {f}: {inner}")
        except Exception as e:
            logger.warning(f"Failed to auto load OIDC client from cache: {e}")

    def _auto_load_refresh_from_sso_cache(
        self, cache_dir: Optional[str] = None
    ) -> None:
        """
        Load refreshToken from SSO cache (kiro-auth-token.json) if available.
        """
        try:
            base_dir = (
                Path(cache_dir).expanduser()
                if cache_dir
                else Path.home() / ".aws/sso/cache"
            )
            if not base_dir.exists():
                return

            preferred = base_dir / "kiro-auth-token.json"
            candidates = []
            if preferred.exists():
                candidates.append(preferred)
            candidates.extend(
                sorted(
                    (p for p in base_dir.glob("*.json") if p != preferred),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
            )

            for f in candidates:
                try:
                    with open(f, "r", encoding="utf-8") as fp:
                        data = json.load(fp)
                    rt = data.get("refreshToken")
                    if rt:
                        self._refresh_token = rt
                        logger.info(f"Loaded refreshToken from {f}")
                        return
                except Exception as inner:
                    logger.debug(f"Skip cache file {f}: {inner}")
        except Exception as e:
            logger.warning(f"Failed to load refreshToken from SSO cache: {e}")

    def _persist_tokens_to_sso_cache(self) -> None:
        """
        Persist refreshed tokens to SSO cache file (kiro-auth-token.json).
        """
        try:
            base_dir = self._get_sso_cache_dir(self._sso_cache_dir)
            base_dir.mkdir(parents=True, exist_ok=True)
            file_path = base_dir / "kiro-auth-token.json"

            data = {
                "refreshToken": self._refresh_token,
                "accessToken": self._access_token,
                "profileArn": self._profile_arn,
                "region": self._region,
                "expiresAt": self._expires_at.isoformat() if self._expires_at else None,
            }

            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)

            logger.debug(f"Persisted tokens to {file_path}")
        except Exception as e:
            logger.warning(f"Failed to persist tokens to SSO cache: {e}")

    def _get_sso_cache_dir(self, cache_dir: Optional[str] = None) -> Path:
        """
        Resolve SSO cache directory.
        """
        return (
            Path(cache_dir).expanduser()
            if cache_dir
            else Path.home() / ".aws/sso/cache"
        )

    async def _refresh_token_request_kiro(self) -> dict:
        """Refresh via Kiro refreshToken endpoint."""
        logger.info("Refreshing Kiro token (legacy endpoint)...")

        payload = {"refreshToken": self._refresh_token}
        headers = {
            "Content-Type": "application/json",
            "User-Agent": f"KiroGateway-{self._fingerprint[:16]}",
        }

        max_retries = 3
        base_delay = 1.0
        last_error = None

        for attempt in range(max_retries):
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    response = await client.post(
                        self._refresh_url, json=payload, headers=headers
                    )
                    response.raise_for_status()
                    return response.json()
            except httpx.HTTPStatusError as e:
                last_error = e
                if e.response.status_code in (429, 500, 502, 503, 504):
                    delay = base_delay * (2**attempt)
                    logger.warning(
                        f"Token refresh failed (attempt {attempt + 1}/{max_retries}): "
                        f"HTTP {e.response.status_code}, retrying in {delay}s"
                    )
                    await asyncio.sleep(delay)
                else:
                    raise
            except (httpx.ConnectError, httpx.TimeoutException) as e:
                last_error = e
                delay = base_delay * (2**attempt)
                logger.warning(
                    f"Token refresh failed (attempt {attempt + 1}/{max_retries}): "
                    f"{type(e).__name__}, retrying in {delay}s"
                )
                await asyncio.sleep(delay)

        logger.error(f"Token refresh failed after {max_retries} attempts")
        raise last_error

    async def _refresh_token_request_oidc(self) -> dict:
        """Refresh via AWS SSO OIDC token endpoint using refresh_token grant."""
        if not self._oidc_client_id or not self._oidc_client_secret:
            raise ValueError("OIDC clientId/clientSecret not set")

        url = self._oidc_token_url or get_oidc_token_url(self._region)
        payload = {
            "clientId": self._oidc_client_id,
            "clientSecret": self._oidc_client_secret,
            "grantType": "refresh_token",
            "refreshToken": self._refresh_token,
        }
        headers = {
            "Content-Type": "application/json",
            "User-Agent": f"aws-sdk-js/3.x KiroGateway-{self._fingerprint[:16]}",
            "x-amz-user-agent": f"aws-sdk-js/3.x KiroGateway-{self._fingerprint[:16]}",
            "amz-sdk-invocation-id": str(uuid.uuid4()),
            "amz-sdk-request": "attempt=1; max=4",
        }

        max_retries = 3
        base_delay = 1.0
        last_error = None

        for attempt in range(max_retries):
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    response = await client.post(url, json=payload, headers=headers)
                    response.raise_for_status()
                    return response.json()
            except httpx.HTTPStatusError as e:
                last_error = e
                if e.response.status_code in (429, 500, 502, 503, 504):
                    delay = base_delay * (2**attempt)
                    logger.warning(
                        f"OIDC token refresh failed (attempt {attempt + 1}/{max_retries}): "
                        f"HTTP {e.response.status_code}, retrying in {delay}s"
                    )
                    await asyncio.sleep(delay)
                else:
                    raise
            except (httpx.ConnectError, httpx.TimeoutException) as e:
                last_error = e
                delay = base_delay * (2**attempt)
                logger.warning(
                    f"OIDC token refresh failed (attempt {attempt + 1}/{max_retries}): "
                    f"{type(e).__name__}, retrying in {delay}s"
                )
                await asyncio.sleep(delay)

        logger.error(f"OIDC token refresh failed after {max_retries} attempts")
        raise last_error

    def _apply_refresh_response(self, data: dict) -> None:
        """
        Apply refresh response to internal state and persist credentials.
        """
        new_access_token = data.get("accessToken")
        new_refresh_token = data.get("refreshToken")
        expires_in = data.get("expiresIn", 3600)
        new_profile_arn = data.get("profileArn")

        if not new_access_token:
            raise ValueError(f"Response does not contain accessToken: {data}")

        now = datetime.now(timezone.utc).replace(microsecond=0)
        new_expires_at = datetime.fromtimestamp(
            now.timestamp() + expires_in - 60, tz=timezone.utc
        )

        self._access_token = new_access_token
        if new_refresh_token:
            self._refresh_token = new_refresh_token
        if new_profile_arn:
            self._profile_arn = new_profile_arn
        self._expires_at = new_expires_at

        # 持久化到 SSO 缓存（如果可写）
        self._persist_tokens_to_sso_cache()

        logger.info(f"Token refreshed, expires: {self._expires_at.isoformat()}")

    async def get_access_token(self) -> str:
        """
        Return valid access_token, refreshing if necessary.

        Thread-safe method using asyncio.Lock.
        Automatically refreshes token if expired or expiring soon.

        Returns:
            Valid access token

        Raises:
            ValueError: If unable to obtain access token
        """
        async with self._lock:
            if not self._access_token or self.is_token_expiring_soon():
                await self._refresh_token_request()

            if not self._access_token:
                raise ValueError("Failed to obtain access token")

            return self._access_token

    async def force_refresh(self) -> str:
        """
        Force token refresh.

        Used when receiving 403 error from API.

        Returns:
            New access token
        """
        async with self._lock:
            await self._refresh_token_request()
            return self._access_token

    @property
    def profile_arn(self) -> Optional[str]:
        """AWS CodeWhisperer profile ARN."""
        return self._profile_arn

    @property
    def region(self) -> str:
        """AWS region."""
        return self._region

    @property
    def api_host(self) -> str:
        """API host for current region."""
        return self._api_host

    @property
    def q_host(self) -> str:
        """Q API host for current region."""
        return self._q_host

    @property
    def fingerprint(self) -> str:
        """Unique machine fingerprint."""
        return self._fingerprint
