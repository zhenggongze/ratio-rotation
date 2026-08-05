# -*- coding: utf-8 -*-
"""检查首日数据和H00922全收益指数的获取情况"""
import sys
import json
import pkgutil
if not hasattr(pkgutil, 'ImpImporter'):
    pkgutil.ImpImporter = pkgutil.zipimporter

import pandas as pd
import akshare as ak

# 检查首日数据
print("=" * 60)
print("1. 检查创业板指 399006 首日数据")
print("=" * 60)

# 方法1: 新浪
try:
    df = ak.stock_zh_index_daily(symbol="sz399006")
    df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
    first_day = df[df["date"] == "2014-07-01"]
    if len(first_day) > 0:
        print(f"新浪: 2014-07-01 open={first_day.iloc[0]['open']}, close={first_day.iloc[0]['close']}")
    # 看前5天
    early = df[(df["date"] >= "2014-07-01") & (df["date"] <= "2014-07-08")]
    print("新浪前5天:")
    print(early[["date", "open", "close"]].to_string(index=False))
except Exception as e:
    print(f"新浪失败: {e}")

# 方法2: 中证指数公司
try:
    df2 = ak.stock_zh_index_hist_csindex(symbol="399006", start_date="20140701", end_date="20140710")
    if df2 is not None and len(df2) > 0:
        print("\n中证指数公司 399006:")
        print(df2.head(5).to_string(index=False))
except Exception as e:
    print(f"\n中证指数公司 399006 失败: {e}")

# 检查H00922全收益指数
print("\n" + "=" * 60)
print("2. 检查中证红利全收益指数 H00922")
print("=" * 60)

try:
    df3 = ak.stock_zh_index_hist_csindex(symbol="H00922", start_date="20140701", end_date="20260731")
    if df3 is not None and len(df3) > 0:
        print(f"H00922 获取成功，共 {len(df3)} 条")
        print(f"首日: {df3.iloc[0].to_dict()}")
        print(f"末日: {df3.iloc[-1].to_dict()}")

        # 计算分红率
        df3_clean = df3.rename(columns={"日期": "date", "收盘": "close"})
        df3_clean["date"] = pd.to_datetime(df3_clean["date"]).dt.strftime("%Y-%m-%d")
        df3_clean["close"] = pd.to_numeric(df3_clean["close"], errors="coerce")
        df3_clean = df3_clean.sort_values("date").reset_index(drop=True)
        df3_clean["total_ret"] = df3_clean["close"].pct_change()

        # 获取000922价格指数
        df4 = ak.stock_zh_index_hist_csindex(symbol="000922", start_date="20140701", end_date="20260731")
        df4_clean = df4.rename(columns={"日期": "date", "收盘": "close"})
        df4_clean["date"] = pd.to_datetime(df4_clean["date"]).dt.strftime("%Y-%m-%d")
        df4_clean["close"] = pd.to_numeric(df4_clean["close"], errors="coerce")
        df4_clean = df4_clean.sort_values("date").reset_index(drop=True)
        df4_clean["price_ret"] = df4_clean["close"].pct_change()

        # 合并计算分红率
        merged = pd.merge(df3_clean[["date", "total_ret"]], df4_clean[["date", "price_ret"]], on="date")
        merged = merged.dropna()
        merged["dividend_rate"] = merged["total_ret"] - merged["price_ret"]

        print(f"\n分红率统计:")
        print(f"  年均分红率: {merged['dividend_rate'].mean() * 252 * 100:.2f}%")
        print(f"  日均分红率: {merged['dividend_rate'].mean() * 100:.4f}%")
        print(f"  兜底值(4.4%/252): {0.044/252 * 100:.4f}%")
        print(f"  分红率>0的天数占比: {(merged['dividend_rate'] > 0).mean() * 100:.1f}%")

        # 保存H00922数据
        output = []
        for _, row in merged.iterrows():
            output.append({
                "date": row["date"],
                "hli_dividend_rate": float(row["dividend_rate"])
            })
        with open("data/hli_dividend_rates.json", "w", encoding="utf-8") as f:
            json.dump({"data": output}, f, ensure_ascii=False)
        print(f"\n分红率数据已保存: data/hli_dividend_rates.json ({len(output)} 条)")
    else:
        print("H00922 返回空数据")
except Exception as e:
    print(f"H00922 获取失败: {e}")
