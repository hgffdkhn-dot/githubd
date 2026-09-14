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

## CI 报 "Error on ZipFile unknown archive"

发生在 `android-actions/setup-android`：该 action 会连带安装 Android Emulator（体积最大的那个包），下载中断就报这个错，整个 job 直接失败。构建 APK **用不到模拟器**。

已替换为 `scripts/setup-android-sdk.sh`，只装三个必需包（`platform-tools`、`platforms;android-35`、`build-tools;35.0.0`），每个包失败重试三次，并清理可能损坏的半成品 zip。

脚本里有个坑值得记住：**不要用 `yes | sdkmanager`**。在 `set -o pipefail` 下，sdkmanager 读完后退出，`yes` 会被 SIGPIPE 杀掉（退出码 141），管道整体判定失败——sdkmanager 明明装成功了，脚本却以为失败。改为把一批 `y` 写进临时文件再重定向喂进去。

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
