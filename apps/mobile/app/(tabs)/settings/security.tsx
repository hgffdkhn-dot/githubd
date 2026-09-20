/**
 * 安全设置
 *
 * 两项内容：
 *  1. 本地消息缓存 —— 决定聊天记录能否在重开应用后读回
 *  2. 代理 —— 用户自填地址，我们不提供任何节点
 */

import React, { useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import {
  Text,
  Surface,
  List,
  Divider,
  Button,
  Switch,
  TextInput,
  SegmentedButtons,
  Snackbar,
  useTheme,
} from 'react-native-paper';
import { useRouter } from 'expo-router';
import {
  loadPreviewsEnabled,
  setPreviewsEnabled,
  loadBurnAfterExit,
  setBurnAfterExit,
  loadProxy,
  saveProxy,
  clearProxy,
  validateProxy,
  type ProxyConfig,
  type ProxyProtocol,
  setPreviewsEnabledSync,
} from '../../../src/settings/security.js';
import { applyProxy as applyNativeProxy, clearProxy as clearNativeProxy, isProxySupported, currentProxy } from '../../../modules/e2ee-proxy/src/index.js';

const DEFAULT_PORT: Record<ProxyProtocol, string> = { http: '8080', socks5: '1080' };

export default function SecurityScreen() {
  const theme = useTheme();
  const router = useRouter();

  // ---- 本地消息缓存 / 阅后即焚 ----
  const [previews, setPreviews] = useState(true);
  const [burn, setBurn] = useState(false);

  // ---- 代理 ----
  const [proxySupported, setProxySupported] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [protocol, setProtocol] = useState<ProxyProtocol>('http');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(DEFAULT_PORT.http);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string>('');

  useEffect(() => {
    setProxySupported(isProxySupported());
    void loadPreviewsEnabled().then(setPreviews);
    void loadBurnAfterExit().then(setBurn);
    void loadProxy().then((c: ProxyConfig) => {
      setEnabled(c.enabled);
      setProtocol(c.protocol);
      setHost(c.host);
      setPort(c.port ? String(c.port) : DEFAULT_PORT[c.protocol]);
      setUsername(c.username ?? '');
      setPassword(c.password ?? '');
    });
    const active = currentProxy();
    setActiveLabel(active ? `${active.type} ${active.host}:${active.port}` : '');
  }, []);

  async function togglePreviews(value: boolean) {
    setPreviews(value);
    setPreviewsEnabledSync(value);
    await setPreviewsEnabled(value);
    setToast(value ? '已开启本地消息缓存' : '已关闭本地消息缓存，此后新消息不再缓存明文');
  }

  function switchProtocol(next: string) {
    const p: ProxyProtocol = next === 'socks5' ? 'socks5' : 'http';
    // 端口还停在另一个协议的默认值时，跟着切过去，避免用户填了协议却留着错端口
    if (port === DEFAULT_PORT[protocol]) setPort(DEFAULT_PORT[p]);
    setProtocol(p);
  }

  async function save() {
    const result = validateProxy({ protocol, host, port });
    if (!result.ok) {
      setToast(result.error);
      return;
    }
    setSaving(true);
    try {
      const config: ProxyConfig = {
        enabled,
        protocol: result.config.protocol,
        host: result.config.host,
        port: result.config.port,
        username: username.trim(),
        password,
      };
      await saveProxy(config);

      // 立即尝试装到进程上；已建好的连接不会变，需重启 App
      if (config.enabled) {
        const applied = applyNativeProxy(config.protocol, config.host, config.port);
        setToast(
          applied.applied
            ? '已保存并应用。已建立的连接不受影响，重启应用后完全生效。'
            : `已保存，但应用失败：${applied.reason ?? '未知原因'}`,
        );
      } else {
        clearNativeProxy();
        setToast('已关闭代理');
      }
      const active = currentProxy();
      setActiveLabel(active ? `${active.type} ${active.host}:${active.port}` : '');
    } catch (e) {
      setToast((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    await clearProxy();
    clearNativeProxy();
    setEnabled(false);
    setHost('');
    setPort(DEFAULT_PORT.http);
    setUsername('');
    setPassword('');
    setActiveLabel('');
    setToast('已清除代理配置');
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {/* ---------- 代理 ---------- */}
      <Surface style={styles.card} elevation={1}>
        <Text variant="titleSmall" style={styles.sectionTitle}>
          代理
        </Text>
        <Text variant="bodySmall" style={styles.hint}>
          我们不提供任何代理节点，请填入你自己的服务器信息。支持 HTTP 与 SOCKS5 两种通用协议。
        </Text>

        {!proxySupported ? (
          <Text variant="bodySmall" style={[styles.hint, { color: theme.colors.error }]}>
            当前构建未包含代理原生模块，配置可保存但不会生效。
          </Text>
        ) : null}

        <View style={styles.switchRow}>
          <Text variant="bodyMedium">启用代理</Text>
          <Switch value={enabled} onValueChange={setEnabled} />
        </View>

        <SegmentedButtons
          value={protocol}
          onValueChange={switchProtocol}
          buttons={[
            { value: 'http', label: 'HTTP' },
            { value: 'socks5', label: 'SOCKS5' },
          ]}
          style={styles.segmented}
        />

        <TextInput
          label="代理地址（主机名或 IP）"
          mode="outlined"
          value={host}
          onChangeText={setHost}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="127.0.0.1"
          style={styles.input}
        />
        <TextInput
          label="端口"
          mode="outlined"
          value={port}
          onChangeText={setPort}
          keyboardType="numeric"
          placeholder={DEFAULT_PORT[protocol]}
          style={styles.input}
        />
        <TextInput
          label="用户名（可选）"
          mode="outlined"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          dense
          style={styles.input}
        />
        <TextInput
          label="口令（可选）"
          mode="outlined"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          dense
          style={styles.input}
        />

        <Text variant="bodySmall" style={styles.hint}>
          注意：代理在应用启动时装载。保存后新连接会走代理，已建立的连接需重启应用才会切换。
          用户名与口令目前仅作保存，是否参与认证取决于你的代理服务端实现。
        </Text>

        <View style={styles.actions}>
          <Button mode="contained" onPress={save} loading={saving} disabled={saving}>
            保存并应用
          </Button>
          <Button mode="text" onPress={clear} disabled={saving}>
            清除
          </Button>
        </View>

        {activeLabel ? (
          <Text variant="bodySmall" style={styles.active}>
            当前已装载：{activeLabel}
          </Text>
        ) : null}
      </Surface>

      {/* ---------- 本地消息缓存 ---------- */}
      <Surface style={styles.card} elevation={1}>
        <Text variant="titleSmall" style={styles.sectionTitle}>
          本地消息缓存
        </Text>
        <Text variant="bodySmall" style={styles.hint}>
          消息密钥是一次性的，解密后即丢弃，事后再拿密文也解不出来。
          所以聊天记录能否在重开应用后读回，完全取决于这里是否缓存了明文。
        </Text>
        <Text variant="bodySmall" style={styles.hint}>
          缓存只写在本机数据库，服务端始终只经手密文，端到端加密强度不受影响。
          关闭后主界面不显示消息预览，重开应用后旧消息内容将显示为"未缓存"。
        </Text>
        <View style={styles.switchRow}>
          <Text variant="bodyMedium">缓存消息明文</Text>
          <Switch value={previews} onValueChange={(v) => void togglePreviews(v)} />
        </View>
      </Surface>

      {/* ---------- 阅后即焚 ---------- */}
      <Surface style={styles.card} elevation={1}>
        <Text variant="titleSmall" style={styles.sectionTitle}>
          阅后即焚
        </Text>
        <Text variant="bodySmall" style={styles.hint}>
          默认关闭：聊天记录会一直留在本机，重开应用仍可查看。
          开启后，每次退出应用都会销毁本地聊天记录，下次打开是空的。
        </Text>
        <Text variant="bodySmall" style={styles.hint}>
          注意：销毁只发生在本机。对方设备上已收到的消息不受影响。
        </Text>
        <View style={styles.switchRow}>
          <Text variant="bodyMedium">退出应用即销毁聊天记录</Text>
          <Switch
            value={burn}
            onValueChange={(v) => {
              setBurn(v);
              void setBurnAfterExit(v).then(() =>
                setToast(v ? '已开启阅后即焚，下次启动将清空本地聊天记录' : '已关闭阅后即焚'),
              );
            }}
          />
        </View>
      </Surface>

      <Surface style={styles.card} elevation={1}>
        <List.Item
          title="设备管理"
          description="查看近期登录的设备"
          left={(p) => <List.Icon {...p} icon="devices" />}
          right={(p) => <List.Icon {...p} icon="chevron-right" />}
          onPress={() => router.push('/settings/privacy')}
        />
      </Surface>

      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={3200}>
        {toast ?? ''}
      </Snackbar>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { padding: 14, borderRadius: 16 },
  sectionTitle: { marginBottom: 6 },
  hint: { opacity: 0.7, lineHeight: 19, marginBottom: 10 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  segmented: { marginBottom: 10 },
  input: { marginBottom: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  active: { marginTop: 8, opacity: 0.75, fontFamily: 'monospace' },
});
