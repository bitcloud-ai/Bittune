"""The stdin/stdout JSONL protocol between the Node Runtime and the Core.

Every line on stdin is one of two messages: `request` (carrying a Runtime-
generated `request_id`, the tool name and parameters) or `cancel` (for the
in-flight request). The Core answers on stdout with `progress` and `result`
lines. There is no HTTP, socket, daemon or listening port: the Core lives and
dies with the Runtime session, and each session allows at most one in-flight
request, matching the Agent's serial tool model.
"""

import json
import queue
import sys
import threading
import traceback
from typing import Any, Callable

from bittune_core.contracts import ContractError


class ProtocolError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_result(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            error["details"] = self.details
        return error


class Cancellation:
    """Cancel flag for the in-flight request.

    A reader thread feeds stdin lines into a queue while the handler runs, so
    a `cancel` can arrive after the request started. Handlers call
    `raise_if_requested()` between their own steps; subprocess-backed
    handlers (later phases) additionally pass this to the child runner.
    """

    def __init__(self, request_id: str):
        self.request_id = request_id
        self._event = threading.Event()

    def trigger(self) -> None:
        self._event.set()

    def raise_if_requested(self) -> None:
        if self._event.is_set():
            raise ContractError("cancelled", "Operation cancelled.", remediation="The request was cancelled by the Runtime.")


class Channel:
    """Line-oriented exchange over two text streams."""

    def __init__(self, stdin, stdout):
        self.stdin = stdin
        self.stdout = stdout
        self._write_lock = threading.Lock()
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._reader: threading.Thread | None = None

    def start_reader(self) -> None:
        if self._reader is not None:
            return
        self._reader = threading.Thread(target=self._read_loop, name="core-stdin-reader", daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        for line in self.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self._queue.put({"type": "malformed", "line": line[:200]})
                continue
            if isinstance(message, dict) and isinstance(message.get("type"), str):
                self._queue.put(message)
            else:
                self._queue.put({"type": "malformed", "line": line[:200]})
        self._queue.put({"type": "eof"})

    def emit(self, message: dict[str, Any]) -> None:
        payload = json.dumps(message, ensure_ascii=False)
        with self._write_lock:
            self.stdout.write(payload + "\n")
            self.stdout.flush()

    def next_message(self, timeout: float | None = None) -> dict[str, Any]:
        return self._queue.get(timeout=timeout)


def validate_request(message: dict[str, Any]) -> tuple[str, str, str, dict[str, Any]]:
    """Return (request_id, session_id, tool, params) or raise ProtocolError."""
    request_id = message.get("request_id")
    session_id = message.get("session_id")
    tool = message.get("tool")
    params = message.get("params")
    for value, label in ((request_id, "request_id"), (session_id, "session_id")):
        if not isinstance(value, str) or not value or len(value) > 128:
            raise ProtocolError("invalid_request", f"{label} is required (1-128 chars).")
        for character in value:
            if not (character.isalnum() or character in "._-"):
                raise ProtocolError("invalid_request", f"{label} contains unsupported characters.")
    if not isinstance(tool, str) or not tool:
        raise ProtocolError("invalid_request", "tool is required.")
    if params is None:
        params_value: dict[str, Any] = {}
    elif isinstance(params, dict):
        params_value = params
    else:
        raise ProtocolError("invalid_request", "params must be an object.")
    return request_id, session_id, tool, params_value


Handler = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]


class Server:
    """Runs one request at a time: validates, dispatches, honors mid-flight
    cancellations and maps every failure to a stable error result."""

    def __init__(self, channel: Channel, handlers: dict[str, Handler]):
        self.channel = channel
        self.handlers = handlers
        # Set when stdin EOF is observed while a request is in flight: the
        # session loop must exit whether or not the handler answered, or
        # run_forever would block forever on the dead reader queue.
        self.ended = False

    def run_forever(self) -> None:
        while True:
            message = self.channel.next_message()
            if self._handle_queued(message):
                break

    def _handle_queued(self, message: dict[str, Any]) -> bool:
        """Handle one queued message; returns True when the loop must exit."""
        kind = message.get("type")
        if kind == "eof":
            return True
        if kind == "cancel":
            # Cancellation only applies to the in-flight request (handled by
            # the request pump); a stale or unknown request id is ignored.
            return False
        if kind == "malformed":
            self._emit_error(None, "invalid_request", f"非法 JSONL 帧：{message.get('line', '')[:160]}")
            return False
        if kind != "request":
            self._emit_error(message.get("request_id"), "invalid_request", f"未知消息类型 {kind!r}。")
            return False
        try:
            request_id, session_id, tool, params = validate_request(message)
        except ProtocolError as error:
            self._emit_error(message.get("request_id"), error.code, error.message, error.details)
            return False
        self._serve_request(request_id, session_id, tool, params)
        return self.ended

    def _serve_request(self, request_id: str, session_id: str, tool: str, params: dict[str, Any]) -> None:
        handler = self.handlers.get(tool)
        if handler is None:
            self._emit_error(request_id, "tool_not_found", f"未知 Core 工具 {tool}。", {"tool": tool})
            return
        cancellation = Cancellation(request_id)
        context: dict[str, Any] = {
            "request_id": request_id,
            "session_id": session_id,
            "cancellation": cancellation,
            "emit_progress": self._progress_emitter(request_id),
        }
        outcome: dict[str, tuple[str, dict[str, Any]]] = {}

        def runner() -> None:
            try:
                outcome["result"] = ("ok", handler(params, context))
            except ContractError as error:
                outcome["result"] = ("error", error.to_result())
            except Exception as error:  # noqa: BLE001 - boundary: never leak internals
                traceback.print_exc(file=sys.stderr)
                outcome["result"] = ("error", {"code": "internal", "message": f"Core 未能完成 {tool}。"})

        thread = threading.Thread(target=runner, name=f"core-{tool}", daemon=True)
        thread.start()
        while thread.is_alive():
            try:
                message = self.channel.next_message(timeout=0.2)
            except queue.Empty:
                continue
            kind = message.get("type")
            if kind == "cancel" and message.get("request_id") == request_id:
                cancellation.trigger()
            elif kind == "request":
                self._emit_error(
                    message.get("request_id"),
                    "protocol_busy",
                    "同一时刻只允许一个在途 Core 请求。",
                    {"in_flight_request_id": request_id},
                )
            elif kind == "eof":
                # The Runtime closed stdin: wake the handler to stop, then
                # wait briefly before reporting unavailability. Either way the
                # session is over - the eof frame is consumed here, so the
                # loop must not wait for another message.
                self.ended = True
                cancellation.trigger()
                thread.join(timeout=5)
                if thread.is_alive():
                    self._emit_error(request_id, "core_unavailable", "Core 进程在请求完成前关闭。")
                    return
                break
        thread.join()
        if "result" not in outcome:
            self._emit_error(request_id, "core_unavailable", "Core 进程在请求完成前关闭。")
            return
        kind, payload = outcome["result"]
        if kind == "ok":
            self.channel.emit({"type": "result", "request_id": request_id, "ok": True, "data": payload})
        else:
            self.channel.emit({"type": "result", "request_id": request_id, "ok": False, "error": payload})

    def _progress_emitter(self, request_id: str):
        def emit_progress(message: str, data: dict[str, Any] | None = None) -> None:
            progress: dict[str, Any] = {"type": "progress", "request_id": request_id, "message": message}
            if data:
                progress["data"] = data
            self.channel.emit(progress)

        return emit_progress

    def _emit_error(self, request_id: str | None, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if details:
            error["details"] = details
        self.channel.emit({"type": "result", "request_id": request_id or "", "ok": False, "error": error})