/**
 * Wagmi 配置文件
 * 
 * 此文件负责配置 Wagmi（React Hooks for Ethereum）库，用于 Web3 连接管理。
 * 主要功能包括：
 * - 配置多个钱包连接器（Binance、WalletConnect、Coinbase 等）
 * - 设置 RPC 传输层的 fallback 机制
 * - 处理不同环境下的配置（测试、生产、Playwright）
 */

import { getWagmiConnectorV2 } from '@binance/w3w-wagmi-connector-v2'
import { PLAYWRIGHT_CONNECT_ADDRESS } from 'components/Web3Provider/constants'
import { WC_PARAMS } from 'components/Web3Provider/walletConnect'
import { embeddedWallet } from 'connection/EmbeddedWalletConnector'
import { porto } from 'porto/wagmi'
import { UNISWAP_LOGO } from 'ui/src/assets'
import { UNISWAP_WEB_URL } from 'uniswap/src/constants/urls'
import { getChainInfo, ORDERED_EVM_CHAINS } from 'uniswap/src/features/chains/chainInfo'
import { isTestnetChain } from 'uniswap/src/features/chains/utils'
import { isPlaywrightEnv, isTestEnv } from 'utilities/src/environment/env'
import { logger } from 'utilities/src/logger/logger'
import { getNonEmptyArrayOrThrow } from 'utilities/src/primitives/array'
import { Chain, createClient } from 'viem'
import { Config, createConfig, fallback, http } from 'wagmi'
import { coinbaseWallet, mock, safe, walletConnect } from 'wagmi/connectors'

/** 币安钱包连接器实例 */
const BinanceConnector = getWagmiConnectorV2()

/**
 * 获取有序的 RPC 传输 URL 列表
 * 
 * 此函数按优先级顺序返回链的 RPC URL：
 * 1. interface（接口 RPC）- 最高优先级，通常是 Uniswap 自己的节点
 * 2. default（默认 RPC）
 * 3. public（公共 RPC）
 * 4. fallback（备用 RPC）- 最低优先级
 * 
 * 使用 Set 去重，确保不会有重复的 URL。
 * 
 * @param chain - 链信息对象，包含各种 RPC URL 配置
 * @returns 去重后的有序 RPC URL 数组
 */
export const orderedTransportUrls = (chain: ReturnType<typeof getChainInfo>): string[] => {
  const orderedRpcUrls = [
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    ...(chain.rpcUrls.interface?.http ?? []),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    ...(chain.rpcUrls.default?.http ?? []),
    ...(chain.rpcUrls.public?.http ?? []),
    ...(chain.rpcUrls.fallback?.http ?? []),
  ]

  // 过滤空值并去重
  return Array.from(new Set(orderedRpcUrls.filter(Boolean)))
}

/**
 * 创建 Wagmi 钱包连接器数组
 * 
 * 此函数根据环境配置创建并返回所有可用的钱包连接器。
 * 支持的连接器包括：
 * - Porto 钱包
 * - 币安钱包（Binance Web3 Wallet）
 * - WalletConnect（除了单元测试环境外）
 * - 内嵌钱包
 * - Coinbase 钱包
 * - Safe（多签钱包）
 * - Mock 连接器（仅在 Playwright 测试环境）
 * 
 * @param params - 配置参数
 * @param params.includeMockConnector - 如果为 true，会添加 mock 连接器用于 Playwright 测试
 * @returns 钱包连接器数组
 */
function createWagmiConnectors(params: {
  /** 如果为 `true`，会追加 wagmi `mock` 连接器，用于 Playwright 测试 */
  includeMockConnector: boolean
}): any[] {
  const { includeMockConnector } = params

  const baseConnectors = [
    // Porto 钱包连接器
    porto(),
    // 币安钱包连接器，启用二维码模态框
    // 注意：在单元测试中不包含 WalletConnect 以减少日志噪音
    BinanceConnector({
      showQrCodeModal: true,
    }),
    // WalletConnect 连接器
    // 在普通测试环境中排除，但在 Playwright 环境和生产环境中包含
    ...(isTestEnv() && !isPlaywrightEnv() ? [] : [walletConnect(WC_PARAMS)]),
    // 内嵌钱包连接器
    embeddedWallet(),
    // Coinbase 钱包连接器
    coinbaseWallet({
      appName: 'Uniswap',
      // CB SDK 不会将父级来源上下文传递给其 passkey 站点
      // 已向 CB 团队反馈，修复后可移除 UNISWAP_WEB_URL
      appLogoUrl: `${UNISWAP_WEB_URL}${UNISWAP_LOGO}`,
      reloadOnDisconnect: false,
    }),
    // Safe 多签钱包连接器
    safe(),
  ]

  // 如果需要，添加 mock 连接器用于 Playwright 测试
  return includeMockConnector
    ? [
        ...baseConnectors,
        mock({
          features: {},
          accounts: [PLAYWRIGHT_CONNECT_ADDRESS],
        }),
      ]
    : baseConnectors
}

/**
 * 创建 Wagmi 配置对象
 * 
 * 此函数创建完整的 Wagmi 配置，包括：
 * - 支持的区块链列表
 * - 钱包连接器
 * - 每条链的客户端配置（RPC、批处理、轮询等）
 * 
 * 客户端配置特性：
 * - 启用 multicall 批处理，提高查询效率
 * - 12 秒的轮询间隔
 * - 使用 fallback 传输，按优先级顺序尝试多个 RPC 节点
 * 
 * @param params - 配置参数
 * @param params.connectors - 要使用的钱包连接器列表
 * @param params.onFetchResponse - 可选的自定义响应处理器，默认为 defaultOnFetchResponse
 * @returns Wagmi 配置对象
 */
function createWagmiConfig(params: {
  /** 要使用的连接器列表 */
  connectors: any[]
  /** 可选的自定义 `onFetchResponse` 处理器 - 默认为 `defaultOnFetchResponse` */
  onFetchResponse?: (response: Response, chain: Chain, url: string) => void
}): Config<typeof ORDERED_EVM_CHAINS> {
  const { connectors, onFetchResponse = defaultOnFetchResponse } = params

  return createConfig({
    // 获取所有支持的 EVM 链
    chains: getNonEmptyArrayOrThrow(ORDERED_EVM_CHAINS),
    connectors,
    // 为每条链创建独立的客户端
    client({ chain }) {
      return createClient({
        chain,
        // 启用 multicall 批处理，可以在单个请求中执行多个合约调用
        batch: { multicall: true },
        // 轮询间隔设置为 12 秒（即每 12 秒检查一次新数据）
        pollingInterval: 12_000,
        // 配置传输层：使用 fallback 机制，依次尝试多个 RPC URL
        transport: fallback(
          orderedTransportUrls(chain).map((url) =>
            http(url, { onFetchResponse: (response) => onFetchResponse(response, chain, url) }),
          ),
        ),
      })
    },
  })
}

/**
 * 默认的 RPC 响应处理器
 * 
 * 此函数在每次 RPC 请求完成后被调用，用于监控和记录 RPC 节点的健康状况。
 * 
 * 行为说明：
 * - 如果响应状态码为 200，不做任何处理
 * - 如果响应状态码非 200：
 *   - 对于测试网：记录警告日志
 *   - 对于主网：记录错误日志（因为主网 RPC 问题需要优先修复）
 * 
 * @param response - Fetch API 的响应对象
 * @param chain - 当前请求的区块链
 * @param url - 使用的 RPC URL
 */
// eslint-disable-next-line max-params
const defaultOnFetchResponse = (response: Response, chain: Chain, url: string) => {
  if (response.status !== 200) {
    const message = `RPC provider returned non-200 status: ${response.status}`

    // 对于测试网链，只记录警告
    if (isTestnetChain(chain.id)) {
      logger.warn('wagmiConfig.ts', 'client', message, {
        extra: {
          chainId: chain.id,
          url,
        },
      })
    } else {
      // 对于主网链，记录错误以便我们修复
      logger.error(new Error(message), {
        extra: {
          chainId: chain.id,
          url,
        },
        tags: {
          file: 'wagmiConfig.ts',
          function: 'client',
        },
      })
    }
  }
}

/**
 * 默认的钱包连接器列表
 * 
 * 根据当前环境自动配置：
 * - Playwright 测试环境：包含 mock 连接器
 * - 其他环境：只包含真实的钱包连接器
 */
const defaultConnectors = createWagmiConnectors({
  includeMockConnector: isPlaywrightEnv(),
})

/**
 * Wagmi 配置实例
 * 
 * 这是整个应用使用的主要 Wagmi 配置。
 * 包含所有支持的链、钱包连接器和 RPC 配置。
 * 
 * 使用方式：
 * - 通过 WagmiProvider 包裹应用根组件
 * - 在组件中使用 wagmi hooks（如 useAccount、useBalance 等）
 */
export const wagmiConfig = createWagmiConfig({ connectors: defaultConnectors })

/**
 * TypeScript 模块声明增强
 * 
 * 将 wagmiConfig 类型注册到 wagmi 模块中，
 * 使得所有 wagmi hooks 都能获得正确的类型推断。
 */
declare module 'wagmi' {
  interface Register {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    config: typeof wagmiConfig
  }
}
