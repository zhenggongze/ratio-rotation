#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
比值轮动系统 OSS 部署脚本
=========================
部署前端展示页到阿里云 OSS + 刷新 CDN
密钥从环境变量读取，绝不硬编码

环境变量配置（在系统环境变量或 .env 中设置）：
  OSS_ACCESS_KEY_ID     - 阿里云 AccessKey ID
  OSS_ACCESS_KEY_SECRET - 阿里云 AccessKey Secret
  OSS_BUCKET            - OSS Bucket 名称（默认 ratio-rotation-hosting）
  OSS_REGION            - OSS 区域（默认 cn-hangzhou）
  CDN_DOMAIN            - CDN 域名（如 ratio-rotation.top）

用法：
  set OSS_ACCESS_KEY_ID=xxx
  set OSS_ACCESS_KEY_SECRET=xxx
  set OSS_BUCKET=ratio-rotation-hosting
  set CDN_DOMAIN=ratio-rotation.top
  python deploy.py
"""

import os
import sys
import time

try:
    import oss2
except ImportError:
    print('✗ 缺少 oss2 库，请运行: pip install oss2')
    sys.exit(1)

# ============================================================
# 配置（从环境变量读取，绝不硬编码）
# ============================================================
ACCESS_KEY_ID = os.environ.get('OSS_ACCESS_KEY_ID', '')
ACCESS_KEY_SECRET = os.environ.get('OSS_ACCESS_KEY_SECRET', '')
BUCKET = os.environ.get('OSS_BUCKET', 'ratio-rotation-hosting')
REGION = os.environ.get('OSS_REGION', 'cn-hangzhou')
OSS_ENDPOINT = f'oss-{REGION}.aliyuncs.com'
CDN_DOMAIN = os.environ.get('CDN_DOMAIN', 'ratio-rotation.top')

# 本地文件目录
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(SCRIPT_DIR, 'public')


def check_config():
    """检查必要的环境变量是否配置"""
    if not ACCESS_KEY_ID or not ACCESS_KEY_SECRET:
        print('✗ 缺少 OSS 密钥配置')
        print('  请设置环境变量:')
        print('    set OSS_ACCESS_KEY_ID=你的AccessKeyID')
        print('    set OSS_ACCESS_KEY_SECRET=你的AccessKeySecret')
        print('  或参照 portfolio-analysis 项目的 deploy_v2.py 中的密钥')
        return False
    return True


def upload_file(bucket, local_path, oss_key, content_type):
    """上传单个文件到 OSS"""
    with open(local_path, 'rb') as f:
        content = f.read()

    # 先删除旧文件（清除旧元数据）
    try:
        bucket.delete_object(oss_key)
    except:
        pass

    time.sleep(0.5)

    bucket.put_object(
        oss_key,
        content,
        headers={
            'Content-Type': content_type,
            'Content-Disposition': 'inline',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    )
    bucket.put_object_acl(oss_key, oss2.OBJECT_ACL_PUBLIC_READ)
    print(f'  ✓ {oss_key} ({len(content)} 字节)')


def main():
    print('=' * 60)
    print('  比值轮动系统 — OSS 部署')
    print('=' * 60)

    if not check_config():
        sys.exit(1)

    print(f'\n  Bucket: {BUCKET}')
    print(f'  Region: {REGION}')
    print(f'  CDN:    {CDN_DOMAIN}')
    print(f'  目录:   {PUBLIC_DIR}')

    # 检查 public 目录
    if not os.path.isdir(PUBLIC_DIR):
        print(f'\n✗ public 目录不存在: {PUBLIC_DIR}')
        print('  请先运行: node export_frontend_data.cjs')
        sys.exit(1)

    # 初始化 OSS
    auth = oss2.Auth(ACCESS_KEY_ID, ACCESS_KEY_SECRET)
    bucket = oss2.Bucket(auth, f'https://{OSS_ENDPOINT}', BUCKET)

    # 上传文件清单
    files_to_upload = [
        ('index.html', 'index.html', 'text/html; charset=utf-8'),
        ('frontend_data.json', 'frontend_data.json', 'application/json; charset=utf-8'),
    ]

    print(f'\n[1/2] 上传文件到 OSS')
    print('-' * 60)

    for local_name, oss_key, content_type in files_to_upload:
        local_path = os.path.join(PUBLIC_DIR, local_name)
        if not os.path.exists(local_path):
            print(f'  ✗ {local_name} 不存在，跳过')
            continue
        upload_file(bucket, local_path, oss_key, content_type)

    # 验证上传
    print(f'\n[2/2] 验证访问')
    print('-' * 60)

    import urllib.request
    test_url = f'https://{CDN_DOMAIN}/index.html'
    try:
        req = urllib.request.Request(test_url, headers={'User-Agent': 'deploy-script'})
        resp = urllib.request.urlopen(req, timeout=10)
        if resp.status == 200:
            print(f'  ✓ 访问成功: {test_url}')
        else:
            print(f'  ⚠ 访问返回: {resp.status}')
    except Exception as e:
        print(f'  ⚠ 访问失败（CDN 可能尚未刷新）: {e}')
        print(f'    请稍后访问: https://{CDN_DOMAIN}')

    print('\n' + '=' * 60)
    print('  部署完成')
    print('=' * 60)
    print(f'\n  访问地址: https://{CDN_DOMAIN}')
    print(f'\n  注意:')
    print(f'    1. 首次部署需在阿里云控制台配置 Bucket 静态网站托管')
    print(f'    2. 需绑定自定义域名并配置 CDN 加速')
    print(f'    3. 默认首页设为 index.html')
    print(f'    4. 数据更新后重新运行: node export_frontend_data.cjs && python deploy.py')


if __name__ == '__main__':
    main()
