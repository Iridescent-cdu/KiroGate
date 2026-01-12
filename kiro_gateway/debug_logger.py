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
调试日志模块。

每次请求创建独立目录，包含该请求的所有日志文件。

目录结构:
debug_logs/
  request_20250112_181007_820/
    request_body.json
    kiro_request_body.json
    response_body.json
    response_stream_raw.txt
    response_stream_modified.txt
    app_logs.txt
    error_info.json

支持三种模式 (DEBUG_MODE):
- off: логирование отключено
- errors: логи сохраняются только при ошибках (4xx, 5xx)
- all: сохраняются все запросы
"""

import io
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional
from loguru import logger

from kiro_gateway.config import DEBUG_MODE, DEBUG_DIR


class DebugLogger:
    """
    Синглтон для управления отладочными логами запросов.

    每次请求创建独立目录，包含所有相关日志。
    """
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(DebugLogger, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self.base_debug_dir = Path(DEBUG_DIR)
        self._current_request_dir: Optional[Path] = None
        self._initialized = True

        # Буферы для режима "errors"
        self._request_body_buffer: Optional[bytes] = None
        self._kiro_request_body_buffer: Optional[bytes] = None
        self._response_body_buffer: Optional[bytes] = None
        self._raw_chunks_buffer: bytearray = bytearray()
        self._modified_chunks_buffer: bytearray = bytearray()

        # Буфер для логов приложения (loguru)
        self._app_logs_buffer: io.StringIO = io.StringIO()
        self._loguru_sink_id: Optional[int] = None

    def _is_enabled(self) -> bool:
        """Проверяет, включено ли логирование."""
        return DEBUG_MODE in ("errors", "all")

    def _is_immediate_write(self) -> bool:
        """Проверяет, нужно ли писать сразу в файлы (режим all)."""
        return DEBUG_MODE == "all"

    @property
    def current_dir(self) -> Path:
        """获取当前请求的日志目录."""
        if self._current_request_dir is None:
            raise RuntimeError("Request directory not initialized. Call prepare_new_request() first.")
        return self._current_request_dir

    def _clear_buffers(self):
        """Очищает все буферы."""
        self._request_body_buffer = None
        self._kiro_request_body_buffer = None
        self._response_body_buffer = None
        self._raw_chunks_buffer.clear()
        self._modified_chunks_buffer.clear()
        self._clear_app_logs_buffer()

    def _clear_app_logs_buffer(self):
        """Очищает буфер логов приложения и удаляет sink."""
        if self._loguru_sink_id is not None:
            try:
                logger.remove(self._loguru_sink_id)
            except ValueError:
                pass
            self._loguru_sink_id = None
        self._app_logs_buffer = io.StringIO()

    def _setup_app_logs_capture(self):
        """Настраивает захват логов приложения в буфер."""
        self._clear_app_logs_buffer()
        self._loguru_sink_id = logger.add(
            self._app_logs_buffer,
            format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {name}:{function}:{line} | {message}",
            level="DEBUG",
            colorize=False,
        )

    def prepare_new_request(self):
        """
        为新请求创建独立的日志目录。

        目录名格式: request_YYYYMMDD_HHMMSS_mmm
        """
        if not self._is_enabled():
            return

        self._clear_buffers()
        self._setup_app_logs_capture()

        # 创建新的请求目录
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
        self._current_request_dir = self.base_debug_dir / f"request_{timestamp}"

        if self._is_immediate_write():
            self._ensure_directory_exists()
            logger.debug(f"[DebugLogger] New request directory: {self._current_request_dir}")

    def _ensure_directory_exists(self):
        """确保当前请求目录存在."""
        self._current_request_dir.mkdir(parents=True, exist_ok=True)

    def log_request_body(self, body: bytes):
        """Сохраняет тело запроса (от клиента)."""
        if not self._is_enabled():
            return

        if self._is_immediate_write():
            self._write_request_body_to_file(body)
        else:
            self._request_body_buffer = body

    def log_kiro_request_body(self, body: bytes):
        """Сохраняет тело запроса к Kiro API."""
        if not self._is_enabled():
            return

        if self._is_immediate_write():
            self._write_kiro_request_body_to_file(body)
        else:
            self._kiro_request_body_buffer = body

    def log_response_body(self, response: dict):
        """Сохраняет тело ответа (non-streaming)."""
        if not self._is_enabled():
            return

        response_bytes = json.dumps(response, ensure_ascii=False, indent=2).encode('utf-8')

        if self._is_immediate_write():
            self._write_response_body_to_file(response_bytes)
        else:
            self._response_body_buffer = response_bytes

    def log_raw_chunk(self, chunk: bytes):
        """Дописывает сырой чанк ответа (от провайдера)."""
        if not self._is_enabled():
            return

        if self._is_immediate_write():
            self._append_raw_chunk_to_file(chunk)
        else:
            self._raw_chunks_buffer.extend(chunk)

    def log_modified_chunk(self, chunk: bytes):
        """Дописывает модифицированный чанк (клиенту)."""
        if not self._is_enabled():
            return

        if self._is_immediate_write():
            self._append_modified_chunk_to_file(chunk)
        else:
            self._modified_chunks_buffer.extend(chunk)

    def log_error_info(self, status_code: int, error_message: str = ""):
        """Записывает информацию об ошибке в файл."""
        if not self._is_enabled():
            return

        try:
            self._ensure_directory_exists()
            error_info = {
                "status_code": status_code,
                "error_message": error_message
            }
            error_file = self.current_dir / "error_info.json"
            with open(error_file, "w", encoding="utf-8") as f:
                json.dump(error_info, f, indent=2, ensure_ascii=False)
            logger.debug(f"[DebugLogger] Error info saved (status={status_code})")
        except Exception as e:
            logger.error(f"[DebugLogger] Error writing error_info: {e}")

    def flush_on_error(self, status_code: int, error_message: str = ""):
        """
        Сбрасывает буферы в файлы при ошибке (режим "errors").
        """
        if not self._is_enabled():
            return

        if self._is_immediate_write():
            self.log_error_info(status_code, error_message)
            self._write_app_logs_to_file()
            self._clear_app_logs_buffer()
            return

        # 检查是否有数据需要写入
        if not any([
            self._request_body_buffer,
            self._kiro_request_body_buffer,
            self._response_body_buffer,
            self._raw_chunks_buffer,
            self._modified_chunks_buffer
        ]):
            return

        try:
            self._ensure_directory_exists()

            if self._request_body_buffer:
                self._write_request_body_to_file(self._request_body_buffer)
            if self._kiro_request_body_buffer:
                self._write_kiro_request_body_to_file(self._kiro_request_body_buffer)
            if self._response_body_buffer:
                self._write_response_body_to_file(self._response_body_buffer)
            if self._raw_chunks_buffer:
                file_path = self.current_dir / "response_stream_raw.txt"
                with open(file_path, "wb") as f:
                    f.write(self._raw_chunks_buffer)
            if self._modified_chunks_buffer:
                file_path = self.current_dir / "response_stream_modified.txt"
                with open(file_path, "wb") as f:
                    f.write(self._modified_chunks_buffer)

            self.log_error_info(status_code, error_message)
            self._write_app_logs_to_file()

            logger.info(f"[DebugLogger] Error logs flushed to {self.current_dir} (status={status_code})")

        except Exception as e:
            logger.error(f"[DebugLogger] Error flushing buffers: {e}")
        finally:
            self._clear_buffers()

    def discard_buffers(self):
        """
        Очищает буферы без записи в файлы (режим "errors").
        В режиме "all" сохраняет логи успешного запроса.
        """
        if DEBUG_MODE == "errors":
            self._clear_buffers()
        elif DEBUG_MODE == "all":
            self._write_app_logs_to_file()
            self._clear_app_logs_buffer()

    # ==================== 文件写入方法 ====================

    def _write_request_body_to_file(self, body: bytes):
        """Записывает тело запроса в файл."""
        try:
            self._ensure_directory_exists()
            file_path = self.current_dir / "request_body.json"
            try:
                json_obj = json.loads(body)
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(json_obj, f, indent=2, ensure_ascii=False)
            except json.JSONDecodeError:
                with open(file_path, "wb") as f:
                    f.write(body)
        except Exception as e:
            logger.error(f"[DebugLogger] Error writing request_body: {e}")

    def _write_kiro_request_body_to_file(self, body: bytes):
        """Записывает тело запроса к Kiro в файл."""
        try:
            self._ensure_directory_exists()
            file_path = self.current_dir / "kiro_request_body.json"
            try:
                json_obj = json.loads(body)
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(json_obj, f, indent=2, ensure_ascii=False)
            except json.JSONDecodeError:
                with open(file_path, "wb") as f:
                    f.write(body)
        except Exception as e:
            logger.error(f"[DebugLogger] Error writing kiro_request_body: {e}")

    def _write_response_body_to_file(self, body: bytes):
        """Записывает тело ответа в файл."""
        try:
            self._ensure_directory_exists()
            file_path = self.current_dir / "response_body.json"
            try:
                json_obj = json.loads(body)
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(json_obj, f, indent=2, ensure_ascii=False)
            except json.JSONDecodeError:
                with open(file_path, "wb") as f:
                    f.write(body)
        except Exception as e:
            logger.error(f"[DebugLogger] Error writing response_body: {e}")

    def _append_raw_chunk_to_file(self, chunk: bytes):
        """Дописывает сырой чанк в файл."""
        try:
            self._ensure_directory_exists()
            file_path = self.current_dir / "response_stream_raw.txt"
            with open(file_path, "ab") as f:
                f.write(chunk)
        except Exception:
            pass

    def _append_modified_chunk_to_file(self, chunk: bytes):
        """Дописывает модифицированный чанк в файл."""
        try:
            self._ensure_directory_exists()
            file_path = self.current_dir / "response_stream_modified.txt"
            with open(file_path, "ab") as f:
                f.write(chunk)
        except Exception:
            pass

    def _write_app_logs_to_file(self):
        """Записывает захваченные логи приложения в файл."""
        try:
            logs_content = self._app_logs_buffer.getvalue()
            if not logs_content.strip():
                return
            self._ensure_directory_exists()
            file_path = self.current_dir / "app_logs.txt"
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(logs_content)
            logger.debug(f"[DebugLogger] App logs saved to {file_path}")
        except Exception as e:
            pass


# Глобальный экземпляр
debug_logger = DebugLogger()
