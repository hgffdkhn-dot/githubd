# E2EE Chat — 端到端加密一对一聊天参考实现

移动端优先（Expo / React Native）+ Node 服务端，一期只做**一对一文本聊天**，采用 **Signal 协议：X3DH 握手 + Double Ratchet 双棘轮**。

> ⚠️ 这是**可运行、可测试的教学与架构骨架**，不是审计过的生产实现。上线前必须替换密码学层为 libsignal / vodozemac，并完成第三方安全评估。

## 它保证什么

- 服务端只经手公开密钥与密文，**结构上无法解密**任何消息
- **前向安全**：棘轮每条消息推进，旧消息密钥用完即弃
- **后向安全（受损恢复）**：每次收发方向反转都引入新 DH 输出，密钥泄露可自愈
- **乱序/丢包容忍**：跳过密钥机制 + 上限保护
- **篡改可检测**：AES-256-GCM 认证失败即抛错，绝不返回部分明文
- **身份可核对**：60 位安全码供当面比对

## 快速开始

```bash
npm install            # 工作区安装（packages/protocol + apps/server + apps/mobile）
npm run server         # 启动服务端，默认 http://localhost:8787
npm test               # 10 项协议互操作测试 + 4 项端到端联调测试
```

移动端（**必须用开发构建**，依赖 `react-native-quick-crypto`、`expo-secure-store`、`expo-sqlite` 原生模块，Expo Go 跑不起来）：

```bash
npm run dev:cert                      # 生成开发用自签证书（可选，真机强烈建议）
TLS_CERT=.tmp/tls/cert.pem TLS_KEY=.tmp/tls/key.pem npm run server

cp apps/mobile/.env.example apps/mobile/.env
# 把里面的 IP 改成你电脑的局域网 IP：macOS 用 ipconfig getifaddr en0，Linux 用 hostname -I
npm run check:server -- https://<你的局域网 IP>:8787   # 先验服务端，再开 App

cd apps/mobile && npm install
npx expo run:ios      # 或 npx expo run:android
```

### 真机闭环验证步骤

1. `npm run check:server -- https://<局域网 IP>:8787` 全部通过（服务可达、未认证 401、明文字段 400）
2. 两台设备（或模拟器 + 真机）分别注册 `alice` / `bob`
3. alice 搜索 `bob` → 进入会话 → 发第一条消息（自动完成 X3DH 握手）
4. bob 收到并解密成功 → 回复 → alice 解密成功
5. 杀死 bob 的 App → alice 连发 3 条 → 重启 bob → 离线消息应自动补齐（`drainPending`）
6. 在 alice 侧查看安全码，与 bob 侧比对，应完全一致

**真机最常见的坑**：手机上的 `localhost` 指手机自己，必须填电脑的局域网 IP；iOS ATS 与 Android 9+ 默认拦截明文 HTTP，要么用 HTTPS，要么确认 `app.json` 里的 ATS 例外与 `usesCleartextTraffic` 已生效。

## GitHub Actions

| 工作流 | 触发 | 作用 |
|---|---|---|
| `ci.yml` | push / PR | 协议层 10 项测试、服务端 6 项测试、类型检查、安全边界静态扫描 |
| `build-android.yml` | 手动 / `v*` tag | 构建自包含 APK（standalone）、开发调试 APK（debug）或上架 AAB（release） |
| `build-ios.yml` | 手动 | 通过 EAS Build 构建 iOS（需 `EXPO_TOKEN`） |

### 需要配置的密钥

在仓库 **Settings → Secrets and variables → Actions** 添加：

| 名称 | 用途 | 必需 |
|---|---|---|
| `EXPO_TOKEN` | EAS Build 鉴权，在 expo.dev 生成 | iOS 构建必需 |
| `ANDROID_KEYSTORE_BASE64` | 发布签名库（base64） | release 构建 |
| `ANDROID_KEYSTORE_PASSWORD` | 签名库口令 | release 构建 |
| `ANDROID_KEY_ALIAS` | 签名别名 | release 构建 |
| `ANDROID_KEY_PASSWORD` | 签名密钥口令 | release 构建 |
| `EXPO_PUBLIC_API_URL` | 变量（非密钥），服务端地址 | 建议配置 |

未配置签名密钥时 release 构建产出未签名产物；debug 构建无需任何密钥，可直接下载安装的 APK。

### 打开后一片纯白？

白屏 = 组件树在初始化阶段崩了，但异常没冒出来（这是 React 的默认行为：整棵树卸载后什么都不渲染）。

已加两道防护：

1. `src/ui/ErrorBoundary.tsx` —— 捕获渲染异常并显示错误堆栈，而不是留白
2. `ChatProvider` 容错 —— `new ChatEngine()` 会注入 quick-crypto 并打开 SQLite，任一失败都不再让整棵树崩掉，而是转入 `broken` 状态并在登录页显示原因

登录页现在有登录/注册切换，界面层用 **react-native-paper**（Material Design 3），按钮、输入框、卡片、列表都遵循 Material You 规范，观感接近原生 Android。

### 打包报 Unable to resolve module react-native-safe-area-context？

`expo-router` 只是个壳，安全区、原生屏幕、深链、常量、状态栏都是它的 **peer 依赖**，必须显式安装：

```bash
npx expo install expo-router react-native-safe-area-context react-native-screens \
  expo-linking expo-constants expo-status-bar
```

用 `expo install` 而不是 `npm install`——它会按当前 SDK 挑选匹配版本，避免手写版本号漂移。缺任何一个，都要等到三分钟后的 `createBundleReleaseJsAndAssets` 才报 `Unable to resolve module`，非常浪费时间。CI 里已加秒级校验，缺失会立刻失败。

### 装到手机上红屏 "Unable to load script"？

因为你装的是 **debug** 构建。debug 构建**故意不把 JS bundle 打进 APK**，它启动时去连你电脑上 `localhost:8081` 的 Metro 服务；手机连不到，就红屏。

三种产物，选对：

| 类型 | 命令 | JS bundle | 装到手机能否直接跑 |
|---|---|---|---|
| `standalone` | `assembleRelease` | 已内置 | ✅ 能，装完即用（推荐） |
| `debug` | `assembleDebug` | 不内置 | ❌ 不能，必须 `npx expo start --dev-client` 并扫码，且手机与电脑同 Wi-Fi |
| `release` | `bundleRelease` | 已内置 | 产出 AAB，供 Google Play 上架 |

要能直接安装测试的 APK，请选 **`standalone`**（workflow 已设为默认）。它走 release 变体，JS 被打进 APK；Expo 模板默认让 release 复用 debug 签名，所以**不需要任何签名密钥**就能产出可安装的 APK。

workflow 里有一道校验：上传前用 `unzip -l` 检查 APK 内是否有 `assets/index.android.bundle`，standalone 类型若缺失会直接失败，不会再让你下载一个打不开的包。

### 版本锁定说明（重要）

`apps/mobile/app.json` 里通过 `expo-build-properties` 锁定了 `android.kotlinVersion: "1.9.25"`，**不要随意删除**。

原因：Compose Compiler 与 Kotlin 必须严格配对——1.5.15 ⇄ 1.9.25，1.5.14 ⇄ 1.9.24（见 [官方兼容表](https://developer.android.com/jetpack/androidx/releases/compose-kotlin)）。Expo SDK 52 默认 Kotlin 1.9.24，而依赖链会拉入 Compose Compiler 1.5.15，两者不匹配会导致：

```
e: This version (1.5.15) of the Compose Compiler requires Kotlin version 1.9.25
   but you appear to be using Kotlin version 1.9.24
> Task :expo-modules-core:compileDebugKotlin FAILED
```

修法必须是改配置而不是手改 `android/build.gradle`——`expo prebuild --clean` 会覆盖原生目录，手改的会被冲掉。CI 中有两道防线：构建前校验 `app.json` 锁定存在，prebuild 后校验 `gradle.properties` 注入成功，避免每次都烧掉一个完整的 Android 构建才发现。

## 目录结构

```
packages/protocol      # 协议核心：X3DH、Double Ratchet、安全码、信封编解码
  src/primitives.ts    # 原语层（AES-GCM / X25519 / Ed25519 / HKDF），provider 可注入
  src/x3dh.ts          # 异步握手
  src/ratchet.ts       # 双棘轮：对称链棘轮 + DH 棘轮
  src/session.ts       # SessionManager：握手、加密、解密编排
  test/                # 互操作测试
apps/server            # 盲转发服务端
  src/api.ts           # HTTP：注册登录、PreKey 分发、信封收发、字段白名单
  src/gateway.ts       # WebSocket：长连接、心跳、推送、ack
  src/store.ts         # 只存公开材料与密文
  test/                # 端到端联调测试（含服务端快照明文自检）
apps/mobile            # Expo 客户端
  src/crypto/          # quick-crypto AEAD 注入、Keychain/Keystore 封装
  src/storage/         # SQLite：会话状态 + 消息密文
  src/network/         # API 客户端、WebSocket 流
  src/chat/            # ChatEngine：自动建会话、自动补预密钥、解密后 ack
docs/                  # 威胁模型与生产化清单
```

## 协议与接口

### 密钥层级

| 密钥 | 生命周期 | 存储 | 是否上传 |
|---|---|---|---|
| Identity Key（X25519 + Ed25519） | 长期 | Keychain / Keystore | 仅公钥 |
| Signed PreKey | 约 7 天轮换 | 安全存储 | 仅公钥 + 签名 |
| One-Time PreKey | 每次握手消耗一个 | 安全存储 | 仅公钥 |
| Ephemeral Key | 单次握手 | 内存 | 仅公钥（随首包） |
| Root / Chain / Message Key | 会话内滚动 | 加密数据库 | 永不 |

### HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register` | 注册并发布首批预密钥 |
| POST | `/v1/auth/login` | 登录，返回 Bearer token |
| POST | `/v1/prekeys/publish` | 补充/轮换预密钥 |
| GET | `/v1/prekeys/bundle/:userId/:deviceId` | 领取 Bundle，**OPK 原子消耗** |
| GET | `/v1/devices/:userId` | 列出对端设备公开身份 |
| GET | `/v1/users/search?q=` | 用户发现 |
| POST | `/v1/messages` | 投递信封（字段白名单校验） |
| GET | `/v1/messages/pending` | 拉取离线信封 |
| POST | `/v1/messages/ack` | 解密成功后确认删除 |

### WebSocket `/v1/ws?token=`

- `ready` — 连接就绪
- `envelope` — 推送信封（客户端解密成功后才 ack）
- `prekey.low` — 提示对端补充一次性预密钥
- 客户端 → 服务端：`{ type: "ack", envelopeIds: [...] }`

## 与生产的差距（必须补齐）

1. **换掉自研协议层**：改用 libsignal（AGPL-3.0，注意分发义务）或 vodozemac（Apache-2.0）原生绑定，本仓库的 `packages/protocol` 仅供理解与联调
2. **加密消息头**：实现 Signal 的 header key（AHEAD），否则服务端可见棘轮公钥与消息序号
3. **加密数据库**：`expo-sqlite` 换成 op-sqlite(SQLCipher)，整库由 Keystore 中的 DBKEK 保护
4. **补齐能力**：多设备同步、群聊（MLS）、文件传输、密钥备份与恢复
5. **工程化**：TLS 证书固定、速率限制、证书透明度、崩溃日志脱敏、依赖锁定与 SBOM
6. **独立安全评估**：威胁建模、模糊测试、协议互操作测试、第三方审计与漏洞披露流程

详见 `docs/THREAT-MODEL.md`。
