/**
 * 设备信息上报
 *
 * 用于"设置 → 隐私 → 设备管理"里展示登录设备。
 *
 * 设计要点：
 *  - **所有原生依赖一律延迟 require**（expo-device 与 react-native 都是）。
 *    顶层 import 会在 bundle 加载期触发原生模块解析，链接失败即白屏；
 *    同时也会让纯逻辑测试无法在 Node 里跑（require('react-native') 会炸）。
 *  - 拿不到型号也要有可读兜底（"Android 设备"），
 *    不能回退成服务端默认的"未命名设备"——那正是要修的问题。
 */

export interface DeviceFacts {
  /** 设备型号，如 "Pixel 7" */
  model: string;
  /** 系统名，如 "Android" */
  osName: string;
  /** 系统版本，如 "14" */
  osVersion: string;
  /** 平台标识：android / ios / unknown */
  platform: string;
}

/** 上报给服务端的展示信息 */
export interface DeviceLabel {
  label: string;
  platform: string;
}

const MAX_LABEL_LEN = 64;

/**
 * 纯函数：把采集到的事实拼成展示文案
 *
 * 单独拆出来是为了能直接在 Node 里测试各种组合（含全部缺失的情况）。
 * 这个函数不碰任何原生模块。
 */
export function formatDeviceLabel(facts: DeviceFacts): string {
  const model = (facts.model ?? '').trim();
  const osName = (facts.osName ?? '').trim();
  const osVersion = (facts.osVersion ?? '').trim();

  let osPart = '';
  if (osName && osVersion) osPart = `${osName} ${osVersion}`;
  else if (osName) osPart = osName;
  else if (osVersion) osPart = `${facts.platform === 'ios' ? 'iOS' : 'Android'} ${osVersion}`;

  let text: string;
  if (model && osPart) text = `${model}（${osPart}）`;
  else if (model) text = model;
  else if (osPart) text = osPart;
  else text = facts.platform === 'ios' ? 'iOS 设备' : 'Android 设备';

  return text.slice(0, MAX_LABEL_LEN);
}

/** 延迟读取平台标识；取不到时给 'android'（本项目只构建 Android 包） */
function readPlatform(): string {
  try {
    const { Platform } = require('react-native') as { Platform?: { OS?: string } };
    const os = Platform?.OS;
    if (os === 'ios') return 'ios';
    if (os === 'android') return 'android';
  } catch {
    // 忽略：下面给兜底
  }
  return 'android';
}

/** 从 Platform.constants 兜底取型号（expo-device 不可用时的退路） */
function fallbackModel(): string {
  try {
    const { Platform } = require('react-native') as {
      Platform?: { constants?: Record<string, unknown> };
    };
    const constants = Platform?.constants;
    const candidate = constants?.Model ?? constants?.model;
    return typeof candidate === 'string' ? candidate : '';
  } catch {
    return '';
  }
}

let cached: DeviceLabel | null = null;

/** 采集设备信息（结果缓存，避免每次登录都走一遍原生调用） */
export function getDeviceLabel(): DeviceLabel {
  if (cached) return cached;

  const platform = readPlatform();

  let model = '';
  let osName = '';
  let osVersion = '';

  try {
    const Device = require('expo-device') as
      | { modelName?: string | null; osName?: string | null; osVersion?: string | null }
      | undefined;
    if (typeof Device?.modelName === 'string') model = Device.modelName;
    if (typeof Device?.osName === 'string') osName = Device.osName;
    if (typeof Device?.osVersion === 'string') osVersion = Device.osVersion;
  } catch {
    // expo-device 不可用：走下面的兜底，绝不让"上报设备信息"这件事失败
  }

  if (!model) model = fallbackModel();
  if (!osName) osName = platform === 'ios' ? 'iOS' : 'Android';

  cached = {
    label: formatDeviceLabel({ model, osName, osVersion, platform }),
    platform,
  };
  return cached;
}
