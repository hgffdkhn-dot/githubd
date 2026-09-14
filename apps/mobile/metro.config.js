/**
 * Monorepo Metro 配置
 *
 * 两个必需项，缺一个都会导致打包失败：
 * 1. watchFolders / nodeModulesPaths 指向仓库根，否则解析不到 workspace 里的 @e2ee/protocol
 * 2. resolveRequest 把 TS 源码里的 "./x.js" 映射到 "./x.ts"：
 *    protocol 包按 NodeNext 规范用 .js 后缀写导入，但磁盘上是 .ts，Metro 默认不会做这个替换
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
    const importerDir = path.dirname(context.originModulePath);
    const withoutExt = moduleName.replace(/\.js$/, '');
    for (const ext of ['.ts', '.tsx']) {
      const candidate = path.resolve(importerDir, `${withoutExt}${ext}`);
      if (fs.existsSync(candidate)) {
        return context.resolveRequest(context, moduleName.replace(/\.js$/, ext), platform);
      }
    }
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
