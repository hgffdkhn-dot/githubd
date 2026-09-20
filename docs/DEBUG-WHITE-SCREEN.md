# 白屏排查指南

## 首选：用诊断工程做二分定位

白屏最怕的是"只有一个笼统现象，无法归因"。`apps/diagnostic` 就是为此存在的。

**做法**：在 GitHub Actions 跑 `Build Diagnostic` 工作流，装产出的 APK。

它启动后只渲染一个纯 RN 的 Hello World，**不 import 任何原生模块**（所有原生模块都用 `require()` 延迟加载并逐个 try/catch）。

三种结论，直接对应不同的修法：

| 你看到的 | 结论 | 下一步 |
|---|---|---|
| Hello World 都白屏 | **构建或环境问题**，与业务代码无关 | 检查构建类型是否为 standalone（release 变体）、JS bundle 是否内置 |
| Hello World 正常，某模块红色 | **该模块就是元凶** | 它未正确链接，见下方"模块链接失败怎么办" |
| 全部绿色 | 原生层没问题 | 问题在业务代码，用 App 内的崩溃记录卡片看堆栈 |

诊断工程会检测：expo-secure-store、expo-sqlite、react-native-quick-crypto、react-native-keychain、react-native-paper、react-native-vector-icons、react-native-safe-area-context、react-native-screens，以及 Hermes 环境下的 `globalThis.crypto` 和 `Buffer` polyfill。

每个探针都不只是 `require` 成功就算过，而会**实际调用一次**（例如 quick-crypto 会做完整的 AES-256-GCM 加解密往返）——因为模块能 import 不代表原生侧真的可用。

## ⚠️ 一次错误推断的纠正

曾根据日志中的 `VA_AppStateWatcher`、`VA_HybridLifecycleListener`、`top.hookvip.pro`（沙箱/Hook 工具痕迹），推断"设备 Keystore 不可用导致硬崩溃"。

**这个推断不成立。** 用户提供的「密钥认证」结果证明硬件层完全正常：

- Google 硬件认证根证书 ✓
- 引导加载程序已锁定 ✓
- 证书链 TEE、Keymaster 4.0、安全等级=可信环境 ✓

日志里的沙箱/Hook 痕迹只能说明**这类工具存在**，不能推出 Keystore 不可用——attestation 才是直接证据，它是反证。

### 但 attestation 正常 ≠ 出问题的那个 API 正常

attestation 验证的是**密钥认证链**（硬件背书可信），而 `expo-secure-store` 用的是 Keystore 的**对称密钥 + 特定 accessible 档位**。两者是不同层面：

| 层面 | attestation 能证明 | 不能证明 |
|---|---|---|
| 硬件 TEE / Keymaster | ✓ 正常 | — |
| 某个 accessible 档位可用 | ✗ | 需实测 |
| `expo-secure-store` 在当前 ROM 正常 | ✗ | 需实测 |
| 原生模块已正确 autolink | ✗ | 需实测 |

其中 `WHEN_UNLOCKED_THIS_DEVICE_ONLY` 这类档位在部分设备上要求**已设置锁屏凭证**（PIN/图案/密码），与主工程原先使用的档位一致，属于重点怀疑对象。

### 因此诊断 v3 的核心改动

把 secure-store **按档位拆开测**，并保留错误类型名：

- `expo-secure-store（默认档）`
- `expo-secure-store（THIS_DEVICE_ONLY 档）`

从而区分三种完全不同性质的结果：

| 结果 | 含义 | 对策 |
|---|---|---|
| **报错**（有错误类型名） | JS 可捕获的异常 | 看错误信息，多为配置/凭证问题 |
| **崩溃**（进程消失） | 原生层硬崩溃 | 该模块在当前 ROM 不可用 |
| **正常** | 无问题 | 排除嫌疑 |

### 对策：崩溃自愈

无法捕获崩溃，但可以**记住它**。主工程的 `src/storage/safeStore.ts` 实现了：

1. 使用 Keystore 前，先用文件写一个"正在试探"标记
2. 调用成功 → 清除标记
3. 硬崩溃 → 标记留在磁盘上没被清除
4. 下次启动读到标记 → 判定 Keystore 不安全，**永久绕开**，改用文件存储

**效果：第一次崩溃，第二次启动自动恢复可用。** 存储后端可通过 `currentBackend()` 查询（keystore / file / memory），界面上会提示安全级别。

### 主工程配套改造

所有 Keystore 类依赖已改为**延迟 require**（顶层 import 会在 bundle 加载期触发原生解析，直接白屏）：

| 文件 | 改动 |
|---|---|
| `src/storage/safeStore.ts` | 新增，统一键值存储 + 崩溃标记 |
| `src/crypto/Keystore.ts` | 改走 safeStore；Keychain 延迟加载并降级 |
| `src/ui/crashLog.ts` | 改走 safeStore，自身不再依赖原生模块 |
| `src/storage/Database.ts` | expo-sqlite 延迟加载 |
| `src/crypto/QuickCryptoAead.ts` | quick-crypto 延迟加载 |

⚠️ 注意：这套降级机制是**针对极端环境的兜底**，并非因为确认了 Keystore 有问题（见上文纠正）。在 attestation 正常的设备上不应触发。

降级到文件存储意味着**密钥不再受硬件保护**，安全性实质下降。生产环境应要求设备具备可用 Keystore，并在检测到降级时拒绝运行或强制告警，而不是默默降级。

## 为什么 ErrorBoundary 救不了某些白屏

这是最反直觉的一点：**如果原生模块在模块顶层被 import 且加载失败，异常发生在 React 挂载之前**，ErrorBoundary 根本没机会工作，全局 handler 也可能来不及接管。结果是纯白，且崩溃记录为空。

所以主工程已把最危险的几个依赖改成延迟 `require` + try/catch：

- `src/ui/crashLog.ts` —— 兜底机制本身绝不能因依赖缺失而崩，SecureStore 不可用时退化为内存记录
- `src/crypto/quickCryptoAead` —— 社区原生模块，autolinking 失败风险最高
- `ChatEngine` 构造期不再打开 SQLite，推迟到 `start()`

## 模块链接失败怎么办

| 模块 | 常见原因 | 对策 |
|---|---|---|
| react-native-quick-crypto | 需要 autolinking；Expo Go 不支持 | 必须用开发构建 / 独立 APK，不能用 Expo Go |
| expo-sqlite / expo-secure-store | 未走 prebuild | `npx expo prebuild --platform android --clean` 后重新构建 |
| react-native-keychain | 原生链接丢失 | 重新 prebuild；确认未使用 Expo Go |
| react-native-paper/vector-icons | 纯 JS，一般不会失败 | 失败说明依赖没装，用 `npx expo install` 补 |

通用修法：

```bash
cd apps/mobile
npx expo prebuild --platform android --clean
cd android && ./gradlew clean && cd ..
# 重新构建
```

## 关于"换成 Jetpack Compose"

**这条路走不通，需要先澄清一个技术误解。**

- Jetpack Compose 是 **AndroidX 的一部分**（包名就是 `androidx.compose.*`）。之前那条 Kotlin 版本报错里的 Compose Compiler，正来自 AndroidX。所以"抛弃 AndroidX、改用 Compose"在概念上不成立。
- 更关键的是：Compose 是**原生 Kotlin UI 框架**，而 React Native 的 UI 由 JS 渲染。两者不在同一层，**不能替换**。要让这个 App 用 Compose，等于放弃整个 RN/Expo 前端，用 Kotlin 重写全部界面，协议层也要换成 libsignal 的 Java 绑定或重写——那是一个完全不同的项目，不是改配置能切过去的。

真正值得做的"最小化验证"，是诊断工程这条路径：同样的构建流程、同样的依赖，只把 UI 换成 Hello World，从而把问题范围收窄到"环境"还是"代码"。

## 白屏真凶：`TurboModuleRegistry.getEnforcing(...): 'QuickBase64' could not be found`

### 根因

`react-native-quick-crypto` 依赖另一个**独立安装**的原生模块 **`react-native-quick-base64`**，但它**没有把它声明为 npm 依赖**。所以它不会被自动装上，也不会报"找不到包"，而是在原生侧直接抛：

```
TurboModuleRegistry.getEnforcing(...): 'QuickBase64' could not be found
```

这两点让它特别难查：
- 属于**原生层错误**，JS 的 try/catch 拦不住 → 表现为白屏
- 错误信息里的 `QuickBase64` 在 `package.json` 里根本搜不到，看不出缺哪个包

官方安装说明确实是两条命令：

```bash
expo install react-native-quick-crypto
expo install react-native-quick-base64   # ← 容易漏
```

### 修法

1. 两个工程的 `package.json` 都加上 `react-native-quick-base64`
2. `QuickCryptoAead.ts` 在使用前显式装载它的 JSI 绑定（`ensureBase64()`），缺了会抛出可读的错误而不是白屏

### 版本选择：为什么锁 2.2.2

`react-native-quick-base64` 3.0.0+ 是**纯 C++ TurboModule，强制要求 New Architecture**：

- 满足 → 正常
- 不满足 → 报的正是 `QuickBase64 could not be found`，与"没装这个包"的错误**完全一样**，极易误判

2.2.2 同时支持新旧架构，因此锁定 `2.2.2` 更稳妥。若后续确认 New Architecture 稳定开启，再考虑升到 3.x。

### 顺带改进：崩溃详情可长按复制

登录页的"上次启动异常"详情加了 `selectable`，长按即可选中复制——不用再连电脑捞日志，也不用截图转述。

## 界面显示 "Network request failed"

**这是好消息**：说明白屏已解决，App 正常跑起来了，只是连不上服务端。

### 最常见成因：地址是 localhost

`EXPO_PUBLIC_API_URL` 在**构建时**被烘焙进 bundle。若构建时没配置仓库变量，fallback 是 `https://localhost:8787` —— 而**手机上的 localhost 指手机自己**，那里没有服务端，必然连接失败。

### 修法

三种，任选：

1. **运行时改（推荐，免重新打包）**：登录页顶部显示当前服务器地址，点"修改"填入电脑的局域网 IP，保存即生效
2. 构建前在仓库 **Settings → Secrets and variables → Actions → Variables** 添加 `EXPO_PUBLIC_API_URL = http://<电脑局域网IP>:8787`
3. 本地构建时设 `apps/mobile/.env`

查看电脑 IP：macOS `ipconfig getifaddr en0`，Linux `hostname -I`，Windows `ipconfig`。

### 配套改进

- `src/network/serverConfig.ts`：地址持久化，运行时可改，不必重新打包
- `ApiClient` 捕获连接失败，给出**带地址与排查提示**的错误，而不是一句 `Network request failed`
- 登录页常驻显示当前服务器地址

## 历史消息读不回来（不是"没存"，是"解不开"）

### 症状

退出应用再进来，聊天记录空了。

### 根因有两层，别只修一层

**第一层：UI 根本没去读。** 会话页只展示内存里的 `messages`，
重开应用后内存是空的，而数据库里的记录没人去加载。

**第二层（更关键）：即便读了密文也解不开。**
Double Ratchet 的消息密钥是一次性的，解密后即丢弃，
事后再拿 ciphertext 去解密必然失败 —— 这是前向安全的固有代价。

所以历史可读性**完全依赖落库时是否缓存了明文**。
数据库里本来就预留了 `plaintext_preview` 列，之前一直没写入。

### 修法

- `saveMessage` 落库时写入明文（受"本地消息缓存"开关控制）
- 新增 `loadHistory()`：读数据库缓存，不尝试重新解密
- 会话页进入时加载历史，与实时消息按 envelopeId 合并去重（内存优先）
- 关闭缓存时，历史显示"（消息内容未缓存）"而不是假装消息丢了

### 相关取舍

明文落库只影响本机：服务端始终只经手密文，E2EE 强度不变。
风险限于"设备被物理接触"的场景，可在 设置 → 安全 关闭。

## 服务器正常但收不到消息（半开连接）

### 症状

服务端进程在、`/healthz` 正常，但对方发来的消息收不到。
杀掉 App 重开就恢复了。

### 根因：WebSocket 半开

移动网络下（切基站、息屏、进电梯）TCP 连接其实已断，
但双方都收不到 FIN，socket.readyState 一直是 OPEN。

后果很隐蔽：**不会触发 onclose**，所以重连逻辑永远不会执行，
连接就这么"假活"着，消息全部丢在服务端。

### 修法：心跳 + 看门狗

- 每 15 秒发一次 `ping`，8 秒内没收到 `pong` 就判定连接已死
- 服务端网关新增 `ping → pong` 帧处理
- 重连成功后触发 `onReconnect`，**主动补拉离线信封** ——
  断开期间服务端堆积的信封不会自动重推，不补拉就漏消息

### 判断要点

"重连成功"不等于"消息补齐"。两者必须都做，缺一仍会漏。

## 设备管理一直显示占位设备名

### 根因

设备型号只在 `register` / `login` 时上报。
而 `restoreSession`（重开 App 走的路径）不走这两条，
所以老账号的设备名永远停留在早期"客户端没上报设备信息"时留下的占位值。

### 修法三层

1. 新增 `POST /v1/devices/label`，任何登录态都能刷新设备名
2. `restoreSession` 与登录成功后各上报一次
3. **服务端展示层兜底**：老快照里的"未命名设备"/"未知设备"/空串
   统一换成"Android 设备" —— 这样不用等所有设备重新登录才修复

第 3 层很关键：只改客户端的话，服务端存量脏数据仍在。

## 明文落库这件事要如实说

`plaintext_preview` 存的是明文，这是**可用性换来的取舍**，不是疏漏。
在 UI 与文档里都必须讲清楚：它不改变端到端加密的强度，
但会扩大本机泄露面。不要写"安全无影响"这种话。

## 清除应用数据后注册报"地址指向了本机"

### 症状

清除应用数据 → 重新打开 → 注册，提示"服务器地址指向了本机，请检查配置"。

### 根因

地址取值链上出现了 `localhost`，而**手机上的 localhost 指手机自己**，
永远连不上服务端。

两个因素叠加：

1. 清数据后本地覆盖值没了，回退到构建时烘焙的 `BUILTIN_SERVER`
2. `process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_SERVER` 里的 **`??`
   只对 null/undefined 兜底，空字符串会原样通过** ——
   构建时若该变量被设成空串，兜底就失效了

### 修法

出口统一过 `normalizeServerUrl()`：空值、`localhost`、`127.0.0.1`、
`0.0.0.0`、格式非法的地址，一律换回 `DEFAULT_SERVER`。

写入本地时也归一化，避免把无效地址存进去。

### 防线

`apps/mobile/test/serverConfig.test.ts`，5 项，已接入构建工作流：

- 空值一律回退
- localhost/127.0.0.1/0.0.0.0 必须被换掉
- 格式非法（`47.239.14.144:8787` 这种没写协议的）回退
- 正常地址原样保留
- **默认服务器地址本身不能是本机地址**（防止改 DEFAULT_SERVER 时改回去）

### 教训

`??` 不是万能兜底，**空字符串会穿透**。凡是"配置缺失就用默认值"的场景，
都要显式判断空串，而不是只靠 `??`。

## 界面报 `Property 'X' doesn't exist`（ReferenceError）

### 症状

注册时报 `Property 'savePreKeyPrivate' doesn't exist`，
会话恢复时报 `Property 'loadToken' doesn't exist`，且是 ReferenceError。

### 根因：import 漏了名字

`ChatEngine.ts` 调用了 `loadToken`、`savePreKeyPrivate`、`SecurePreKeyStore`、
`SPK_PREFIX`、`OPK_PREFIX`、`saveToken` 共 6 个 `Keystore.ts` 的导出，
但 import 语句里**漏了它们**。

### 为什么构建能通过

**Metro 用 Babel 打包，不做类型检查。** 漏 import 的名字在 Babel 眼里是一个
"全局变量引用"——语法完全合法，构建照样成功、APK 照样产出。
直到真机跑到那一行，Hermes 才发现这个全局变量不存在，抛 ReferenceError。

### 为什么难查

错误信息说"属性不存在"，指向的是函数名而不是 import 语句。
看起来像"模块坏了""原生模块没链接"，很容易往错误方向查。

### 防线

`scripts/check-imports.mjs`：扫描所有文件，找出"使用了项目内某处的导出、
但本文件没有 import"的标识符，构建前秒级失败。已接入两个构建工作流。

脚本做了防误报处理：**前面紧跟 `.` 的用法视为属性访问并跳过**
（`Buffer.concat`、`m.randomBytes` 这类是别的对象的方法，不是裸标识符）。

已验证：能精确抓出本次事故的 `loadToken` 与 `savePreKeyPrivate`；
修复后通过；对诊断工程、协议层、服务端均无误报。

### 教训

改动 import 语句时（尤其是用脚本批量改写多行 import），
**必须确认改完后原有名字一个都没丢**。本次就是改写 import 块时的回归。

## 服务端 PUT 请求体被静默丢弃

### 症状

`PUT /v1/profile` 保存资料后，服务端存的却是空资料；public 模式缺昵称也没有按预期报 400。

### 根因

服务端只在 POST 时读取请求体：

```js
const body = method === 'POST' ? await readJson(req) : {};   // ← PUT 拿到 {}
```

于是 `body.visibility` 为 `undefined`，被兜底成 `friends`，昵称校验那一步根本没执行。

### 为什么危险

friends 模式下，`encrypted` 密文会被**静默丢弃**——调用方拿到 200，以为资料已存，实际服务端存了空记录。没有任何报错，极难发现。这是那种"看起来一切正常"的 bug。

### 修法

```js
const body =
  method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readJson(req) : {};
```

### 教训

"只处理了 POST"这类不对称写法，在新增 PUT 接口时会以"静默失败"的形式暴露。**新增任何非 GET/POST 接口时，先确认请求体会被解析**，并写一个断言真实字段生效的测试（而不是只测 200）。

本次正是靠测试里的 `assert.equal(bad.status, 400)` 抓出来的——如果只测 200，就会漏掉。

## CI 报 Unable to resolve module …/legacy

### 关键教训：Metro 在打包期静态解析 require()，try/catch 完全没用

这是最容易踩的认知陷阱。看这段"看起来很稳"的代码：

```js
try {
  mod = require('expo-file-system');
} catch {
  mod = require('expo-file-system/legacy');   // ← 打包期就炸了
}
```

直觉上以为 try/catch 能兜底，**实际上不能**：Metro 在 bundle 阶段就扫描所有 `require('字面量')` 并做静态解析，模块不存在立刻报 `Unable to resolve module`，根本走不到运行时。要等四分钟 Gradle 才暴露。

**正确写法**：只引用确定存在的包，API 差异在运行时用特性检测处理：

```js
const mod = require('expo-file-system');          // 只有一个入口
const hasLegacy = typeof mod.writeAsStringAsync === 'function';
const hasNew = typeof mod.File === 'function';    // 新版 File/Directory API
```

本项目 `safeStore.ts` 与 `probeStore.ts` 已按此改造，同时兼容新旧两代 FileSystem API（旧版 `writeAsStringAsync`，新版 `File` 类）。

**防线**：`scripts/check-requires.mjs` 在构建前扫描所有 `require()`/`import` 字面量并验证可解析，秒级失败。已接入两个构建工作流。

## CI 报 "Error on ZipFile unknown archive"

发生在 `android-actions/setup-android`：该 action 会连带安装 Android Emulator（体积最大的那个包），下载中断就报这个错，整个 job 直接失败。构建 APK **用不到模拟器**。

已替换为 `scripts/setup-android-sdk.sh`，只装三个必需包（`platform-tools`、`platforms;android-35`、`build-tools;35.0.0`），每个包失败重试三次，并清理可能损坏的半成品 zip。

脚本里有个坑值得记住：**不要用 `yes | sdkmanager`**。在 `set -o pipefail` 下，sdkmanager 读完后退出，`yes` 会被 SIGPIPE 杀掉（退出码 141），管道整体判定失败——sdkmanager 明明装成功了，脚本却以为失败。改为把一批 `y` 写进临时文件再重定向喂进去。

## CI 报 "path may not be null or empty string. path=''"

出错点是 `android/app/build.gradle` 里解析入口那一行。真实成因：**Expo 的 `resolveAppEntry` 解析 `package.json` 的 `main` 失败，返回了空字符串**，Gradle 拿着空路径去 `file("")` 就炸了——错误信息完全看不出来。

典型触发场景：monorepo。`expo` 模板默认 `main` 是 `node_modules/expo/AppEntry.js`，这是**相对工程目录的路径**。而 workspace 把依赖提升到仓库根，工程目录下根本没有 `node_modules`，于是解析为空。

修法：改成 `index.js` 并显式注册根组件：

```js
// index.js
import { registerRootComponent } from 'expo';
import App from './App';
registerRootComponent(App);
```

`'expo'` 是包标识符，走 node_modules 提升查找，monorepo 下安全。

`scripts/check-entry.mjs` 会在构建前校验 main 能否解析到真实文件（相对路径与包标识符两种写法都支持），构建前几秒就能发现，不用等 Gradle。

## CI 报 "Java heap space"

发生在 `:app:collectReleaseDependencies` 这类依赖收集阶段，而且是跑了十几分钟之后才抛——最浪费时间的一种失败。

React Native Android 构建有 600+ 个 task，GitHub runner 上的 Gradle 默认堆上限不够用。

对策（`scripts/gradle-memory.sh`，在 prebuild 之后自动写入 `android/gradle.properties`）：

| 参数 | 作用 |
|---|---|
| `org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m` | 提高堆与元空间上限 |
| `org.gradle.parallel=false`、`workers.max=2` | 并行/多 worker 会成倍放大内存占用 |
| `kotlin.compiler.execution.strategy=in-process` | 避免另起 Kotlin daemon 再吃一份内存 |
| `kotlin.incremental=false` | CI 上增量编译没有意义，还占内存 |

注意：**必须在 `expo prebuild` 之后写入**，因为 prebuild 会重新生成 `gradle.properties`，提前写会被覆盖。脚本用"存在则替换"的方式写入，重复执行不会产生重复行。

**脚本不会因为找不到文件而阻断构建。** 路径定位失败时，它会退而用 `GRADLE_OPTS` 环境变量兜底（`--no-daemon` 模式下 Gradle 跑在启动它的 JVM 里，该变量直接生效），绝不因为一个健壮性措施让整个 job 白跑。可通过 `GRADLE_HEAP` 环境变量调整堆上限，默认 4096m。

⚠️ 踩过的坑：如果在构建步骤上写 `env: GRADLE_OPTS: -Xmx512m`，**步骤级 env 会覆盖脚本写入 `GITHUB_ENV` 的值**，把堆压回 512m 等于没配。已移除，不要再加回来。

如果 4g 仍然不够，设 `GRADLE_HEAP: 6144m`；runner 内存不足时再考虑启用 Gradle 构建缓存或换更大规格的 runner。

## 抓日志的正确姿势

如果仍需看 logcat：

```bash
adb logcat -c
adb shell am force-stop com.example.e2eechat    # 不杀干净会复用旧进程
adb shell am start -n com.example.e2eechat/.MainActivity
# 等白屏出现
adb logcat -d > crash.log
grep -iE "e2eechat|ReactNative|AndroidRuntime|FATAL|Fatal signal|Hermes" crash.log
```

判断日志是否有效：搜 `FATAL`、`AndroidRuntime`、`ReactNativeJS` 一条都没有，或包名只出现在 `getRecentTasks`、`mLastForegroundPackageName` 里 —— 说明抓晚了，崩溃发生在记录之前。
