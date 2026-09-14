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

registerRootComponent(App);
