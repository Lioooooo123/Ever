from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, FinalMetrics, Metrics, Step, ToolCall, Trajectory
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json

NODE_VERSION = "22.23.2"
NODE_SHA256 = {
    "arm64": "fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8",
    "x64": "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
}


def _artifact_digest(path: Path) -> str:
    digest = hashlib.sha256()
    if path.is_file():
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    if not path.is_dir():
        raise FileNotFoundError(f"Ever artifact not found: {path}")
    children = sorted(
        path.rglob("*"), key=lambda child: child.relative_to(path).as_posix().encode("utf-8")
    )
    for child in children:
        if child.is_symlink():
            raise ValueError(f"Ever artifact symlinks are not allowed: {child}")
        if not child.is_file():
            continue
        digest.update(child.relative_to(path).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with child.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
            parts.append(item["text"])
    return "\n".join(parts)


def _tool_calls(content: Any) -> list[ToolCall]:
    if not isinstance(content, list):
        return []
    calls: list[ToolCall] = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "toolCall":
            continue
        call_id = item.get("id")
        name = item.get("name")
        arguments = item.get("arguments")
        if isinstance(call_id, str) and isinstance(name, str) and isinstance(arguments, dict):
            calls.append(ToolCall(tool_call_id=call_id, function_name=name, arguments=arguments))
    return calls


class EverAgent(BaseInstalledAgent):
    SUPPORTS_ATIF = True
    SUPPORTS_WINDOWS = False

    def __init__(
        self,
        *args: Any,
        artifact_path: str,
        artifact_sha256: str,
        command: str,
        credential_file_env: str | None = None,
        max_turns: int | None = None,
        max_wall_time_minutes: int = 60,
        max_cost_usd: float | None = None,
        **kwargs: Any,
    ) -> None:
        self._artifact_path = Path(artifact_path).resolve()
        self._artifact_sha256 = artifact_sha256
        self._command = command
        self._credential_file_env = credential_file_env
        self._max_turns = max_turns
        self._max_wall_time_minutes = max_wall_time_minutes
        self._max_cost_usd = max_cost_usd
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "ever"

    async def install(self, environment: BaseEnvironment) -> None:
        actual_digest = _artifact_digest(self._artifact_path)
        if actual_digest != self._artifact_sha256:
            raise ValueError(
                f"Ever artifact digest mismatch: expected {self._artifact_sha256}, got {actual_digest}"
            )
        if Path(self._command).is_absolute() or ".." in Path(self._command).parts:
            raise ValueError("Ever artifact command must be a relative path without '..'")
        await self.ensure_system_dependencies(
            environment,
            (
                "bash",
                "curl",
                "xz",
                "ca_certificates",
                "ripgrep",
                "procps",
                "coreutils",
                "bubblewrap",
                "socat",
            ),
        )
        node_install = (
            "set -eu; "
            'case "$(uname -m)" in '
            f"aarch64|arm64) node_arch=arm64; node_sha={NODE_SHA256['arm64']} ;; "
            f"x86_64|amd64) node_arch=x64; node_sha={NODE_SHA256['x64']} ;; "
            '*) echo "Unsupported Node architecture: $(uname -m)" >&2; exit 1 ;; '
            "esac; "
            f'node_archive="node-v{NODE_VERSION}-linux-${{node_arch}}.tar.xz"; '
            'node_temp="$(mktemp -d)"; '
            f'curl --fail --silent --show-error --location "https://nodejs.org/dist/v{NODE_VERSION}/${{node_archive}}" '
            '--output "${node_temp}/${node_archive}"; '
            'printf "%s  %s\\n" "${node_sha}" "${node_temp}/${node_archive}" | sha256sum --check --status; '
            "mkdir -p /opt/node; "
            'tar -xJf "${node_temp}/${node_archive}" --strip-components=1 -C /opt/node; '
            "/opt/node/bin/node --version"
        )
        await self.exec_as_root(environment, command=node_install)
        if self._artifact_path.is_dir():
            await environment.upload_dir(self._artifact_path, "/opt/ever")
        else:
            remote_parent = Path("/opt/ever", self._command).parent.as_posix()
            await self.exec_as_root(environment, command=f"mkdir -p {shlex.quote(remote_parent)}")
            await environment.upload_file(self._artifact_path, f"/opt/ever/{self._command}")
        await self.exec_as_root(
            environment,
            command=f"chmod -R a+rX /opt/ever && chmod a+x {shlex.quote('/opt/ever/' + self._command)}",
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Ever model_name must be pinned as provider/model")
        provider, model = self.model_name.split("/", 1)
        remote_home = "/tmp/ever-agent"
        await self.exec_as_agent(environment, command=f"mkdir -p {remote_home} {EnvironmentPaths.agent_dir}")
        if self._credential_file_env is not None:
            credential_path = self._get_env(self._credential_file_env)
            if not credential_path:
                raise ValueError(f"Missing credential file environment variable {self._credential_file_env}")
            await environment.upload_file(credential_path, f"{remote_home}/auth.json")
            ownership = ""
            if environment.default_user is not None:
                ownership = f"chown {shlex.quote(str(environment.default_user))} {remote_home}/auth.json && "
            await self.exec_as_root(
                environment,
                command=f"{ownership}chmod 600 {remote_home}/auth.json",
            )
        ever = ["/opt/node/bin/node", f"/opt/ever/{self._command}"]
        command_env = {
            "EVER_CODING_AGENT_DIR": remote_home,
            "EVER_UNATTENDED_SANDBOX": "1",
        }
        current = await self.exec_as_agent(environment, command="pwd")
        workspace_root = (current.stdout or "").strip()
        if current.return_code != 0 or not workspace_root.startswith("/"):
            raise RuntimeError("Cannot resolve Harbor task workspace")
        manifest = {
            "schemaVersion": 1,
            "goal": instruction,
            "title": "Harbor external Eval",
            "workspaceRoot": workspace_root,
            "unattendedApproved": True,
            "model": {"provider": provider, "id": model},
            "limits": {
                "maxTurns": self._max_turns or 100,
                "maxWallTimeMinutes": self._max_wall_time_minutes,
                **({"maxCostUsd": self._max_cost_usd} if self._max_cost_usd is not None else {}),
            },
        }
        encoded_manifest = base64.b64encode(json.dumps(manifest).encode("utf-8")).decode("ascii")
        manifest_path = "/tmp/ever-eval-task.json"
        write_manifest = await self.exec_as_agent(
            environment,
            command=f"printf %s {shlex.quote(encoded_manifest)} | base64 -d > {manifest_path}",
        )
        if write_manifest.return_code != 0:
            raise RuntimeError("Cannot write Ever Task manifest")
        submit_command = ever + ["task", "submit", "--manifest", manifest_path, "--yes", "--json"]
        submit = await self.exec_as_agent(
            environment,
            command=" ".join(shlex.quote(value) for value in submit_command),
            env=command_env,
            cwd=workspace_root,
            timeout_sec=60,
        )
        if submit.return_code != 0:
            raise RuntimeError(f"Ever Task submission failed: {(submit.stderr or '').strip()}")
        try:
            task_id = json.loads(submit.stdout or "")["taskId"]
        except (json.JSONDecodeError, KeyError, TypeError) as error:
            raise RuntimeError("Ever Task submission returned no taskId") from error
        if not isinstance(task_id, str) or not task_id:
            raise RuntimeError("Ever Task submission returned an invalid taskId")

        terminal_states = {
            "completed",
            "failed",
            "cancelled",
            "waiting_input",
            "waiting_external",
            "paused",
            "unknown_outcome",
        }
        task: dict[str, Any] | None = None
        event_cursor = 0
        event_lines: list[str] = []
        for _ in range(self._max_wall_time_minutes * 60):
            event_command = ever + ["task", "events", task_id, "--after", str(event_cursor), "--json"]
            event_result = await self.exec_as_agent(
                environment,
                command=" ".join(shlex.quote(value) for value in event_command),
                env=command_env,
                cwd=workspace_root,
                timeout_sec=30,
            )
            if event_result.return_code != 0:
                raise RuntimeError("Ever Task event polling failed")
            for line in (event_result.stdout or "").splitlines():
                if not line.strip():
                    continue
                event = json.loads(line)
                if isinstance(event, dict) and isinstance(event.get("seq"), int):
                    event_cursor = max(event_cursor, event["seq"])
                    event_lines.append(line)
            show_command = ever + ["task", "show", task_id, "--json"]
            show = await self.exec_as_agent(
                environment,
                command=" ".join(shlex.quote(value) for value in show_command),
                env=command_env,
                cwd=workspace_root,
                timeout_sec=30,
            )
            if show.return_code != 0:
                raise RuntimeError("Ever Task status polling failed")
            task = json.loads(show.stdout or "")
            if isinstance(task, dict) and task.get("state") in terminal_states:
                break
            await asyncio.sleep(1)
        stop_command = ever + ["daemon", "stop", "--json"]
        await self.exec_as_agent(
            environment,
            command=" ".join(shlex.quote(value) for value in stop_command),
            env=command_env,
            cwd=workspace_root,
            timeout_sec=30,
        )
        summary = {"type": "eval_task_summary", "task": task or {}}
        (self.logs_dir / "ever.jsonl").write_text(
            "\n".join([*event_lines, json.dumps(summary)]) + "\n",
            encoding="utf-8",
        )
        if not isinstance(task, dict) or task.get("state") != "completed":
            state = task.get("state") if isinstance(task, dict) else "timed_out"
            raise RuntimeError(f"Ever Task ended in {state}")

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "ever.jsonl"
        if not path.exists():
            return
        steps: list[Step] = []
        prompt_tokens = 0
        completion_tokens = 0
        cached_tokens = 0
        total_cost = 0.0
        summary_task: dict[str, Any] | None = None
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("type") == "eval_task_summary" and isinstance(event.get("task"), dict):
                summary_task = event["task"]
                continue
            if event.get("type") != "message_end":
                continue
            message = event.get("message")
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role not in ("user", "assistant"):
                continue
            usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
            input_tokens = usage.get("input", 0) if isinstance(usage.get("input", 0), int) else 0
            output_tokens = usage.get("output", 0) if isinstance(usage.get("output", 0), int) else 0
            cache_tokens = usage.get("cacheRead", 0) if isinstance(usage.get("cacheRead", 0), int) else 0
            cost = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}
            cost_usd = cost.get("total", 0.0) if isinstance(cost.get("total", 0.0), (int, float)) else 0.0
            prompt_tokens += input_tokens
            completion_tokens += output_tokens
            cached_tokens += cache_tokens
            total_cost += float(cost_usd)
            tool_calls = _tool_calls(message.get("content"))
            steps.append(
                Step(
                    step_id=len(steps) + 1,
                    source="user" if role == "user" else "agent",
                    message=_message_text(message.get("content")),
                    tool_calls=tool_calls or None,
                    metrics=Metrics(
                        prompt_tokens=input_tokens,
                        completion_tokens=output_tokens,
                        cached_tokens=cache_tokens,
                        cost_usd=float(cost_usd),
                    )
                    if role == "assistant"
                    else None,
                )
            )
        if not steps:
            steps.append(Step(step_id=1, source="system", message="Ever produced no parseable message_end events"))
        if summary_task is not None:
            task_cost = summary_task.get("totalCostUsd")
            if isinstance(task_cost, (int, float)):
                total_cost = float(task_cost)
        context.n_input_tokens = prompt_tokens
        context.n_cache_tokens = cached_tokens
        context.n_output_tokens = completion_tokens
        context.cost_usd = total_cost
        trajectory = Trajectory(
            agent=Agent(name=self.name(), version=self.version() or "unknown", model_name=self.model_name),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=prompt_tokens,
                total_completion_tokens=completion_tokens,
                total_cached_tokens=cached_tokens,
                total_cost_usd=total_cost,
                total_steps=len(steps),
            ),
        )
        (self.logs_dir / "trajectory.json").write_text(
            format_trajectory_json(trajectory.to_json_dict()), encoding="utf-8"
        )
