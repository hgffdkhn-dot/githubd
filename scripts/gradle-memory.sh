#!/usr/bin/env bash
#
# 给 Gradle 设置内存参数
#
# 为什么需要：React Native Android 构建有 600+ 个 task，GitHub runner 上的
# 默认堆上限不够，会在 :app:collectReleaseDependencies 这类依赖收集阶段
# 抛 "Java heap space" —— 而且是跑了十几分钟之后才抛，非常浪费时间。
#
# 设计原则：这是"健壮性措施"，不是"正确性门槛"。
# 找不到 gradle.properties 时绝不阻断构建 —— 改用 GRADLE_OPTS 环境变量兜底，
# 并打印目录结构供排查。宁可内存配置没生效，也不能让整个 job 白跑。
#
# 用法：bash scripts/gradle-memory.sh <工程目录或 android 目录>
#
set -uo pipefail

INPUT="${1:-android}"
HEAP="${GRADLE_HEAP:-4096m}"

echo "=== Gradle 内存配置 ==="
echo "传入路径：$INPUT"

# 1. 尝试已知布局
CANDIDATES=(
  "$INPUT/android/gradle.properties"
  "$INPUT/gradle.properties"
  "$INPUT"
)

PROPS=""
for candidate in "${CANDIDATES[@]}"; do
  if [ -f "$candidate" ]; then PROPS="$candidate"; break; fi
done

# 2. 已知布局都没命中，就递归找一层（最多 4 层，避免扫整个仓库）
if [ -z "$PROPS" ] && [ -d "$INPUT" ]; then
  echo "已知布局未命中，递归查找 gradle.properties…"
  PROPS="$(find "$INPUT" -maxdepth 4 -name gradle.properties -type f 2>/dev/null | head -1)"
fi

if [ -n "$PROPS" ] && [ -f "$PROPS" ]; then
  echo "写入 → $PROPS"

  apply_prop() {
    local key="$1" value="$2"
    # 用分组保留前缀，避免原值中的 | 等特殊字符破坏 sed 表达式
    if grep -q "^${key}=" "$PROPS"; then
      sed -i "s|^\(${key}=\).*|\1${value}|" "$PROPS"
    else
      printf '\n%s=%s\n' "$key" "$value" >> "$PROPS"
    fi
  }

  apply_prop "org.gradle.jvmargs" "-Xmx${HEAP} -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8 -XX:+HeapDumpOnOutOfMemoryError"
  apply_prop "org.gradle.parallel" "false"
  apply_prop "org.gradle.workers.max" "2"
  apply_prop "kotlin.compiler.execution.strategy" "in-process"
  apply_prop "kotlin.incremental" "false"
  apply_prop "kotlin.daemon.jvmargs" "-Xmx2048m"

  echo "已写入 gradle.properties："
  grep -E "^(org\.gradle\.(jvmargs|parallel|workers\.max)|kotlin\.)" "$PROPS" | sed 's/^/    /'
else
  echo "警告：未找到 gradle.properties，跳过文件写入（不阻断构建）"
  echo "当前目录结构："
  ls -la "$INPUT" 2>/dev/null | head -20 || echo "  $INPUT 不存在"
  find "$INPUT" -maxdepth 2 -type d 2>/dev/null | head -20 | sed 's/^/    /'
fi

#
# 关键兜底：无论文件写入成功与否，都导出 GRADLE_OPTS。
# --no-daemon 模式下 Gradle 跑在启动它的 JVM 里，GRADLE_OPTS 直接生效，
# 这条路径完全不依赖任何文件是否存在。
#
GRADLE_OPTS_VALUE="-Xmx${HEAP} -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8 -Dorg.gradle.daemon=false"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "GRADLE_OPTS=$GRADLE_OPTS_VALUE" >> "$GITHUB_ENV"
  echo "已导出 GRADLE_OPTS 到 GITHUB_ENV"
else
  echo "（非 CI 环境，未写入 GITHUB_ENV）"
fi

echo "GRADLE_OPTS=$GRADLE_OPTS_VALUE"
echo "=== 完成（堆上限 ${HEAP}）==="
exit 0
