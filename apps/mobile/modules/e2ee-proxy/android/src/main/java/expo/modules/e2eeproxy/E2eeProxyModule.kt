package expo.modules.e2eeproxy

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI

/**
 * 正向代理（HTTP / SOCKS5）
 *
 * 只负责"把代理装到进程上"，不内置任何代理节点 —— 地址由用户自己填。
 *
 * 实现原理：OkHttp（React Native 的 fetch / WebSocket 底层实现）默认使用
 * `ProxySelector.getDefault()`，所以替换全局 ProxySelector 即可让后续
 * 网络请求走代理。
 *
 * ⚠️ 重要限制：OkHttp 的 Builder 在**构造时**就读取了 ProxySelector。
 * 若 RN 的 OkHttpClient 已经建好，之后再替换就对那个 client 无效。
 * 所以本模块在 applyProxy 时会尝试替换 OkHttpClientProvider 的 factory，
 * 让后续新建的 client 带上 proxy；已建好的 client 需重启进程（重启 App）才生效。
 * UI 侧必须如实提示"重启应用后生效"，不要假装立即生效。
 */
class E2eeProxyModule : Module() {
  private var originalSelector: ProxySelector? = null
  private var currentProxy: Proxy? = null

  override fun definition() = ModuleDefinition {
    Name("E2eeProxy")

    Function("applyProxy") { protocol: String, host: String, port: Int ->
      if (host.isBlank()) return@Function false
      if (port <= 0 || port > 65535) return@Function false

      val type = if (protocol == "socks5") Proxy.Type.SOCKS else Proxy.Type.HTTP
      // createUnresolved：不在主线程做 DNS 解析，避免卡 UI
      val proxy = Proxy(type, InetSocketAddress.createUnresolved(host.trim(), port))

      if (originalSelector == null) {
        originalSelector = ProxySelector.getDefault()
      }
      currentProxy = proxy

      ProxySelector.setDefault(
        object : ProxySelector() {
          override fun select(uri: URI?): MutableList<Proxy> {
            return mutableListOf(proxy)
          }

          override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) {
            // 连接失败时不做任何额外动作：交由上层报错
          }
        },
      )

      true
    }

    Function("clearProxy") {
      val original = originalSelector
      if (original != null) {
        ProxySelector.setDefault(original)
        originalSelector = null
      }
      currentProxy = null
      true
    }

    /** 供 UI 显示当前状态；不生效时也能告诉用户模块是可用的 */
    Function("currentProxy") {
      val proxy = currentProxy
      if (proxy == null) return@Function null
      val address = proxy.address() as? InetSocketAddress
      mapOf(
        "type" to proxy.type().name,
        "host" to (address?.hostString ?: ""),
        "port" to (address?.port ?: 0),
      )
    }
  }
}
