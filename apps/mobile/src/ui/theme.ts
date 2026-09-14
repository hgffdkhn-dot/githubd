/**
 * Material Design 3 主题
 *
 * 用 react-native-paper 提供 Android 原生观感：
 * 按钮、输入框、Appbar、FAB、分隔线都遵循 Material You 规范。
 */

import { MD3LightTheme, MD3DarkTheme, type MD3Theme } from 'react-native-paper';

const brand = {
  primary: 'rgb(103, 80, 164)',
  onPrimary: 'rgb(255, 255, 255)',
  primaryContainer: 'rgb(234, 221, 255)',
  secondary: 'rgb(98, 91, 113)',
  tertiary: 'rgb(125, 82, 96)',
};

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: { ...MD3LightTheme.colors, ...brand },
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: { ...MD3DarkTheme.colors, ...brand },
};
