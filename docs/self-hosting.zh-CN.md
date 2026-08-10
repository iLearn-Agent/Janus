# 🌍 自建 Janus 服务

[简体中文](self-hosting.zh-CN.md) · [English](self-hosting.md) · [返回 README](../README.zh-CN.md)

不运营共享服务器也可以使用 Janus Desktop。只有当组织需要共享账号、成员通信、跨用户委托、同步协作或组织级 Agent 自进化时，才需要部署私有服务器。

公开仓库只包含应用源码，不包含运行时数据库、用户记录、凭据、生产密钥或部署者的数据。

> [!IMPORTANT]
> 所有生产环境文件、数据库备份、私钥、邮件凭据和服务 Token 都必须保存在 Git 仓库之外。

## 🧭 部署概览

一套实用部署通常需要：

- Linux 应用服务器；
- Node.js 22+ 和 npm；
- 独立的应用数据库；
- 私有环境文件；
- 用于账号验证的邮件发送服务；
- HTTPS 和域名；
- systemd 等进程守护工具；
- 如启用组织级 Agent 自进化，还需要独立 Worker 进程。

小规模内网测试可以让 API 和数据库运行在同一台可信机器上。生产环境应根据组织的安全性和可用性要求拆分职责。

## 📦 1. 安装应用

```bash
git clone https://github.com/iLearn-Agent/Janus.git
cd Janus
npm ci
```

请为服务创建独立操作系统账号，不要使用 `root` 运行应用。

## 🗄️ 2. 创建应用数据库

当前服务器实现推荐使用 PostgreSQL 14 或更高版本。创建一个空数据库和受限应用用户。该用户可以拥有 Janus 数据库，但不应是 PostgreSQL 超级用户。

示例：

```sql
CREATE ROLE janus_app LOGIN PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE janus OWNER janus_app;
```

连接示例：

```bash
export DATABASE_URL='postgres://janus_app:replace-with-a-strong-password@127.0.0.1:5432/janus'
```

建议：

- 只允许应用服务器或私有网络访问数据库；
- 数据库位于其他机器时强制使用 TLS；
- 使用不与其他服务共享的独立密码；
- 定期执行加密备份并实际演练恢复；
- 从空数据库开始，让迁移命令创建所需应用结构；
- 绝不能把数据库文件或 dump 上传到 GitHub。

## 🔐 3. 准备私有环境

首次私有测试可以使用：

```bash
export DATABASE_URL='postgres://janus_app:replace-me@127.0.0.1:5432/janus'
export JWT_SECRET="$(openssl rand -hex 32)"
export EMAIL_CODE_SECRET="$(openssl rand -hex 32)"
export MAIL_PROVIDER=console
export MAIL_FROM='Janus <no-reply@localhost>'
export PORT=8787
```

`MAIL_PROVIDER=console` 会把账号验证码打印到服务器终端，只能用于可信开发机器。

生产环境应把环境变量放在仓库外，例如 `/etc/janus/api.env`，并限制权限：

```bash
sudo install -d -m 0700 /etc/janus
sudo touch /etc/janus/api.env
sudo chmod 0600 /etc/janus/api.env
```

生产配置通常应包含：

- 数据库连接；
- 分别生成的长认证密钥和邮箱验证码密钥；
- 真实 SMTP 配置；
- 公开服务器 origin；
- 当前部署启用功能所需的私有服务凭据；
- 保守的请求限制和超时。

不要把桌面端模型凭据复用为服务器凭据。

## 🚀 4. 初始化并启动 API

第一次启动和每次服务升级前都要运行数据库迁移：

```bash
npm run cloud:migrate
```

启动 API：

```bash
npm run cloud:start
```

另开终端验证：

```bash
curl http://127.0.0.1:8787/healthz
```

预期返回结构：

```json
{
  "ok": true,
  "status": "ok"
}
```

迁移失败时应停止部署并修复数据库连接或权限，不要手工创建内部应用表。

## ✉️ 5. 配置生产邮件

SMTP 环境示例：

```bash
MAIL_PROVIDER=smtp
MAIL_FROM='Janus <no-reply@example.com>'
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=replace-me
SMTP_PASS=replace-me
```

也可以使用一个 `SMTP_URL` 代替独立 SMTP 字段。邀请用户前，请验证注册、邮箱验证、密码重置和组织安全邮件。

## 🧬 6. 按需启用 Evolution Worker

共享账号和通信功能无需 Evolution Worker 也能运行。只有部署环境准备好运行组织级自进化时才启动：

```bash
npm run cloud:evolution-worker
```

生产建议：

- 将 Worker 作为独立操作系统服务运行；
- 为它配置独立数据库登录，并只授予必要权限；
- 不要让 API 环境获得 Worker 的模型服务凭据和进化密钥；
- Worker 私有环境文件只能由对应服务账号读取；
- 监控每次重启和升级后的第一次处理周期；
- 面向用户启用前，先在 staging 环境测试进化结果。

Worker 负责高级进化处理。它的私有治理配置属于部署基础设施，不应记录在公开仓库中。

## ⚙️ 7. 使用 systemd 运行服务

API unit 示例：

```ini
[Unit]
Description=Janus API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=janus
WorkingDirectory=/opt/janus
EnvironmentFile=/etc/janus/api.env
ExecStart=/usr/bin/npm run cloud:start
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

为 Worker 创建第二个 unit，使用独立用户或环境文件，并设置：

```ini
ExecStart=/usr/bin/npm run cloud:evolution-worker
```

安装或修改 unit 后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now janus-api.service
sudo systemctl status janus-api.service
```

请按服务器调整 `User`、`WorkingDirectory`、Node/npm 路径和环境文件路径。

## 🔒 8. 使用 HTTPS 反向代理

最小 Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name janus.example.com;

    ssl_certificate     /etc/letsencrypt/live/janus.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/janus.example.com/privkey.pem;

    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
    }
}
```

请使用有效 TLS 证书，不要把数据库端口或私有服务端口暴露到公网。

## 🔗 9. 连接桌面客户端

源码运行：

```bash
JANUS_AUTH_URL=https://janus.example.com \
JANUS_PACKAGED_CLOUD_URL=https://janus.example.com \
npm run dev:open-source
```

验证新服务器时建议使用全新桌面配置：

```bash
JANUS_HOME=/path/to/test-profile \
JANUS_AUTH_URL=https://janus.example.com \
JANUS_PACKAGED_CLOUD_URL=https://janus.example.com \
npm run dev:open-source
```

分发桌面安装包时，应在私有打包流程中配置相同的公开服务器 origin。

## ✅ 10. 生产检查清单

- [ ] 应用由独立非 root 用户运行。
- [ ] 数据库用户权限受限，数据库不可从公网访问。
- [ ] 已验证数据库备份与恢复。
- [ ] 环境文件位于 Git 外且权限为 `0600`。
- [ ] 已测试真实 SMTP 邮件。
- [ ] 已启用 HTTPS，HTTP 会跳转到 HTTPS。
- [ ] 已配置 API 健康检查和服务重启告警。
- [ ] Worker 凭据与 API 凭据相互隔离。
- [ ] 生产升级前使用 staging 部署验证。
- [ ] 每次源码发布都排除运行时数据库、用户数据、日志和凭据。

## 🔄 升级流程

1. 备份应用数据库和私有部署配置。
2. 如已启用，停止 Evolution Worker。
3. 更新源码并运行 `npm ci`。
4. 使用部署数据库账号运行 `npm run cloud:migrate`。
5. 重启 API 并验证 `/healthz`。
6. 重启 Worker 并检查第一次处理周期。
7. 验证注册、登录、消息、委托和一个受控 Agent 任务。

## 🛠️ 常见问题

### 🔎 `DATABASE_URL is required`

API 或迁移进程没有获得私有数据库连接环境变量。

### 🔎 `JWT_SECRET must be at least 32 characters`

生成足够长的随机密钥并重启服务，生产环境不能使用示例文本。

### 🔎 数据库迁移失败

确认应用用户能够连接目标空数据库并创建 schema 对象。不要为了绕过未知迁移错误而直接授予超级用户权限。

### 🔎 注册时没有收到验证码

检查 SMTP 连通性、发件人授权、`MAIL_PROVIDER` 和服务日志。终端输出验证码只用于私有开发。

### 🔎 桌面端连接到错误服务器

检查 `JANUS_AUTH_URL`、`JANUS_PACKAGED_CLOUD_URL`、安装包服务器 origin 和桌面端已保存的账号状态。使用新的 `JANUS_HOME` 验证干净配置。
