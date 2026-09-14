# 白屏排查指南

## 首先：确认日志抓对了

白屏排查 90% 的时间浪费在"抓到一份不含崩溃的日志"。判断方法：

- 日志里搜 `FATAL`、`AndroidRuntime`、`ReactNativeJS`、`Fatal signal` —— 一条都没有，说明抓错了
- 搜你的包名 `com.example.e2eechat`，如果只出现在 `getRecentTasks`、`mLastForegroundPackageName` 这类系统行里，说明**日志开始时 App 已经被切到后台了**，崩溃发生在记录之前

### 正确抓法

```bash
# 1. 清空旧日志
adb logcat -c

# 2. 彻底杀掉 App（重要：不清干净会复用旧进程）
adb shell am force-stop com.example.e2eechat

# 3. 冷启动
adb shell am start -n com.example.e2eechat/.MainActivity

# 4. 等白屏出现后，导出全部日志
adb logcat -d > crash.log

# 5. 本地过滤
grep -iE "e2eechat|ReactNative|AndroidRuntime|System\.err|FATAL|Fatal signal|Hermes" crash.log
```

只想看这个进程（Android 7+）：

```bash
adb logcat -d --pid=$(adb shell pidof com.example.e2eechat) > crash.log
```

注意 `force-stop` 后 PID 会变，用 `--pid` 要在启动之后立刻执行。

## App 自带的崩溃记录

从这一版起，未捕获异常会**落盘**，下次启动在登录页直接显示（红色"上次启动异常"卡片，点"查看详情"展开堆栈）。

覆盖的来源：

| tag | 含义 |
|---|---|
| `fatal` | 未捕获的致命 JS 异常（白屏主因） |
| `js` | 未捕获的非致命 JS 异常 |
| `render` | React 渲染期异常，被 ErrorBoundary 捕获 |
| `engine-init` | ChatEngine 构造失败（quick-crypto 注入或 SQLite 打不开） |
| `restore` | 会话恢复失败 |

记录只含异常类型与堆栈，不含消息内容、密钥或身份信息。看完点"清除记录"即可。

## 常见成因与对策

| 现象 | 成因 | 对策 |
|---|---|---|
| 装完就白屏 | debug 构建不含 JS bundle | 改用 `standalone` 构建，见 README |
| 缺依赖模块 | `expo-router` 的 peer 依赖没装 | `npx expo install` 补齐，CI 已加校验 |
| 启动即崩 | quick-crypto 原生模块未链接 | 需开发构建，Expo Go 跑不了 |
| 登录页正常，进会话白屏 | 路由文件缺失或参数类型错 | 看 `render` 标签的堆栈 |

## 仍未解决时

把下面三样一起发来，基本一次就能定位：

1. `adb logcat -d` 过滤后的完整输出
2. App 内"上次启动异常"的 tag 与堆栈
3. 构建类型（standalone / debug / release）与 `npx expo-env-info` 输出
