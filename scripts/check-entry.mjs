#!/usr/bin/env node
/**
 * 校验 package.json 的 main 字段能被真正解析到文件
 *
 * Gradle 报 "path may not be null or empty string. path=''" 时，
 * 真正的成因是 Expo 的 resolveAppEntry 解析 main 失败、返回了空字符串，
 * 但错误信息完全看不出来。这里在构建前先查一次，秒级失败。
 *
 * 用法：node scripts/check-entry.mjs <工程目录>
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node scripts/check-entry.mjs <工程目录>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const main = pkg.main;

if (!main) {
  console.error(`${dir}/package.json 缺少 main 字段`);
  process.exit(1);
}

console.log(`工程：${dir}`);
console.log(`main：${main}`);

// 两种写法都要支持：
//   - "index.js" / "./index.js" —— 相对工程目录的文件路径（Node 对 main 的语义）
//   - "expo-router/entry"       —— 包标识符，走 node_modules 提升查找
const requireFromDir = createRequire(path.join(path.resolve(dir), 'noop.js'));
const asPath = path.resolve(dir, main);

let resolved;
try {
  resolved = existsSync(asPath) ? asPath : requireFromDir.resolve(main);
} catch (error) {
  console.error(`\n无法解析 main "${main}"：${error.message}`);
  console.error('常见原因：monorepo 下 main 写成 "node_modules/expo/AppEntry.js" 这类相对路径，');
  console.error('但依赖被提升到仓库根，工程目录下并不存在 node_modules。');
  console.error('改成 "index.js"（配合 registerRootComponent）或包标识符即可。');
  process.exit(1);
}

if (!existsSync(resolved)) {
  console.error(`\n解析成功但文件不存在：${resolved}`);
  process.exit(1);
}

console.log(`解析到：${resolved}`);
console.log('入口文件校验通过');
