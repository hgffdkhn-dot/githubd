/**
 * 轻量动效
 *
 * 全部基于 RN 自带 Animated API，**不引入任何新依赖**。
 * 所有动画都开 useNativeDriver：在 UI 线程执行，不受 JS 卡顿影响。
 */

import React from 'react';
import { Animated, Pressable, type StyleProp, type ViewStyle } from 'react-native';

interface FadeInProps {
  children: React.ReactNode;
  /** 延迟入场（毫秒），用于列表逐项入场 */
  delay?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
}

/** 淡入 + 轻微上移，Material 的标准入场观感 */
export function FadeIn({ children, delay = 0, duration = 260, style }: FadeInProps) {
  const opacity = React.useRef(new Animated.Value(0)).current;
  const translateY = React.useRef(new Animated.Value(10)).current;

  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration, delay, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration, delay, useNativeDriver: true }),
    ]).start();
  }, [opacity, translateY, delay, duration]);

  return (
    <Animated.View style={[{ opacity, transform: [{ translateY }] }, style]}>
      {children}
    </Animated.View>
  );
}

interface PressableScaleProps {
  children: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  /** 按下的缩放比例 */
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
}

/** 按下缩放回弹：Android 原生列表的触感反馈 */
export function PressableScale({
  children,
  onPress,
  onLongPress,
  scaleTo = 0.97,
  style,
}: PressableScaleProps) {
  const scale = React.useRef(new Animated.Value(1)).current;

  const animateTo = (value: number) => {
    Animated.spring(scale, {
      toValue: value,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => animateTo(scaleTo)}
      onPressOut={() => animateTo(1)}
      // 水波纹是 Android 原生的按压反馈，与缩放叠加更像系统控件
      android_ripple={{ color: 'rgba(0,0,0,0.08)' }}
    >
      <Animated.View style={[{ transform: [{ scale }] }, style]}>{children}</Animated.View>
    </Pressable>
  );
}

interface ScaleOnFocusProps {
  focused: boolean;
  children: React.ReactNode;
}

/** 底部栏图标：选中时轻微放大，切换有过渡而不是硬跳 */
export function ScaleOnFocus({ focused, children }: ScaleOnFocusProps) {
  const scale = React.useRef(new Animated.Value(focused ? 1 : 0.9)).current;

  React.useEffect(() => {
    Animated.spring(scale, {
      toValue: focused ? 1 : 0.9,
      useNativeDriver: true,
      speed: 40,
      bounciness: 8,
    }).start();
  }, [focused, scale]);

  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}
