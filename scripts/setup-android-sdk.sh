#!/usr/bin/env bash
#
# 准备 Android SDK（构建 APK 的最小集合）
#
# 为什么不用 android-actions/setup-android：
# 它会顺带安装 Android Emulator、NDK、CMake 等一大堆包，其中 Emulator 体积最大，
# 下载中断就会报 "Error on ZipFile unknown archive" 并让整个 job 失败。
# 构建 APK 根本用不到模拟器——这里只装必要的三个包，并带重试。
#
set -euo pipefail

SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"

# 优先 latest，GitHub runner 常见的是 16.0
SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMANAGER" ]; then
  for candidate in "$SDK_ROOT"/cmdline-tools/*/bin/sdkmanager; do
    if [ -x "$candidate" ]; then SDKMANAGER="$candidate"; break; fi
  done
fi

if [ ! -x "$SDKMANAGER" ]; then
  echo "未找到 sdkmanager，SDK 根目录：$SDK_ROOT"
  exit 1
fi

export PATH="$PATH:$(dirname "$SDKMANAGER"):$SDK_ROOT/platform-tools"
echo "使用 sdkmanager: $SDKMANAGER"

# 把 env 透传给后续 step
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "ANDROID_HOME=$SDK_ROOT" >> "$GITHUB_ENV"
  echo "ANDROID_SDK_ROOT=$SDK_ROOT" >> "$GITHUB_ENV"
  echo "$SDK_ROOT/platform-tools" >> "$GITHUB_PATH"
fi

#
# 关键：绝不能用 `yes | sdkmanager`。
# 在 set -o pipefail 下，sdkmanager 读完后退出，`yes` 会被 SIGPIPE 杀掉（退出码 141），
# 管道整体判定失败 —— 结果 sdkmanager 明明成功，脚本却以为失败了。
# 改为把一批 y 写进临时文件再用重定向喂进去，绕开 pipefail。
#
ACCEPT_FILE="$(mktemp)"
trap 'rm -f "$ACCEPT_FILE"' EXIT
for _ in $(seq 1 2000); do printf 'y\n'; done > "$ACCEPT_FILE"

echo "接受 SDK 许可…"
"$SDKMANAGER" --licenses < "$ACCEPT_FILE" >/dev/null 2>&1 || true

# 只装构建必需的三个包；Emulator / NDK / CMake 一概不装
PACKAGES=(
  "platform-tools"
  "platforms;android-35"
  "build-tools;35.0.0"
)

install_one() {
  local pkg="$1"
  for attempt in 1 2 3; do
    echo "安装 $pkg（第 $attempt 次）…"
    # 清理可能损坏的半成品，否则 sdkmanager 会一直复用坏 zip
    rm -rf "$SDK_ROOT/.temp" 2>/dev/null || true
    if "$SDKMANAGER" --install "$pkg" < "$ACCEPT_FILE" >/dev/null 2>&1; then
      echo "  $pkg 安装成功"
      return 0
    fi
    echo "  $pkg 第 $attempt 次失败，重试…"
    sleep 5
  done
  echo "  $pkg 三次均失败"
  return 1
}

failed=0
for pkg in "${PACKAGES[@]}"; do
  install_one "$pkg" || failed=1
done

if [ "$failed" -ne 0 ]; then
  echo "部分 SDK 组件安装失败。若构建仍报错，请检查 runner 上的 SDK："
  "$SDKMANAGER" --list_installed 2>/dev/null || true
  exit 1
fi

echo "Android SDK 就绪，已安装组件："
"$SDKMANAGER" --list_installed 2>/dev/null | head -20 || true
