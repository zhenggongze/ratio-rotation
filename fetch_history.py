# -*- coding: utf-8 -*-
"""数据获取脚本：用akshare拉取创业板指(399006)与中证红利(000922)历史数据。

参考 sector-monitor 项目的数据源方式。
数据范围：2014-07-01 至今
输出：data/history_data.json（含两指数的日期、开盘价、收盘价）

用法：
    python fetch_history.py              # 拉取全量历史
    python fetch_history.py --test       # 仅验证锚点
"""
from __future__ import annotations

import sys
import os
import json
import logging
from pathlib import Path
from datetime import datetime

# 兼容 Python 3.12 的 akshare 导入问题
import pkgutil
if not hasattr(pkgutil, 'ImpImporter'):
    pkgutil.ImpImporter = pkgutil.zipimporter

import pandas as pd

# ============================================================
# 配置
# ============================================================
PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = PROJECT_ROOT / "data"
OUTPUT_FILE = DATA_DIR / "history_data.json"

START_DATE = "20140701"
END_DATE = "20260731"

# 数据锚点（规格3.4节）
ANCHOR_POINTS = {
    "2014-07-01": {"cyb_close": 1344.54, "ratio": 0.5487},
    "2024-01-26": {"ratio": 0.3265},
    "2026-06-30": {"cyb_close": 4342.71, "hli_close": 5022.5, "ratio": 0.8647},
    "2026-07-31": {"cyb_close": 3343.96, "hli_close": 5569.41, "ratio": 0.6004},
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


# ============================================================
# 获取创业板指 399006（深交所指数）
# ============================================================
def fetch_cyb_history(start_date: str, end_date: str) -> pd.DataFrame:
    """获取创业板指历史数据。

    优先用中证指数公司接口（stock_zh_index_hist_csindex），
    失败则用新浪接口（stock_zh_index_daily）。
    """
    import akshare as ak

    # 方案1：中证指数公司接口（返回开高低收+成交量）
    try:
        logger.info("尝试用 csindex 接口获取创业板指 399006...")
        df = ak.stock_zh_index_hist_csindex(symbol="399006", start_date=start_date, end_date=end_date)
        if df is not None and len(df) > 0:
            # 中证列名：日期/开盘/最高/最低/收盘/涨跌/涨跌幅/成交量/成交金额/...
            rename_map = {
                "日期": "date", "开盘": "open", "收盘": "close",
                "最高": "high", "最低": "low",
            }
            df = df.rename(columns=rename_map)
            keep = [c for c in ["date", "open", "close", "high", "low"] if c in df.columns]
            df = df[keep].copy()
            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
            df = df.sort_values("date").reset_index(drop=True)
            for c in ["open", "close", "high", "low"]:
                if c in df.columns:
                    df[c] = pd.to_numeric(df[c], errors="coerce")
            # open 缺失用 close 兜底
            if df["open"].isna().all():
                df["open"] = df["close"]
                logger.warning("创业板 open 列全 NaN，已用 close 兜底")
            df = df.dropna(subset=["close"]).reset_index(drop=True)
            logger.info("csindex 接口成功，共 %d 条（%s ~ %s）",
                        len(df), df["date"].iloc[0], df["date"].iloc[-1])
            return df
    except Exception as e:
        logger.warning("csindex 接口失败: %s", str(e)[:200])

    # 方案2：新浪接口
    try:
        logger.info("尝试用新浪接口获取创业板指 sz399006...")
        df = ak.stock_zh_index_daily(symbol="sz399006")
        if df is not None and len(df) > 0:
            # 新浪列名：date, open, high, low, close, volume
            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
            start_iso = f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:8]}"
            end_iso = f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:8]}"
            df = df[(df["date"] >= start_iso) & (df["date"] <= end_iso)]
            df = df.sort_values("date").reset_index(drop=True)
            for c in ["open", "close", "high", "low"]:
                if c in df.columns:
                    df[c] = pd.to_numeric(df[c], errors="coerce")
            logger.info("新浪接口成功，共 %d 条（%s ~ %s）",
                        len(df), df["date"].iloc[0], df["date"].iloc[-1])
            return df
    except Exception as e:
        logger.warning("新浪接口失败: %s", str(e)[:200])

    logger.error("创业板指所有接口均失败")
    return pd.DataFrame()


# ============================================================
# 获取中证红利 000922（中证指数公司）
# ============================================================
def fetch_hli_history(start_date: str, end_date: str) -> pd.DataFrame:
    """获取中证红利历史数据。"""
    import akshare as ak

    # 方案1：中证指数公司接口
    try:
        logger.info("尝试用 csindex 接口获取中证红利 000922...")
        df = ak.stock_zh_index_hist_csindex(symbol="000922", start_date=start_date, end_date=end_date)
        if df is not None and len(df) > 0:
            rename_map = {
                "日期": "date", "开盘": "open", "收盘": "close",
                "最高": "high", "最低": "low",
            }
            df = df.rename(columns=rename_map)
            keep = [c for c in ["date", "open", "close", "high", "low"] if c in df.columns]
            df = df[keep].copy()
            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
            df = df.sort_values("date").reset_index(drop=True)
            for c in ["open", "close", "high", "low"]:
                if c in df.columns:
                    df[c] = pd.to_numeric(df[c], errors="coerce")
            if df["open"].isna().all():
                df["open"] = df["close"]
                logger.warning("红利 open 列全 NaN，已用 close 兜底")
            df = df.dropna(subset=["close"]).reset_index(drop=True)
            logger.info("csindex 接口成功，共 %d 条（%s ~ %s）",
                        len(df), df["date"].iloc[0], df["date"].iloc[-1])
            return df
    except Exception as e:
        logger.warning("csindex 接口失败: %s", str(e)[:200])

    # 方案2：新浪接口
    try:
        logger.info("尝试用新浪接口获取中证红利 sh000922...")
        df = ak.stock_zh_index_daily(symbol="sh000922")
        if df is not None and len(df) > 0:
            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
            start_iso = f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:8]}"
            end_iso = f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:8]}"
            df = df[(df["date"] >= start_iso) & (df["date"] <= end_iso)]
            df = df.sort_values("date").reset_index(drop=True)
            for c in ["open", "close", "high", "low"]:
                if c in df.columns:
                    df[c] = pd.to_numeric(df[c], errors="coerce")
            logger.info("新浪接口成功，共 %d 条（%s ~ %s）",
                        len(df), df["date"].iloc[0], df["date"].iloc[-1])
            return df
    except Exception as e:
        logger.warning("新浪接口失败: %s", str(e)[:200])

    logger.error("中证红利所有接口均失败")
    return pd.DataFrame()


# ============================================================
# 对齐两指数数据并保存为JSON
# ============================================================
def align_and_save(cyb_df: pd.DataFrame, hli_df: pd.DataFrame) -> dict:
    """按日期对齐两指数数据，计算比值，保存为JSON。"""
    if cyb_df.empty or hli_df.empty:
        raise ValueError("数据为空，无法对齐")

    # 按日期对齐（取两源都有的日期）
    hli_map = {row["date"]: row for _, row in hli_df.iterrows()}

    aligned = []
    for _, c in cyb_df.iterrows():
        h = hli_map.get(c["date"])
        if h is not None:
            ratio = c["close"] / h["close"]
            aligned.append({
                "date": c["date"],
                "cyb_open": float(c["open"]),
                "cyb_close": float(c["close"]),
                "cyb_high": float(c.get("high", 0)),
                "cyb_low": float(c.get("low", 0)),
                "hli_open": float(h["open"]),
                "hli_close": float(h["close"]),
                "hli_high": float(h.get("high", 0)),
                "hli_low": float(h.get("low", 0)),
                "ratio": round(ratio, 4),
            })

    logger.info("对齐后共 %d 个交易日", len(aligned))

    # 保存
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    output = {
        "meta": {
            "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "start_date": aligned[0]["date"] if aligned else "",
            "end_date": aligned[-1]["date"] if aligned else "",
            "count": len(aligned),
            "source": "akshare",
        },
        "data": aligned,
    }
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    logger.info("已保存到 %s", OUTPUT_FILE)

    return output


# ============================================================
# 验证数据锚点
# ============================================================
def verify_anchors(data: list[dict]):
    """验证关键数据锚点是否匹配。"""
    logger.info("=" * 60)
    logger.info("验证数据锚点（规格3.4节）")
    logger.info("=" * 60)

    data_map = {d["date"]: d for d in data}

    all_pass = True
    for date, expected in ANCHOR_POINTS.items():
        actual = data_map.get(date)
        if actual is None:
            logger.error("[锚点 %s] 数据缺失", date)
            all_pass = False
            continue

        checks = []
        if "cyb_close" in expected:
            diff = abs(actual["cyb_close"] - expected["cyb_close"])
            ok = diff < 1.0  # 允许1点误差
            checks.append(f"创业板收盘: 期望={expected['cyb_close']}, 实际={actual['cyb_close']}, "
                          f"偏差={diff:.2f}, {'✓' if ok else '✗'}")
            if not ok:
                all_pass = False
        if "hli_close" in expected:
            diff = abs(actual["hli_close"] - expected["hli_close"])
            ok = diff < 1.0
            checks.append(f"红利收盘: 期望={expected['hli_close']}, 实际={actual['hli_close']}, "
                          f"偏差={diff:.2f}, {'✓' if ok else '✗'}")
            if not ok:
                all_pass = False
        if "ratio" in expected:
            diff = abs(actual["ratio"] - expected["ratio"])
            ok = diff < 0.005
            checks.append(f"比值: 期望={expected['ratio']}, 实际={actual['ratio']}, "
                          f"偏差={diff:.4f}, {'✓' if ok else '✗'}")
            if not ok:
                all_pass = False

        status = "✓ PASS" if all(c.endswith("✓") for c in checks) else "✗ FAIL"
        logger.info("[%s] 锚点 %s:", status, date)
        for c in checks:
            logger.info("  %s", c)

    # 统计信息
    ratios = [d["ratio"] for d in data]
    logger.info("=" * 60)
    logger.info("比值统计:")
    logger.info("  最小值: %.4f", min(ratios))
    logger.info("  最大值: %.4f", max(ratios))
    logger.info("  中位数: %.4f", sorted(ratios)[len(ratios) // 2])
    buy_zone_count = sum(1 for r in ratios if r <= 0.332)
    sell_zone_count = sum(1 for r in ratios if r >= 0.578)
    hysteresis_count = sum(1 for r in ratios if 0.332 < r < 0.578)
    logger.info("  买入区(≤0.332): %d 天 (%.1f%%)", buy_zone_count, buy_zone_count / len(ratios) * 100)
    logger.info("  卖出区(≥0.578): %d 天 (%.1f%%)", sell_zone_count, sell_zone_count / len(ratios) * 100)
    logger.info("  滞回带: %d 天 (%.1f%%)", hysteresis_count, hysteresis_count / len(ratios) * 100)
    logger.info("  总交易日: %d", len(ratios))
    logger.info("=" * 60)

    if all_pass:
        logger.info("✓ 所有锚点验证通过")
    else:
        logger.error("✗ 部分锚点验证失败，请检查数据源")

    return all_pass


# ============================================================
# 主函数
# ============================================================
def main():
    test_mode = "--test" in sys.argv

    logger.info("开始拉取历史数据: %s ~ %s", START_DATE, END_DATE)

    # 拉取两指数数据
    cyb_df = fetch_cyb_history(START_DATE, END_DATE)
    if cyb_df.empty:
        logger.error("创业板指数据拉取失败，退出")
        sys.exit(1)

    hli_df = fetch_hli_history(START_DATE, END_DATE)
    if hli_df.empty:
        logger.error("中证红利数据拉取失败，退出")
        sys.exit(1)

    # 对齐并保存
    output = align_and_save(cyb_df, hli_df)

    # 验证锚点
    verify_anchors(output["data"])

    if test_mode:
        logger.info("测试模式：仅验证锚点，不进行后续操作")
        return

    logger.info("数据拉取完成，共 %d 个交易日", len(output["data"]))


if __name__ == "__main__":
    main()
