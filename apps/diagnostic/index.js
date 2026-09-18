/**
 * 入口文件
 *
 * 不能用 main: "node_modules/expo/AppEntry.js"（Expo 模板默认值）：
 * 那是相对路径，monorepo 下依赖被提升到仓库根，apps/diagnostic/node_modules/expo 并不存在，
 * 解析结果为空 → Gradle 报 "path may not be null or empty string. path=''"。
 *
 * 用 index.js + registerRootComponent：'expo' 是包标识符，走 node_modules 提升查找，稳。
 */

import { registerRootComponent } from 'expo';
import App from './App';

// JS 异常不再静默白屏，直接打到控制台便于 adb 捞取
const ErrorUtils = globalThis.ErrorUtils;
if (ErrorUtils?.setGlobalHandler) {
  const previous = ErrorUtils.getGlobalHandler?.();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    console.error(`[diag] ${isFatal ? 'FATAL' : 'JS'}`, error?.stack || error);
    previous?.(error, isFatal);
  });
}

registerRootComponent(App);
