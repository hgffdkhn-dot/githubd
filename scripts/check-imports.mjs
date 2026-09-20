#!/usr/bin/env node
/**
 * 检查"使用了项目内的导出，却没有 import"
 *
 * 为什么需要这个脚本：
 *
 * Metro 用 Babel 打包，**不做类型检查**。所以 import 漏写某个名字时，
 * 构建照样成功、APK 照样产出，但运行时该名字成了未定义的全局引用，
 * Hermes 抛 `ReferenceError: Property 'X' doesn't exist`。
 *
 * 这类 bug 只在真机跑到那行代码时才暴露，而错误信息说"属性不存在"，
 * 完全看不出是 import 漏了 —— 排查成本极高。
 *
 * 真实案例：ChatEngine.ts 调用了 loadToken / savePreKeyPrivate / SPK_PREFIX
 * 等 6 个 Keystore 导出，但 import 语句漏了它们，导致注册与会话恢复全线崩溃。
 *
 * 用法：node scripts/check-imports.mjs <目录> [...]
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const EXTS = ['.ts', '.tsx'];
const SKIP_DIRS = new Set([
  'node_modules',
  'android',
  'ios',
  '.expo',
  'dist',
  'build',
  'coverage',
  '.git',
]);

const dirs = process.argv.slice(2).filter((a) => !a.startsWith('-')).map((a) => path.resolve(a));
if (dirs.length === 0) {
  console.error('用法：node scripts/check-imports.mjs <目录> [...]');
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
    else if (EXTS.includes(path.extname(name))) out.push(full);
  }
  return out;
}

/** 去掉注释与字符串字面量，避免把注释/字符串里的名字当成使用 */
function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === ch) break;
        j += 1;
      }
      out += ' ';
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 提取文件里的具名 import（支持多行；`{` 内不会出现 `}`） */
function collectImports(src) {
  const names = new Set();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  // import * as X / import X from —— 命名空间导入无法逐名校验，记录前缀
  const ns = [];
  const nsRe = /import\s+\*\s+as\s+(\w+)\s+from/g;
  while ((m = nsRe.exec(src)) !== null) ns.push(m[1]);
  const defRe = /import\s+(\w+)\s+from/g;
  const defaults = [];
  while ((m = defRe.exec(src)) !== null) defaults.push(m[1]);
  return { names, ns, defaults };
}

/** 提取文件导出的名字 */
function collectExports(src) {
  const names = new Set();
  const pats = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+(?:interface|type|enum)\s+(\w+)/g,
  ];
  for (const re of pats) {
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  // export { A, B }
  const braceRe = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = braceRe.exec(src)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** 提取本文件自己定义的名字（含参数与解构），避免误判 */
function collectLocalDefs(src) {
  const names = new Set();
  const pats = [
    // 解构声明：const { a, b } = useXxx()
    // 不识别的话，从 hook 里取出的函数会被误报成"未导入"
    /(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?class\s+(\w+)/g,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)/g,
    /(?:export\s+)?(?:interface|type|enum)\s+(\w+)/g,
    // 类方法定义：必须紧跟 `{`（方法体）才算定义。
    // ⚠️ 不能只匹配 `name(` —— 那样连 `foo(x);` 这种调用也会被当成"本地定义"，
    // 脚本就再也不报任何问题了（曾因此漏掉真实缺陷）。
    // ⚠️ 参数表必须用 [^)]*（不跨行）。
    // 用 [\s\S]*? 的话，遇到 `get self(): {...} | null {` 这类返回类型是对象字面量的
    // getter 会匹配失败并跨行回溯，把后面好几个方法一起吞掉，造成误报与漏检。
    /(?:^|\n)\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([a-zA-Z_]\w*)\s*\([^)]*\)\s*(?::[^\n;{]*)?\{/g,
    // 解构与参数
    /(\w+)\s*[:,)]/g,
  ];
  for (const re of pats) {
    let m;
    while ((m = re.exec(src)) !== null) {
      // 解构正则的捕获组是一整串 `a, b: c`，要拆开；
      // `b: c` 取后者（本地名）
      if (m[1].includes(',')) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(/\s*:\s*/).pop().trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
        continue;
      }
      names.add(m[1]);
    }
  }
  return names;
}

// 1) 收集所有文件与它们的导出
const files = [];
for (const d of dirs) {
  if (!existsSync(d)) {
    console.error(`目录不存在：${d}`);
    process.exit(1);
  }
  files.push(...walk(d));
}

const exportedBy = new Map(); // name -> [file]
const fileInfo = new Map();

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const exports = collectExports(src);
  for (const name of exports) {
    if (!exportedBy.has(name)) exportedBy.set(name, []);
    exportedBy.get(name).push(f);
  }
  fileInfo.set(f, {
    src,
    clean: stripNoise(src),
    imports: collectImports(src),
    local: collectLocalDefs(src),
    ownExports: exports,
  });
}

// 2) 逐文件检查：用到别人的导出却没 import
const problems = [];

for (const [file, info] of fileInfo) {
  for (const [name, owners] of exportedBy) {
    // 自己导出的不用管
    if (info.ownExports.has(name)) continue;

    // 判断本文件是否"使用"了它
    // 前面紧跟 `.` 的是属性访问（如 Buffer.concat、m.randomBytes），
    // 那是别的对象的方法，不是我们要校验的裸标识符，必须排除，否则误报
    // 末尾带 `(?!\\?)`：排除 `randomBytes?:` 这类接口里的可选属性声明 ——
    // 那是类型定义，不是对别处导出的调用
    const useRe = new RegExp(`(?<!\\.)\\b${name}\\b(?!\\?)`);
    if (!useRe.test(info.clean)) continue;

    // 已具名导入 → OK
    if (info.imports.names.has(name)) continue;

    // 本地有定义（同名局部变量/参数）→ 跳过，保守处理避免误报
    if (info.local.has(name)) continue;

    // 命名空间导入（import * as X）后 X.name 的使用无法逐名判断，跳过
    let viaNs = false;
    for (const ns of info.imports.ns) {
      if (new RegExp(`\\b${ns}\\.${name}\\b`).test(info.clean)) viaNs = true;
    }
    if (viaNs) continue;

    // 只关心"别人文件导出、且本文件没从任何地方导入"的情况
    problems.push({
      name,
      file,
      definedIn: owners.filter((o) => o !== file),
    });
  }
}

const rel = (p) => path.relative(process.cwd(), p);

if (problems.length > 0) {
  console.error(`发现 ${problems.length} 处"使用但未导入"：\n`);
  for (const p of problems) {
    const where = p.definedIn.map(rel).join(', ') || '(未知)';
    console.error(`  '${p.name}'  ← ${rel(p.file)}`);
    console.error(`      定义于：${where}`);
  }
  console.error('\nMetro 用 Babel 打包不做类型检查，漏 import 会构建成功但运行时崩溃。');
  console.error('错误形如：ReferenceError: Property \'X\' doesn\'t exist');
  process.exit(1);
}

console.log(`已检查 ${files.length} 个文件，未发现"使用但未导入"的情况`);
