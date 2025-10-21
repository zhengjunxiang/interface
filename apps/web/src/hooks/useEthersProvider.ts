/**
 * Ethers Provider 适配器
 * 
 * 该文件提供了将 viem Client 转换为 ethers.js Provider 的适配器功能。
 * 由于应用程序使用 要的 Web3 客户wagmi/viem 作为主端，但某些库或遗留代码
 * 仍然需要 ethers.js Provider，因此需要这个转换层。
 */

import { Web3Provider } from '@ethersproject/providers'
import { useAccount } from 'hooks/useAccount'
import { useMemo } from 'react'
import type { Chain, Client, Transport } from 'viem'
import { useClient, useConnectorClient } from 'wagmi'

/**
 * Provider 缓存
 * 使用 WeakMap 缓存已创建的 Provider 实例，避免为同一个 Client 重复创建 Provider。
 * WeakMap 的优势是当 Client 被垃圾回收时，对应的 Provider 也会自动被清理，避免内存泄漏。
 */
const providers = new WeakMap<Client, Web3Provider>()

/**
 * 将 viem Client 转换为 ethers.js Provider
 * 
 * @param client - viem Client 实例，包含 transport 和 chain 信息
 * @param chainId - 可选的链 ID，当 client 没有提供 chain 信息时使用
 * @returns ethers.js Web3Provider 实例，如果无法创建则返回 undefined
 * 
 * 该函数会：
 * 1. 从 client 中提取 chain 和 transport 信息
 * 2. 构建 ethers.js 需要的 network 对象（包含 chainId、name 和 ensAddress）
 * 3. 检查缓存，如果已经为该 client 创建过 provider，直接返回缓存的实例
 * 4. 否则创建新的 Web3Provider 实例并缓存
 */
export function clientToProvider(client?: Client<Transport, Chain>, chainId?: number) {
  if (!client) {
    return undefined
  }
  const { chain, transport } = client

  // 获取 ENS 注册表地址（如果该链支持 ENS）
  const ensAddress = chain.contracts?.ensRegistry?.address
  
  // 构建 ethers.js 的 network 对象
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const network = chain
    ? {
        chainId: chain.id,
        name: chain.name,
        ensAddress,
      }
    : chainId
      ? { chainId, name: 'Unsupported' }
      : undefined
  if (!network) {
    return undefined
  }

  // 检查缓存，避免重复创建 provider
  if (providers.has(client)) {
    return providers.get(client)
  } else {
    // 创建新的 Web3Provider 并缓存
    const provider = new Web3Provider(transport, network)
    providers.set(client, provider)
    return provider
  }
}

/**
 * 获取 ethers.js Provider（带断开连接的网络回退）
 * 
 * @param options - 配置选项
 * @param options.chainId - 目标链 ID，如果不提供则使用当前连接的链
 * @returns ethers.js Web3Provider 实例
 * 
 * 该 Hook 的特点：
 * 1. 优先使用已连接的 client（用户已连接钱包）
 * 2. 如果用户未连接或请求的链与当前连接的链不同，则回退到断开连接的 client
 * 3. 断开连接的 client 可以进行只读操作（如查询余额、读取合约状态等）
 * 4. 使用 useMemo 优化性能，只在依赖项变化时重新创建 provider
 * 
 * 使用场景：
 * - 需要同时支持已连接和未连接状态的组件
 * - 需要在不同链上进行只读查询的场景
 */
export function useEthersProvider({ chainId }: { chainId?: number } = {}) {
  const account = useAccount()
  const { data: client } = useConnectorClient({ chainId })
  const disconnectedClient = useClient({ chainId })
  return useMemo(
    () => clientToProvider(account.chainId !== chainId ? disconnectedClient : (client ?? disconnectedClient), chainId),
    [account.chainId, chainId, client, disconnectedClient],
  )
}

/**
 * 获取已连接的 ethers.js Provider（仅支持已连接钱包的操作）
 * 
 * @param options - 配置选项
 * @param options.chainId - 目标链 ID，如果不提供则使用当前连接的链
 * @returns ethers.js Web3Provider 实例，如果钱包未连接则返回 undefined
 * 
 * 该 Hook 的特点：
 * 1. 仅使用已连接的 client（用户必须已连接钱包）
 * 2. 如果钱包未连接，返回 undefined
 * 3. 支持需要签名的操作（如发送交易、签名消息等）
 * 4. 使用 useMemo 优化性能，只在依赖项变化时重新创建 provider
 * 
 * 使用场景：
 * - 需要用户签名或发送交易的操作
 * - 必须确保钱包已连接的场景
 * - 不需要只读回退功能的组件
 * 
 * 对比 useEthersProvider：
 * - useEthersProvider: 有只读回退，总是返回可用的 provider
 * - useEthersWeb3Provider: 仅在钱包连接时返回 provider，否则返回 undefined
 */
export function useEthersWeb3Provider({ chainId }: { chainId?: number } = {}) {
  const { data: client } = useConnectorClient({ chainId })
  return useMemo(() => clientToProvider(client, chainId), [chainId, client])
}
