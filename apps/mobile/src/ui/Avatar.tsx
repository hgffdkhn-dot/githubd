/**
 * 头像
 *
 * 本地由昵称首字 + 稳定底色生成，不上传图片。
 * 不引入相册上传是为了避免新增"服务端存图片"这个隐私面。
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface Props {
  label: string;
  color: string;
  size?: number;
  /** 右下角在线小圆点 */
  online?: boolean;
}

export function Avatar({ label, color, size = 40, online }: Props) {
  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <View style={[styles.circle, { backgroundColor: color, width: size, height: size }]}>
        <Text style={[styles.text, { fontSize: size * 0.42 }]} numberOfLines={1}>
          {label || '?'}
        </Text>
      </View>
      {online ? (
        <View
          style={[
            styles.dot,
            {
              width: size * 0.28,
              height: size * 0.28,
              borderRadius: size * 0.14,
              borderWidth: Math.max(1.5, size * 0.04),
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  circle: { borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  text: { color: '#fff', fontWeight: '700' },
  dot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    backgroundColor: '#2e7d32',
    borderColor: '#fff',
  },
});
