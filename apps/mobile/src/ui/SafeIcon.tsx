/**
 * 图标兜底组件
 *
 * 为什么需要：react-native-paper 各版本 `Icon` 的导出方式不一致，
 * 而图标渲染失败在 RN 里是**致命**的（"type is invalid"直接崩整棵树 → 白屏）。
 *
 * 这里从命名空间里按需取用，取不到就退化成占位方块，
 * 保证"图标显示不出来"最坏也只是少个图标，不会白屏。
 */

import React from 'react';
import { View } from 'react-native';
import * as Paper from 'react-native-paper';

type IconComponent = React.ComponentType<{
  source?: unknown;
  name?: string;
  size?: number;
  color?: string;
}>;

// 只认 Icon；IconButton 的 props 完全不同，混用只会渲染出一个空按钮
const IconImpl = (Paper as unknown as Record<string, unknown>).Icon as IconComponent | undefined;

export function SafeIcon({
  name,
  size = 24,
  color = '#000',
}: {
  name: string;
  size?: number;
  color?: string;
}) {
  if (!IconImpl) {
    return <View style={{ width: size, height: size }} />;
  }
  // 两种组件接受的 prop 名不同，都试一下
  return <IconImpl source={name} size={size} color={color} />;
}
