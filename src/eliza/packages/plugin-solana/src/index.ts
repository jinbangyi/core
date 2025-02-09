import {AgentRuntime, elizaLogger, IAgentRuntime, stringToUuid} from "@elizaos/core";

export * from "./providers/token.js";
export * from "./providers/wallet.js";
import type { Plugin } from "@elizaos/core";
import { TokenProvider } from "./providers/token.js";
import { WalletProvider } from "./providers/wallet.js";
import { getTokenBalance, getTokenBalances } from "./providers/tokenUtils.js";
import { walletProvider } from "./providers/wallet.js";
import { executeSwap } from "./actions/swap.js";
import {autoExecuteSwap, checkAutoSwapTask} from "./actions/autoSwap.js";
import pumpfun from "./actions/pumpfun.js";
import {airdrop} from "./actions/airdrop.js";
export { TokenProvider, WalletProvider, getTokenBalance, getTokenBalances };
export const solanaPlugin: Plugin = {
    name: "solana",
    description: "Solana Plugin for Eliza",
    actions: [
        executeSwap,
        pumpfun,
        autoExecuteSwap,
        airdrop,
    ],
    evaluators: [],
    providers: [walletProvider],
};
export default solanaPlugin;

export async function startAutoSwapTask(runtime: IAgentRuntime){
    (async () => {
        try {
            await checkAutoSwapTask(runtime);
        } catch (err) {
            elizaLogger.error("checkAutoSwapTask error", err);
        }
    })();
}