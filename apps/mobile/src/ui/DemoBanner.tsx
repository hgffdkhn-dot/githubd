/**
 * 演示模式横幅
 *
 * 醒目提示当前不是真实加密会话，避免误判。
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Button } from 'react-native-paper';

interface Props {
  onExit: () => void;
}

export function DemoBanner({ onExit }: Props) {
  return (
    <View style={styles.bar}>
      <Text style={styles.text}>演示模式 · 不加密 · 不联网</Text>
      <Button compact mode="text" textColor="#fff" onPress={onExit}>
        退出
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: '#b3261e',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  text: { color: '#fff', fontSize: 12, fontWeight: '700', flex: 1 },
});
