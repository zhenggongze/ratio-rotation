#!/usr/bin/env python3
# cron-job.org 调度脚本：触发 GitHub Actions workflow_dispatch
# 严格参考 AI 算力新闻项目方案
#
# 配置方式：
#   在 cron-job.org 创建定时任务，URL 指向这个脚本的执行入口
#   或直接让 cron-job.org POST 到 GitHub API（更简单，推荐）
#
# 推荐方案：cron-job.org 直接 POST 到 GitHub API（无需此脚本）
#   URL:    https://api.github.com/repos/{owner}/{repo}/actions/workflows/daily_rotation.yml/dispatches
#   Method: POST
#   Headers:
#     Accept: application/vnd.github+json
#     Authorization: Bearer <GITHUB_PAT>
#     X-GitHub-Api-Version: 2022-11-28
#   Body: {"ref":"main"}
#
# 本脚本作为备用方案：当 cron-job.org 无法直接调 GitHub API 时使用
# 部署到任意能访问外网的服务器（如本机、云服务器），由 cron-job.org 调用
import os
import sys
import json
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta


def trigger_workflow():
    """触发 GitHub Actions workflow_dispatch"""
    # 配置（从环境变量读取，绝不硬编码）
    token = os.environ.get("GH_PAT") or os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GH_REPO")  # 格式: owner/repo
    workflow = os.environ.get("GH_WORKFLOW", "daily_rotation.yml")
    ref = os.environ.get("GH_REF", "main")

    if not token or not repo:
        print("[FATAL] 缺少 GH_PAT 或 GH_REPO 环境变量")
        sys.exit(2)

    url = f"https://api.github.com/repos/{repo}/actions/workflows/{workflow}/dispatches"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "cron-job-trigger"
    }
    body = json.dumps({"ref": ref}).encode("utf-8")

    beijing_now = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{beijing_now}] 触发 {repo} -> {workflow} (ref={ref})")

    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
            print(f"  HTTP {status}")
            if status == 204:
                print("  ✅ workflow_dispatch 已触发")
                sys.exit(0)
            else:
                print(f"  ⚠️ 非预期状态码: {status}")
                sys.exit(1)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        print(f"  ❌ HTTP {e.code}: {body_text[:300]}")
        # 422 = workflow 已在运行中（幂等跳过），不算失败
        if e.code == 422 and "workflow run already exists" in body_text.lower():
            print("  ℹ️ workflow 已在运行中，幂等跳过")
            sys.exit(0)
        sys.exit(1)
    except Exception as e:
        print(f"  ❌ 异常: {e}")
        sys.exit(1)


if __name__ == "__main__":
    trigger_workflow()
