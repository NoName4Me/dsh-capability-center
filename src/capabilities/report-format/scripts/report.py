#!/usr/bin/env python3
"""Render the bundled report-format example without network access."""

from __future__ import annotations

import argparse
import json
import sys


def render(document: dict[str, object]) -> str:
    title = str(document.get("title", "检查报告")).strip() or "检查报告"
    owner = str(document.get("owner", "")).strip()
    findings = document.get("findings", [])
    if not isinstance(findings, list):
        raise ValueError("findings must be a list")
    lines = [f"# {title}", ""]
    if owner:
        lines.extend([f"来源：{owner}", ""])
    passed = sum(1 for item in findings if isinstance(item, dict) and item.get("severity") == "通过")
    lines.extend([
        f"结论：共记录 {len(findings)} 项发现，其中 {passed} 项通过。",
        "",
        "## 发现",
        "",
    ])
    for index, item in enumerate(findings, 1):
        if not isinstance(item, dict):
            raise ValueError("each finding must be an object")
        severity = str(item.get("severity", "信息"))
        detail = str(item.get("detail", "")).strip()
        lines.append(f"{index}. [{severity}] {detail}")
    lines.extend([
        "",
        "## 未验证",
        "",
        "本次示例不声明真实 DSH 或 Windows 运行结果。",
        "",
        "## 下一步",
        "",
        "在目标环境执行验证并保留失败项。",
    ])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-json", required=True)
    args = parser.parse_args()
    try:
        document = json.loads(args.input_json)
        if not isinstance(document, dict):
            raise ValueError("input must be an object")
        sys.stdout.write(render(document))
        return 0
    except (ValueError, json.JSONDecodeError) as error:
        print(f"report-format: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
