#!/usr/bin/env node
/**
 * 校验源码中的模块引用都能被解析
 *
 * 为什么需要：Metro 在**打包期**静态解析 require()/import 的字符串字面量。
 * 用 try/catch 包住 require 对"模块不存在"完全无效 —— 失败发生在 bundle 阶段，
 * 根本走不到运行时，而且要等四分钟 Gradle 才暴露。
 *
 * 典型反面案例：
 *   try { mod = require('expo-file-system') }
 *   catch { mod = require('expo-file-system/legacy') }   // ← 打包期直接失败
 *
 * 校验策略（避免误报）：
 *  - 相对路径：支持 './x.js' → './x.ts' 的映射（NodeNext 写法，磁盘上是 .ts）
 *  - 包名：优先 require.resolve；失败则退化为"node_modules 下包目录是否存在"
 *    （部分依赖装不全时，完整 resolve 会失败但包其实在，不应误判）
 *  - 子路径：包存在还不够，必须子路径文件也在，这正是本次事故的类型
 *
 * 用法：node scripts/check-requires.mjs <工程目录> [...]
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.json'];
const SKIP_DIRS = new Set(['node_modules', 'android', 'ios', '.expo', 'dist', 'build', 'coverage', '.git']);
// Node 侧配置文件不进 Metro bundle，由 Node 自己解析；坏了会立刻报，不需要这里管
const SKIP_FILES = new Set(['metro.config.js', 'babel.config.js', 'metro.config.ts']);

const dirs = process.argv.slice(2).filter((a) => !a.startsWith('-')).map((a) => path.resolve(a));
if (dirs.length === 0) {
  console.error('用法：node scripts/check-requires.mjs <工程目录> [...]');
  process.exit(1);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.includes(path.extname(name)) && !SKIP_FILES.has(name)) out.push(full);
  }
  return out;
}

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;

function collect(out, file) {
  const src = readFileSync(file, 'utf8');
  for (const re of [REQUIRE_RE, IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) out.push({ spec: m[1], file });
  }
}

/** 向上找 node_modules */
function findNodeModules(from) {
  let cur = path.dirname(from);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, 'node_modules');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function fileExistsWithExts(base) {
  if (existsSync(base) && statSync(base).isFile()) return true;
  return EXTS.some((e) => existsSync(base + e)) || existsSync(path.join(base, 'index.js'));
}

/** 相对路径：Metro/Node 支持 './x.js' 指向磁盘上的 './x.ts' */
function resolveRelative(spec, file) {
  const base = path.resolve(path.dirname(file), spec);
  const stripped = spec.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const baseStripped = path.resolve(path.dirname(file), stripped);
  const candidates = [
    base,
    ...EXTS.map((e) => base + e),
    baseStripped,
    ...EXTS.flatMap((e) => [baseStripped + e, baseStripped + '.js' + e]),
    path.join(base, 'index.js'),
    path.join(baseStripped, 'index.js'),
    path.join(baseStripped, 'index.ts'),
  ];
  return candidates.some((c) => existsSync(c) && statSync(c).isFile());
}

/** 包名或包内子路径 */
function resolveBare(spec, file) {
  const requireFromHere = createRequire(file);
  try {
    if (requireFromHere.resolve(spec)) return true;
  } catch {
    // 落到下面的存在性检查
  }

  const nm = findNodeModules(file);
  if (!nm) return false;

  const parts = spec.split('/');
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const pkgDir = path.join(nm, pkg);
  if (!existsSync(pkgDir)) return false;

  // 纯包名：包目录在即可（装不全时完整 resolve 可能失败，不该误判）
  if (pkg === spec) return true;

  // 子路径：必须真实存在，否则就是本次事故的形态
  const sub = spec.slice(pkg.length + 1);
  return fileExistsWithExts(path.join(pkgDir, sub));
}

let checked = 0;
const missing = [];

for (const dir of dirs) {
  if (!existsSync(dir)) {
    console.error(`目录不存在：${dir}`);
    missing.push({ spec: dir, file: '-' });
    continue;
  }
  const files = walk(dir);
  const specs = [];
  for (const f of files) collect(specs, f);

  console.log(`${path.relative(process.cwd(), dir)}：扫描 ${files.length} 个文件，${specs.length} 个模块引用`);

  for (const { spec, file } of specs) {
    checked += 1;
    const ok = spec.startsWith('.') ? resolveRelative(spec, file) : resolveBare(spec, file);
    if (!ok) missing.push({ spec, file });
  }
}

if (missing.length > 0) {
  console.error(`\n${missing.length}/${checked} 个模块引用无法解析：`);
  for (const m of missing) console.error(`  '${m.spec}'  ← ${path.relative(process.cwd(), m.file)}`);
  console.error('\nMetro 在打包期静态解析这些字面量，try/catch 挡不住。');
  console.error('修法：只引用确定存在的包，API 差异用运行时特性检测处理。');
  process.exit(1);
}

console.log(`\n全部 ${checked} 个模块引用均可解析`);
