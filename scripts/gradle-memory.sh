#!/usr/bin/env bash
#
# 给 Gradle 设置内存参数
#
# 为什么需要：React Native Android 构建有 600+ 个 task，GitHub runner 上的
# 默认堆上限不够，会在 :app:collectReleaseDependencies 这类依赖收集阶段
# 抛 "Java heap space" —— 而且是跑了十几分钟之后才抛，非常浪费时间。
#
# 注意：expo prebuild 每次都会重新生成 android/gradle.properties，
# 所以必须在 prebuild 之后追加，不能只改仓库里的文件。
#
set -euo pipefail

ANDROID_DIR="${1:-android}"
PROPS="$ANDROID_DIR/gradle.properties"

if [ ! -f "$PROPS" ]; then
  echo "未找到 $PROPS，请确认已执行 expo prebuild"
  exit 1
fi

# 已存在就覆盖，避免重复行导致后写的值被先写的覆盖
apply_prop() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$PROPS"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$PROPS"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$PROPS"
  fi
  echo "  $key=$value"
}

echo "写入 Gradle 内存配置 → $PROPS"

# 4g 堆 + 独立的 Metaspace 上限；OOM 时留下堆转储便于排查
apply_prop "org.gradle.jvmargs" "-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8 -XX:+HeapDumpOnOutOfMemoryError"

# 并行与多 worker 会成倍放大内存占用，CI 上关掉更稳
apply_prop "org.gradle.parallel" "false"
apply_prop "org.gradle.workers.max" "2"

# Kotlin 编译跑在 Gradle 进程内，避免另起一个 daemon 再吃掉一份内存
apply_prop "kotlin.compiler.execution.strategy" "in-process"
apply_prop "kotlin.incremental" "false"
apply_prop "kotlin.daemon.jvmargs" "-Xmx2048m"

echo "完成"
