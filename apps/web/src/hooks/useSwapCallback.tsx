/**
 * Swap 回调 Hook
 *
 * 该文件提供了执行代币交换的核心功能，支持两种交换类型：
 * 1. UniswapX 交换 - 链下订单执行
 * 2. Universal Router 交换 - 经典的链上交换
 *
 * 主要功能：
 * - 处理交换前的验证（连接状态、链ID匹配等）
 * - 根据交易类型选择合适的交换回调
 * - 处理交换后的交易/订单记录
 * - 提供交易状态查询功能
 */

import { BigNumber } from '@ethersproject/bignumber'
import type { Percent } from '@uniswap/sdk-core'
import { TradeType } from '@uniswap/sdk-core'
import type { FlatFeeOptions } from '@uniswap/universal-router-sdk'
import type { FeeOptions } from '@uniswap/v3-sdk'
import { useAccount } from 'hooks/useAccount'
import type { PermitSignature } from 'hooks/usePermitAllowance'
import useSelectChain from 'hooks/useSelectChain'
import { useUniswapXSwapCallback } from 'hooks/useUniswapXSwapCallback'
import { useUniversalRouterSwapCallback } from 'hooks/useUniversalRouter'
import { useCallback } from 'react'
import { useMultichainContext } from 'state/multichain/useMultichainContext'
import type { InterfaceTrade } from 'state/routing/types'
import { OffchainOrderType, TradeFillType } from 'state/routing/types'
import { isClassicTrade, isUniswapXTrade } from 'state/routing/utils'
import { useAddOrder } from 'state/signatures/hooks'
import type { UniswapXOrderDetails } from 'state/signatures/types'
import { useTransaction, useTransactionAdder } from 'state/transactions/hooks'
import type { TransactionInfo } from 'state/transactions/types'
import { useSupportedChainId } from 'uniswap/src/features/chains/hooks/useSupportedChainId'
import { UniverseChainId } from 'uniswap/src/features/chains/types'
import { isEVMChain } from 'uniswap/src/features/platforms/utils/chains'
import { TransactionStatus, TransactionType } from 'uniswap/src/features/transactions/types/transactionDetails'
import { currencyId } from 'uniswap/src/utils/currencyId'

/**
 * Swap 执行结果类型
 * 包含交易哈希、订单哈希等执行结果信息
 */
export type SwapResult = Awaited<ReturnType<ReturnType<typeof useSwapCallback>>>

/**
 * Universal Router 手续费字段联合类型
 * - feeOptions: 用于按百分比收费（通常用于精确输入交易）
 * - flatFeeOptions: 用于固定金额收费（通常用于精确输出交易）
 */
type UniversalRouterFeeField = { feeOptions: FeeOptions } | { flatFeeOptions: FlatFeeOptions }

/**
 * 根据交易类型获取 Universal Router 的手续费配置字段
 *
 * @param trade - 接口交易对象
 * @returns 手续费配置对象，如果不适用则返回 undefined
 *
 * 逻辑说明：
 * - 仅适用于经典交易（非 UniswapX 交易）
 * - 必须存在 swapFee 配置
 * - EXACT_INPUT 类型：使用百分比手续费
 * - EXACT_OUTPUT 类型：使用固定金额手续费
 */
function getUniversalRouterFeeFields(trade?: InterfaceTrade): UniversalRouterFeeField | undefined {
  // 检查是否为经典交易
  if (!isClassicTrade(trade)) {
    return undefined
  }
  // 检查是否存在交换手续费
  if (!trade.swapFee) {
    return undefined
  }

  // 根据交易类型返回不同的手续费配置
  if (trade.tradeType === TradeType.EXACT_INPUT) {
    // 精确输入：使用百分比手续费
    return { feeOptions: { fee: trade.swapFee.percent, recipient: trade.swapFee.recipient } }
  } else {
    // 精确输出：使用固定金额手续费
    return { flatFeeOptions: { amount: BigNumber.from(trade.swapFee.amount), recipient: trade.swapFee.recipient } }
  }
}

/**
 * Swap 回调 Hook
 *
 * 返回一个执行代币交换的回调函数。该函数会在参数验证通过后执行交换。
 * 支持两种交换方式：
 * - UniswapX: 链下订单匹配，通常提供更优价格
 * - Universal Router: 传统的链上交换路由
 *
 * @param params - Hook 参数对象
 * @param params.trade - 要执行的交易对象
 * @param params.fiatValues - 法币价值信息（用于分析日志）
 *   - amountIn: 输入金额的美元价值
 *   - amountOut: 输出金额的美元价值
 *   - feeUsd: 手续费的美元价值
 * @param params.allowedSlippage - 允许的滑点百分比（以基点为单位）
 * @param params.permitSignature - 可选的授权签名，用于无需 approve 的交易
 *
 * @returns 异步回调函数，执行交换并返回结果
 */
export function useSwapCallback({
  trade,
  fiatValues,
  allowedSlippage,
  permitSignature,
}: {
  trade?: InterfaceTrade
  fiatValues: { amountIn?: number; amountOut?: number; feeUsd?: number }
  allowedSlippage: Percent
  permitSignature?: PermitSignature
}) {
  // 状态管理 Hooks
  const addTransaction = useTransactionAdder() // 添加交易到状态
  const addOrder = useAddOrder() // 添加订单到状态
  const account = useAccount() // 获取账户信息
  const supportedConnectedChainId = useSupportedChainId(account.chainId) // 获取支持的链ID
  const { chainId: swapChainId } = useMultichainContext() // 获取交换目标链ID

  // UniswapX 交换回调（链下订单）
  const uniswapXSwapCallback = useUniswapXSwapCallback({
    trade: isUniswapXTrade(trade) ? trade : undefined,
    allowedSlippage,
    fiatValues,
  })

  // Universal Router 交换回调（链上交换）
  const universalRouterSwapCallback = useUniversalRouterSwapCallback({
    trade: isClassicTrade(trade) ? trade : undefined,
    fiatValues,
    options: {
      slippageTolerance: allowedSlippage,
      permit: permitSignature,
      ...getUniversalRouterFeeFields(trade),
    },
  })

  // 链切换 Hook
  const selectChain = useSelectChain()
  // 根据交易类型选择对应的回调函数
  const swapCallback = isUniswapXTrade(trade) ? uniswapXSwapCallback : universalRouterSwapCallback

  return useCallback(async () => {
    // === 参数验证阶段 ===

    // 验证交易对象存在
    if (!trade) {
      throw new Error('missing trade')
    } else if (!account.isConnected || !account.address) {
      // 验证钱包已连接
      throw new Error('wallet must be connected to swap')
    } else if (!swapChainId) {
      // 验证交换链ID存在
      throw new Error('missing swap chainId')
    } else if (!isEVMChain(swapChainId)) {
      // 验证是EVM兼容链
      throw new Error('non EVM chain in legacy limits flow')
    } else if (!supportedConnectedChainId || supportedConnectedChainId !== swapChainId) {
      // 验证钱包连接到正确的链，如果不是则尝试切换
      const correctChain = await selectChain(swapChainId)
      if (!correctChain) {
        throw new Error('wallet must be connected to correct chain to swap')
      }
    }

    // === 执行交换 ===
    const result = await swapCallback()

    // === 构建交易信息对象 ===
    const swapInfo: TransactionInfo = {
      type: TransactionType.Swap,
      inputCurrencyId: currencyId(trade.inputAmount.currency), // 输入代币ID
      outputCurrencyId: currencyId(trade.outputAmount.currency), // 输出代币ID
      isUniswapXOrder: result.type === TradeFillType.UniswapX || result.type === TradeFillType.UniswapXv2, // 是否为UniswapX订单
      // 根据交易类型添加不同的字段
      ...(trade.tradeType === TradeType.EXACT_INPUT
        ? {
            // 精确输入模式：固定输入金额，输出金额可能变化
            tradeType: TradeType.EXACT_INPUT,
            inputCurrencyAmountRaw: trade.inputAmount.quotient.toString(), // 输入金额（精确值）
            expectedOutputCurrencyAmountRaw: trade.outputAmount.quotient.toString(), // 预期输出金额
            minimumOutputCurrencyAmountRaw: trade.minimumAmountOut(allowedSlippage).quotient.toString(), // 最小输出金额（考虑滑点）
          }
        : {
            // 精确输出模式：固定输出金额，输入金额可能变化
            tradeType: TradeType.EXACT_OUTPUT,
            maximumInputCurrencyAmountRaw: trade.maximumAmountIn(allowedSlippage).quotient.toString(), // 最大输入金额（考虑滑点）
            outputCurrencyAmountRaw: trade.outputAmount.quotient.toString(), // 输出金额（精确值）
            expectedInputCurrencyAmountRaw: trade.inputAmount.quotient.toString(), // 预期输入金额
          }),
    }

    // === 根据结果类型处理交易/订单 ===
    switch (result.type) {
      case TradeFillType.UniswapX:
      case TradeFillType.UniswapXv2:
        // UniswapX 订单：添加到订单状态管理
        addOrder({
          offerer: account.address, // 订单发起者地址
          orderHash: result.response.orderHash, // 订单哈希
          chainId: supportedConnectedChainId as UniverseChainId, // 链ID（已在上面验证并切换）
          expiry: result.response.deadline, // 订单过期时间
          swapInfo: swapInfo as UniswapXOrderDetails['swapInfo'], // 交换详情
          encodedOrder: result.response.encodedOrder, // 编码后的订单数据
          offchainOrderType: isUniswapXTrade(trade) ? trade.offchainOrderType : OffchainOrderType.DUTCH_AUCTION, // 链下订单类型
        })
        break
      default:
        // 经典交易：添加到交易状态管理
        addTransaction(result.response, swapInfo, result.deadline?.toNumber())
    }

    return result
  }, [
    // === 依赖项列表 ===
    account.address,
    account.isConnected,
    addOrder,
    addTransaction,
    allowedSlippage,
    selectChain,
    supportedConnectedChainId,
    swapCallback,
    swapChainId,
    trade,
  ])
}

/**
 * 获取 Swap 交易状态的 Hook
 *
 * 根据交换结果查询对应交易的当前状态。
 * 注意：此 Hook 仅适用于经典交易（Classic），不适用于 UniswapX 订单。
 *
 * @param swapResult - 交换执行结果，可能为 undefined
 * @returns 交易状态（pending/confirmed/failed等），如果不是经典交易或交易不存在则返回 undefined
 *
 * 使用场景：
 * - 在交换后监控交易确认状态
 * - 显示交易进度UI
 * - 等待交易完成后执行后续操作
 */
export function useSwapTransactionStatus(swapResult: SwapResult | undefined): TransactionStatus | undefined {
  // 仅查询经典交易的状态，UniswapX订单使用不同的状态管理
  const transaction = useTransaction(swapResult?.type === TradeFillType.Classic ? swapResult.response.hash : undefined)

  // 如果交易不存在则返回 undefined
  if (!transaction) {
    return undefined
  }
  
  // 返回交易状态
  return transaction.status
}
