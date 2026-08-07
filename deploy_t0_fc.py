#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
做T系统实际卖出价修正 API - 阿里云函数计算（FC 3.0）部署脚本
============================================================
将 fc-t0 目录打包成 zip，上传到 OSS，调用 FC 3.0 OpenAPI 创建/更新函数和 HTTP 触发器，
返回可用的 HTTPS URL。电脑关机也能正常使用（与持仓系统 portfolio-api 同方案）。

安全要求：AccessKey 只从环境变量读取，绝不硬编码！
  set ALIYUN_AK_ID=你的AccessKeyId
  set ALIYUN_AK_SECRET=你的AccessKeySecret

依赖：oss2, alibabacloud_fc20230330, alibabacloud_tea_openapi
运行：python deploy_t0_fc.py（建议用系统 Python，如 C:/Users/<user>/AppData/Local/Programs/Python/Python312/python.exe）
"""
import os
import sys
import time
import json
import zipfile
import tempfile

# ===== 配置 =====
ACCESS_KEY_ID = os.environ.get('ALIYUN_AK_ID', os.environ.get('OSS_ACCESS_KEY_ID', ''))
ACCESS_KEY_SECRET = os.environ.get('ALIYUN_AK_SECRET', os.environ.get('OSS_ACCESS_KEY_SECRET', ''))
REGION = 'cn-hangzhou'

# FC 3.0
FC_FUNCTION_NAME = 't0-adjust-api'
FC_TRIGGER_NAME = 'http-trigger'
FC_RUNTIME = 'nodejs18'
FC_HANDLER = 'index.handler'
FC_MEMORY = 256
FC_TIMEOUT = 60
FC_ENDPOINT = f'fcv3.{REGION}.aliyuncs.com'

# OSS
OSS_BUCKET = 'portfolio-analysis-hosting'
OSS_CODE_KEY = '_fc-deploy/t0-adjust-api.zip'

# FC 函数环境变量（与 ratio-rotation 数据文件同 bucket）
FC_ENV_VARS = {
    'OSS_ACCESS_KEY_ID': ACCESS_KEY_ID,
    'OSS_ACCESS_KEY_SECRET': ACCESS_KEY_SECRET,
    'OSS_BUCKET': OSS_BUCKET,
}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FC_FUNCTION_DIR = os.path.join(SCRIPT_DIR, 'fc-t0')


def log(msg):
    print(f'  {msg}')


def step(n, msg):
    print(f'\n{"="*60}')
    print(f'  [{n}] {msg}')
    print(f'{"="*60}')


# ===== 1. 打包 fc-t0 为 zip =====
def package_function():
    step(1, '打包 fc-t0 目录')
    if not os.path.isdir(FC_FUNCTION_DIR):
        print(f'  ❌ 目录不存在: {FC_FUNCTION_DIR}')
        sys.exit(1)
    if not os.path.isdir(os.path.join(FC_FUNCTION_DIR, 'node_modules')):
        print(f'  ❌ node_modules 不存在，请先运行: cd fc-t0; npm install')
        sys.exit(1)

    zip_path = os.path.join(tempfile.gettempdir(), 't0-adjust-api-fc.zip')
    if os.path.exists(zip_path):
        os.remove(zip_path)

    log(f'打包目录: {FC_FUNCTION_DIR}')
    total = 0
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(FC_FUNCTION_DIR):
            if '.git' in dirs:
                dirs.remove('.git')
            for f in files:
                if f in ('npm-install.log',):
                    continue
                full = os.path.join(root, f)
                arc = os.path.relpath(full, FC_FUNCTION_DIR).replace(os.sep, '/')
                zf.write(full, arc)
                total += 1

    size = os.path.getsize(zip_path)
    log(f'✅ 打包完成: {total} 文件, {size/1024:.0f} KB')
    return zip_path


# ===== 2. 上传 zip 到 OSS =====
def upload_code_to_oss(zip_path):
    step(2, '上传代码包到 OSS')
    import oss2
    auth = oss2.Auth(ACCESS_KEY_ID, ACCESS_KEY_SECRET)
    bucket = oss2.Bucket(auth, f'https://oss-{REGION}.aliyuncs.com', OSS_BUCKET)
    try:
        bucket.delete_object(OSS_CODE_KEY)
    except Exception:
        pass
    with open(zip_path, 'rb') as f:
        bucket.put_object(OSS_CODE_KEY, f)
    log(f'✅ 代码包已上传: oss://{OSS_BUCKET}/{OSS_CODE_KEY}')
    return OSS_CODE_KEY


# ===== 3. 创建 FC 3.0 客户端 =====
def get_fc_client():
    from alibabacloud_fc20230330.client import Client
    from alibabacloud_tea_openapi import models as open_api_models
    config = open_api_models.Config(
        access_key_id=ACCESS_KEY_ID,
        access_key_secret=ACCESS_KEY_SECRET,
        region_id=REGION,
        endpoint=FC_ENDPOINT
    )
    return Client(config)


# ===== 4. 创建/更新函数 =====
def ensure_function(oss_code_key):
    step(3, '创建/更新 FC 3.0 函数')
    from alibabacloud_fc20230330 import models
    client = get_fc_client()

    function_exists = False
    try:
        client.get_function(FC_FUNCTION_NAME, models.GetFunctionRequest())
        function_exists = True
        log('函数已存在，将更新')
    except Exception as e:
        msg = str(e)
        if 'NotFound' in msg or 'ResourceNotFound' in msg or 'FunctionNotFound' in msg:
            log('函数不存在，将创建')
        else:
            log(f'查询函数返回: {msg[:200]}（继续尝试创建）')

    code = models.InputCodeLocation(
        oss_bucket_name=OSS_BUCKET,
        oss_object_name=oss_code_key
    )

    env_vars = FC_ENV_VARS.copy()
    if not env_vars.get('OSS_ACCESS_KEY_ID'):
        print('  ⚠️ 警告: OSS_ACCESS_KEY_ID 环境变量未设置')

    if function_exists:
        try:
            update_input = models.UpdateFunctionInput(
                runtime=FC_RUNTIME,
                handler=FC_HANDLER,
                memory_size=FC_MEMORY,
                timeout=FC_TIMEOUT,
                environment_variables=env_vars,
                code=code
            )
            update_req = models.UpdateFunctionRequest(body=update_input)
            client.update_function(FC_FUNCTION_NAME, update_req)
            log('✅ 函数代码与配置已更新')
        except Exception as e:
            print(f'  ❌ 更新函数失败: {e}')
            sys.exit(1)
    else:
        try:
            create_input = models.CreateFunctionInput(
                function_name=FC_FUNCTION_NAME,
                description='做T系统实际卖出价修正数据 API',
                runtime=FC_RUNTIME,
                handler=FC_HANDLER,
                memory_size=FC_MEMORY,
                timeout=FC_TIMEOUT,
                code=code,
                environment_variables=env_vars
            )
            create_req = models.CreateFunctionRequest(body=create_input)
            client.create_function(create_req)
            log(f'✅ 函数已创建: {FC_FUNCTION_NAME}')
            log('等待函数就绪...')
            time.sleep(5)
        except Exception as e:
            print(f'  ❌ 创建函数失败: {e}')
            sys.exit(1)


# ===== 5. 创建/更新 HTTP 触发器 =====
def ensure_trigger():
    step(4, '创建/更新 HTTP 触发器')
    from alibabacloud_fc20230330 import models
    client = get_fc_client()

    trigger_exists = False
    try:
        client.get_trigger(FC_FUNCTION_NAME, FC_TRIGGER_NAME)
        trigger_exists = True
        log('触发器已存在，将更新')
    except Exception as e:
        msg = str(e)
        if 'NotFound' in msg or 'ResourceNotFound' in msg or 'TriggerNotFound' in msg:
            log('触发器不存在，将创建')
        else:
            log(f'查询触发器返回: {msg[:200]}（继续尝试创建）')

    config_dict = {
        'authType': 'anonymous',
        'methods': ['GET', 'POST', 'HEAD', 'OPTIONS']
    }
    trigger_config_str = json.dumps(config_dict)

    if trigger_exists:
        try:
            update_input = models.UpdateTriggerInput(
                trigger_type='http',
                trigger_config=trigger_config_str
            )
            update_req = models.UpdateTriggerRequest(body=update_input)
            client.update_trigger(FC_FUNCTION_NAME, FC_TRIGGER_NAME, update_req)
            log('✅ 触发器已更新')
        except Exception as e:
            log(f'更新失败，尝试删除重建: {str(e)[:100]}')
            try:
                client.delete_trigger(FC_FUNCTION_NAME, FC_TRIGGER_NAME)
                time.sleep(2)
                create_input = models.CreateTriggerInput(
                    trigger_name=FC_TRIGGER_NAME,
                    trigger_type='http',
                    trigger_config=trigger_config_str
                )
                create_req = models.CreateTriggerRequest(body=create_input)
                client.create_trigger(FC_FUNCTION_NAME, create_req)
                log('✅ 触发器已重建')
            except Exception as e2:
                print(f'  ❌ 重建触发器失败: {e2}')
                sys.exit(1)
    else:
        try:
            create_input = models.CreateTriggerInput(
                trigger_name=FC_TRIGGER_NAME,
                trigger_type='http',
                trigger_config=trigger_config_str
            )
            create_req = models.CreateTriggerRequest(body=create_input)
            client.create_trigger(FC_FUNCTION_NAME, create_req)
            log('✅ 触发器已创建')
        except Exception as e:
            print(f'  ❌ 创建触发器失败: {e}')
            sys.exit(1)


# ===== 主流程 =====
def main():
    print('='*60)
    print('  阿里云函数计算（FC 3.0）部署 - 做T系统实际卖出价修正 API')
    print('='*60)

    if not ACCESS_KEY_ID or not ACCESS_KEY_SECRET:
        print('''
  ❌ 缺少阿里云密钥！请先设置环境变量（安全要求：不硬编码）：
     set ALIYUN_AK_ID=你的AccessKeyId
     set ALIYUN_AK_SECRET=你的AccessKeySecret
     或复用 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET
''')
        sys.exit(1)

    # 1. 打包
    zip_path = package_function()

    # 2. 上传到 OSS
    oss_code_key = upload_code_to_oss(zip_path)

    # 3. 创建/更新函数
    ensure_function(oss_code_key)

    # 4. 创建/更新 HTTP 触发器
    ensure_trigger()

    # 5. 获取触发器 URL
    step(5, '部署完成 - HTTP 触发器 URL')
    trigger_url = None
    try:
        from alibabacloud_fc20230330 import models
        client = get_fc_client()
        resp = client.get_trigger(FC_FUNCTION_NAME, FC_TRIGGER_NAME)
        http_trigger = resp.body.http_trigger
        if http_trigger:
            trigger_url = http_trigger.url_internet or http_trigger.url_intranet
    except Exception as e:
        log(f'获取触发器 URL 失败: {str(e)[:200]}')

    if trigger_url:
        print(f'''
  ╔═══════════════════════════════════════════════════════════╗
  ║              ✅ 部署成功                                   ║
  ║  FC 函数:     {FC_FUNCTION_NAME:<42s} ║
  ║  HTTP URL:   {trigger_url:<54s} ║
  ║  健康检查:    {trigger_url + '/api/t0/health':<54s} ║
  ╚═══════════════════════════════════════════════════════════╝
''')
        url_file = os.path.join(tempfile.gettempdir(), 't0_fc_trigger_url.txt')
        with open(url_file, 'w') as f:
            f.write(trigger_url)
        log(f'URL 已写入: {url_file}')
    else:
        print('''
  ⚠️ 自动获取触发器 URL 失败，请到 FC 控制台手动获取:
  https://fcnext.console.aliyun.com/cn-hangzhou/functions
  → 进入 t0-adjust-api → 触发器 → http-trigger
''')

    # 清理本地 zip
    try:
        os.remove(zip_path)
        log('已清理临时 zip')
    except Exception:
        pass


if __name__ == '__main__':
    main()
