import React from 'react';
import { View, StyleSheet, ScrollView, Pressable } from 'react-native';
import { Text, Surface, Switch, useTheme } from 'react-native-paper';
import {
  COLOR_PRESETS,
  getSettings,
  subscribeSettings,
  updateSettings,
  buildTheme,
} from '../../../src/settings/appearance.js';

export default function AppearanceSettingsScreen() {
  const theme = useTheme();
  // 订阅全局设置：改色后整个 App 立即重建主题
  const [state, setState] = React.useState(() => getSettings());

  React.useEffect(() => subscribeSettings(setState), []);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Surface style={styles.card} elevation={1}>
        <Text variant="titleSmall" style={styles.sectionTitle}>
          主题色
        </Text>
        <View style={styles.swatches}>
          {COLOR_PRESETS.map((c) => {
            const selected = state.colorId === c.id;
            return (
              <Pressable
                key={c.id}
                style={styles.swatchWrap}
                onPress={() => void updateSettings({ colorId: c.id })}
              >
                <View
                  style={[
                    styles.swatch,
                    {
                      backgroundColor: c.seed,
                      borderWidth: selected ? 3 : 0,
                      borderColor: theme.colors.onSurface,
                    },
                  ]}
                />
                <Text variant="bodySmall" style={styles.swatchLabel}>
                  {c.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Surface>

      <Surface style={styles.card} elevation={1}>
        <View style={styles.row}>
          <Text variant="bodyMedium" style={styles.rowText}>
            深色模式
          </Text>
          <Switch
            value={state.darkMode}
            onValueChange={(v) => void updateSettings({ darkMode: v })}
          />
        </View>
      </Surface>

      <Surface style={styles.preview} elevation={1}>
        <Text variant="titleSmall" style={styles.sectionTitle}>
          预览
        </Text>
        <View
          style={[styles.previewBar, { backgroundColor: buildTheme(state).colors.primary }]}
        >
          <Text style={styles.previewBarText}>标题栏</Text>
        </View>
        <View style={styles.bubbleRow}>
          <View
            style={[
              styles.bubble,
              { backgroundColor: buildTheme(state).colors.surfaceVariant },
            ]}
          >
            <Text>对方的消息</Text>
          </View>
          <View
            style={[
              styles.bubble,
              { backgroundColor: buildTheme(state).colors.primaryContainer, alignSelf: 'flex-end' },
            ]}
          >
            <Text>我的消息</Text>
          </View>
        </View>
      </Surface>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { padding: 16, borderRadius: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowText: { flex: 1 },
  sectionTitle: { marginBottom: 12 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  swatchWrap: { alignItems: 'center', width: 64 },
  swatch: { width: 44, height: 44, borderRadius: 22 },
  swatchLabel: { marginTop: 6, fontSize: 11 },
  preview: { padding: 16, borderRadius: 16 },
  previewBar: { borderRadius: 8, padding: 12, alignItems: 'center', marginBottom: 12 },
  previewBarText: { color: '#fff', fontWeight: '700' },
  bubbleRow: { gap: 8 },
  bubble: { padding: 10, borderRadius: 14, alignSelf: 'flex-start' },
});
