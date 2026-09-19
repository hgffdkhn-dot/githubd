# 服务端部署指南

把 `apps/server` 部署到云服务器，让手机能真正连上。

全程基于 **Ubuntu 22.04 LTS**，端口 **8787**，用 **PM2** 守护。

---

## 0. 先看清一件事：本服务端的存储模型

服务端是**全内存存储** —— 用户、设备、预密钥、信封、令牌、资料、在线状态都在内存 Map 里，
再定期落盘到 `data/state.json`。

这带来两个必须记住的后果：

1. **内存占用随用户数线性增长**，不是"跑个空服务"那种省法
2. **`data/state.json` 就是全部数据**，丢了它等于所有用户和会话全没了 —— 必须定期备份

---

## 0.5 当前实例信息（按你的实际机器填写）

| 项目 | 值 |
|---|---|
| 云厂商 | 阿里云 ECS |
| 地域 | 中国香港 C |
| 系统 | Ubuntu 22.04 64 位 |
| 规格 | 2 核 vCPU / 4GiB |
| 公网 IP | `47.239.14.144` |
| 系统盘 | 40GiB ESSD |

> 香港地域的两个好处：**免备案**（可绑域名 + 免费正规证书）、**走非内地流量额度**（200GB/月）。
> 代价是回内地延迟与稳定性略差，验证阶段无影响。

---

## 1. 连接服务器

**方式 A：用阿里云控制台的「远程连接」（手机/无 SSH 客户端时最省事）**

在实例列表点「远程连接」→ 选 Workbench 或 VNC → 直接在网页终端里操作。
首次会要求设置（或重置）实例密码，设完记住它。

**方式 B：在本机用 SSH**

```bash
ssh root@47.239.14.144
```

如果用密钥登录：

```bash
ssh -i ~/.ssh/你的密钥.pem root@47.239.14.144
```

首次连接会问 `yes/no`，输入 `yes`。

如果用密钥登录：

```bash
ssh -i ~/.ssh/你的密钥.pem root@<公网IP>
```

连上后先更新系统：

```bash
apt update && apt upgrade -y
```

---

## 2. 安装 Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v    # 应显示 v22.x
npm -v
```

---

## 3. 上传代码

**方式 A：在服务器上直接 clone（推荐）**

```bash
git clone <你的仓库地址> /opt/e2ee-chat
cd /opt/e2ee-chat
```

**方式 B：本地打包上传**

在自己电脑上（仓库根目录）：

```bash
# 排除依赖与本地数据，体积最小
tar czf e2ee-chat.tar.gz \
  --exclude=node_modules \
  --exclude=data \
  --exclude=.tmp \
  --exclude=.git \
  .
scp e2ee-chat.tar.gz root@<公网IP>:/opt/
```

服务器上：

```bash
mkdir -p /opt/e2ee-chat && cd /opt/e2ee-chat
tar xzf /opt/e2ee-chat.tar.gz
```

---

## 4. 安装依赖

这是 monorepo，在根目录装一次即可（tsx 是 devDependency，部署也需要它来运行 TS）：

```bash
cd /opt/e2ee-chat
npm install --include=dev
```

> **注意**：`tsx` 在 devDependencies 里。`npm install --production` 会跳过它导致启动失败，
> 所以这里必须带 `--include=dev`。

装完先本地跑一遍测试，确认环境没问题：

```bash
npm run test:protocol   # 协议层 10 项
npm run test:server     # 服务端 11 项
```

---

## 5. 启动方式选择：HTTP 还是 HTTPS

| 阶段 | 方案 | 说明 |
|---|---|---|
| 验证部署 | **HTTP** | 客户端已配置 iOS ATS 例外与 Android 明文允许，可直接跑 |
| 正式上线 | **HTTPS + 域名 + 正规证书** | 必须，见下方说明 |

### ⚠️ 关于自签证书（重要）

**不要把"IP + 自签证书"当成正式方案。** 自签证书在手机上默认不被信任，
`fetch` 会直接失败，而客户端目前没有处理自定义 CA 信任。

它只适合"验证服务是否监听"这类场景（可用 `curl -k` 测试），不适合真机连接。

**正式方案**：域名 + 免费正规证书（Let's Encrypt），客户端无需任何额外配置。

> 提醒：中国内地地域的服务器**绑定域名必须 ICP 备案**；
> 试用实例通常不支持备案。若想走域名 + 正规证书，选香港/海外地域可绕开备案。

### 5.1 验证阶段：HTTP 启动

先跑起来看看：

```bash
cd /opt/e2ee-chat/apps/server
PORT=8787 npx tsx src/index.ts
```

看到 `[e2ee-server] 监听 http://0.0.0.0:8787` 就成功了。`Ctrl+C` 退出，下面改用 PM2 守护。

### 5.2 正式阶段：HTTPS

有域名和证书后：

```bash
cd /opt/e2ee-chat/apps/server
TLS_CERT=/etc/letsencrypt/live/你的域名/fullchain.pem \
TLS_KEY=/etc/letsencrypt/live/你的域名/privkey.pem \
npx tsx src/index.ts
```

证书用 certbot 申请：

```bash
apt install -y certbot
certbot certonly --standalone -d 你的域名
```

---

## 6. 用 PM2 守护（必做）

Node.js 单进程崩了就全没了，必须守护。

```bash
npm install -g pm2
cd /opt/e2ee-chat

pm2 start "npm run server" --name e2ee-server --max-memory-restart 300M
```

**`--max-memory-restart 300M` 很关键**：服务端是内存存储，1–2GB 的小机器一旦内存涨上去
容易被系统 OOM 杀掉（表现为"服务突然没了"）。设了这个阈值，PM2 会在超限前主动重启，
比被系统杀掉体面得多。

配置开机自启：

```bash
pm2 startup      # 会输出一行命令，照着执行
pm2 save         # 冻结当前进程列表
```

常用运维命令：

```bash
pm2 status
pm2 logs e2ee-server
pm2 restart e2ee-server
pm2 stop e2ee-server
```

> 若用 HTTPS，把环境变量写进 PM2：`pm2 start ... --env TLS_CERT=... ` 或改用 ecosystem 配置文件。

---

## 7. 放行端口 8787（必做，最容易漏）

**云厂商控制台的安全组/防火墙**要手动放行，默认只开 22/80/443。
不放行的话，手机连不上，而且表现和"服务端没启动"一模一样，很容易误判。

**阿里云 ECS 的操作路径**（与腾讯云位置不同，别找错）：

实例详情页 → **安全组** 标签页 → 点安全组名称 → **入方向** → **手动添加**：

| 协议类型 | 端口范围 | 授权对象 | 说明 |
|---|---|---|---|
| TCP | 22/22 | 你的 IP（或 0.0.0.0/0） | SSH |
| TCP | 8787/8787 | 0.0.0.0/0 | 服务端（测试期） |

**授权对象填 `0.0.0.0/0` 表示允许所有来源**。正式运行后建议把 22 收紧到自己的 IP。

阿里云还有一个常见坑：**实例可能同时绑定了多个安全组**，改了一个没改另一个照样不通。
如果加了规则还是连不上，回安全组列表确认所有已绑定的组都放行了 8787。

若服务器内还开了 `ufw`，也要放行：

```bash
ufw allow 8787/tcp
ufw allow 22/tcp
ufw enable
```

---

## 8. 验证服务是否真的可达

**先在本机（服务器自己）测：**

```bash
curl http://127.0.0.1:8787/healthz
# 应返回 {"ok":true}
```

**再从外部测（自己的电脑）：**

```bash
curl http://47.239.14.144:8787/healthz
# 应返回 {"ok":true}
```

或用仓库自带的自检脚本（会连测健康检查、预密钥、注册、白名单拦截）：

```bash
npm run check:server -- http://47.239.14.144:8787
```

常见的三种失败及原因：

| 现象 | 原因 |
|---|---|
| 本机通、外部不通 | **安全组没放行 8787**（最常见） |
| 都不通 | 服务没启动，看 `pm2 logs` |
| 外部通但手机连不上 | 手机端服务器地址填错，见第 9 步 |

---

## 9. 手机端填入服务器地址

App 登录页 → 顶部显示当前服务器地址 → 点「修改」→ 填入：

```
http://47.239.14.144:8787
```

（正式 HTTPS + 域名后填 `https://你的域名:8787`）

> 之前踩过的坑：手机上的 `localhost` 指手机自己，必须填服务器的公网 IP。

---

## 10. 备份数据（必做）

`data/state.json` 是全部数据。每天备份一次：

```bash
mkdir -p /opt/e2ee-backup
cat > /usr/local/bin/e2ee-backup.sh <<'EOF'
#!/bin/bash
D=$(date +%Y%m%d-%H%M%S)
cp /opt/e2ee-chat/apps/server/data/state.json /opt/e2ee-backup/state-$D.json
# 只保留最近 7 天
find /opt/e2ee-backup -name 'state-*.json' -mtime +7 -delete
EOF
chmod +x /usr/local/bin/e2ee-backup.sh

# 每天凌晨 3 点执行
(crontab -l 2>/dev/null; echo "0 3 * * * /usr/local/bin/e2ee-backup.sh") | crontab -
```

试用期结束前，**务必把最新快照复制出来**，否则换机器时数据全丢。

---

## 11. 排查清单

遇到问题时按顺序查：

```bash
pm2 status                          # 进程在不在
pm2 logs e2ee-server --lines 50     # 有没有报错
curl http://127.0.0.1:8787/healthz  # 服务本身通不通
curl http://<公网IP>:8787/healthz   # 外部通不通（查安全组）
free -h                             # 内存还剩多少
df -h                               # 磁盘还剩多少
```

---

## 12. 已知限制（上线前必须处理）

1. **协议层是自研实现，未经过审计** —— 上线前应替换为 libsignal 或 vodozemac
2. **消息头未加密（缺 AHEAD）** —— 会泄露消息序号等元数据
3. **快照是明文 JSON** —— 里面没有私钥和明文消息，但仍应限制文件权限：`chmod 600 data/state.json`
4. **无 rate limit** —— 注册和发消息接口没有限流，公网暴露会被刷
5. **演示模式必须移除** —— 它绕过端到端加密，绝不能留在生产版本

完整清单见 `README.md` 与 `docs/THREAT-MODEL.md`。
