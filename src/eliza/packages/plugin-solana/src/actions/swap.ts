import {
    type ActionExample,
    composeContext,
    generateObjectDeprecated,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    settings,
    type State,
    type Action,
    elizaLogger,
} from "@elizaos/core";
import { Connection, PublicKey, RpcResponseAndContext, SignatureStatus, VersionedTransaction } from "@solana/web3.js";
import {BigNumber} from "bignumber.js";
import { getWalletKey } from "../keypairUtils.js";
import { isAgentAdmin, NotAgentAdminMessage, walletProvider, WalletProvider } from '../providers/wallet.js';
import { convertNullStrings, getTokenDecimals } from './swapUtils.js';
import {
    getOrCreateAssociatedTokenAccount, NATIVE_MINT,
    TOKEN_2022_PROGRAM_ID
  } from "@solana/spl-token";
import { SolanaClient } from "./solana-client.js";
import { getTokensBySymbol } from '../providers/tokenUtils.js';
import { getRuntimeKey } from '../environment.js';

const DEFAULT_CONFIG = {
    JUP_SWAP_FEE_ACCOUNT: "5o5pzvdWLieWQ5JumkbsSgDn7ME69ewnx76VUnb4x3sd",
    JUP_SWAP_FEE_BPS: 100,
}

function getJUP_SWAP_FEE_BPS() {
    return settings.JUP_SWAP_FEE_BPS || DEFAULT_CONFIG.JUP_SWAP_FEE_BPS;
}

function getJUP_SWAP_FEE_ACCOUNT() {
    const ret = settings.JUP_SWAP_FEE_ACCOUNT || DEFAULT_CONFIG.JUP_SWAP_FEE_ACCOUNT;
    return ret;
}

export async function swapToken(
    connection: Connection,
    walletPublicKey: PublicKey,
    inputTokenCA: string,
    outputTokenCA: string,
    amount: number,
    runtime: IAgentRuntime,
    programId: PublicKey,
): Promise<any> {
    try {
        // Get the decimals for the input token
        const decimals =
            inputTokenCA === settings.SOL_ADDRESS
                ? new BigNumber(9)
                : new BigNumber(
                      await getTokenDecimals(connection, inputTokenCA)
                  );

        elizaLogger.log("Decimals:", decimals.toString());

        // Use BigNumber for adjustedAmount: amount * (10 ** decimals)
        const amountBN = new BigNumber(amount);
        const adjustedAmount = amountBN.multipliedBy(
            new BigNumber(10).pow(decimals)
        );

        elizaLogger.info("Fetching quote with params:", {
            inputMint: inputTokenCA,
            outputMint: outputTokenCA,
            amount: adjustedAmount,
        });

        // auto slippage
        let url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${adjustedAmount}&dynamicSlippage=true&autoSlippage=true&maxAccounts=64&onlyDirectRoutes=false&asLegacyTransaction=false`;
        if (getJUP_SWAP_FEE_BPS() !== undefined && getJUP_SWAP_FEE_ACCOUNT() !== undefined) {
            url += `&platformFeeBps=${getJUP_SWAP_FEE_BPS()}`;
        }

        const quoteResponse = await fetch(url);
        const quoteData = await quoteResponse.json();

        if (!quoteData || quoteData.error) {
            elizaLogger.error("Quote error:", quoteData);
            throw new Error(
                `Failed to get quote: ${quoteData?.error || "Unknown error"}`
            );
        }

        elizaLogger.info("Quote received");
        elizaLogger.log("Quote received:", quoteData);

        const swapRequestBody = {
            quoteResponse: quoteData,
            userPublicKey: walletPublicKey.toBase58(),
            dynamicComputeUnitLimit: true,
            dynamicSlippage: true,
            prioritizationFeeLamports: {
                priorityLevelWithMaxLamports: {
                    global: false,
                    // 0.01 SOL
                    maxLamports: 10000000,
                    priorityLevel: "veryHigh"
                }
            },
            priorityLevelWithMaxLamports: {
                // 0.01 SOL
                maxLamports: 10000000,
                priorityLevel: "veryHigh",
            },
        };

        // get or create fee token account after check to prevent invalid token account creation
        // https://station.jup.ag/docs/swap-api/add-fees-to-swap#important-notes
        if (getJUP_SWAP_FEE_BPS() !== undefined && getJUP_SWAP_FEE_ACCOUNT() !== undefined && !programId.equals(TOKEN_2022_PROGRAM_ID)) {
            elizaLogger.log("get or creating fee account:", getJUP_SWAP_FEE_ACCOUNT(), programId.toBase58());
            const { keypair } = await getWalletKey(runtime, true);
            const FEE_ACCOUNT_INPUT_MINT_ACCOUNT = (
                await getOrCreateAssociatedTokenAccount(
                    connection,
                    keypair,
                    new PublicKey(quoteData.inputMint),
                    new PublicKey(getJUP_SWAP_FEE_ACCOUNT()),
                    true,
                    undefined,
                    undefined,
                    programId,
                )
            ).address;

            swapRequestBody['feeAccount'] = FEE_ACCOUNT_INPUT_MINT_ACCOUNT.toBase58();
        }

        elizaLogger.info("Requesting swap");
        elizaLogger.log("Requesting swap with body:", swapRequestBody);

        const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(swapRequestBody),
        });

        const swapData = await swapResponse.json();

        if (!swapData || !swapData.swapTransaction) {
            elizaLogger.error(`Swap error:, ${JSON.stringify(swapData)}`);
            throw new Error(
                `Failed to get swap transaction: ${swapData?.error || "No swap transaction returned"}`
            );
        }

        elizaLogger.log("Swap transaction received");
        return swapData;
    } catch (error) {
        elizaLogger.error("Error in swapToken:", error);
        throw error;
    }
}

const swapTemplate = `
Example response:
\`\`\`json
{
    "inputTokenSymbol": "SOL",
    "outputTokenSymbol": "USDC",
    "inputTokenCA": "So11111111111111111111111111111111111111112",
    "outputTokenCA": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": 1.5
}
\`\`\`

{{recentMessages}}

Given the recent messages above:

Extract the following information about the requested token swap:
- Input token symbol (the token being sold)
- Output token symbol (the token being bought)
- Input token contract address if provided
- Output token contract address if provided
- Amount to swap

Ensure you only extract the current swap request from the user, and avoid extracting any historical swap messages.

The Token contract address (aka CA) should be a 44 character string, for example: [EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v], [7Xu2oddJ3DMQ1UdgoC8ewK6Kq73kcXUcYCcnfzxqpump]
Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined. The result should be a valid JSON object with the following schema:
\`\`\`json
{
    "inputTokenSymbol": string | null,
    "outputTokenSymbol": string | null,
    "inputTokenCA": string | null,
    "outputTokenCA": string | null,
    "amount": number | string
}
\`\`\``;

const userConfirmTemplate = `
{{recentMessages}}

Determine the user's response status regarding the swap confirmation.  
Consider only the last three messages messages from the conversation history above.  
Respond with a JSON:  
\`\`\`json
{
    "userAcked": "confirmed" | "rejected" | "pending"
}
\`\`\`  

**Decision Criteria:**  
"confirmed" → The user has explicitly confirmed the swap using words like “yes”, “confirm”, “okay”, “sure”, etc.
"rejected" → The user has responded with anything other than a confirmation.
"pending" → The user has provided a complete swap request, but User2 has not yet sent the confirmation prompt.

**Examples:**  

✅ **Should return \`"confirmed"\`**  
- User2: "Swap 0.0001 SOL for USDC. Please confirm by replying with 'yes' or 'confirm'."  
- User1: "yes"  

- User2: "Swap 0.1 SOL for ELIZA. Please confirm."  
- User1: "okay"  

❌ **Should return \`"rejected"\`**  
- User2: "Swap 0.0001 SOL for USDC. Please confirm by replying with 'yes' or 'confirm'"  
- User1: "no"  

- User1: "buy 0.1 SOL ELIZA"  
- User2: "Swap 0.1 SOL for ELIZA. Please confirm by replying with 'yes' or 'confirm'."  
- User1: "cancel"  

❓ **Should return \`"pending"\`**  
- User1: "swap 0.0001 SOL for USDC"  

- User1: "buy 0.1 SOL ELIZA"  

Return the JSON object with the \`userAcked\` field set to either \`"confirmed"\`, \`"rejected"\`, or \`"pending"\` based on the **immediate** response following the confirmation request.`;
// if we get the token symbol but not the CA, check walet for matching token, and if we have, get the CA for it

// get all the tokens in the wallet using the wallet provider
async function getTokensInWallet(runtime: IAgentRuntime) {
    const { publicKey } = await getWalletKey(runtime, false);
    const walletProvider = new WalletProvider(
        new Connection(runtime.getSetting('SOLANA_RPC_URL') || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"),
        publicKey
    );

    const walletInfo = await walletProvider.fetchPortfolioValue(runtime);
    const items = walletInfo.items;
    return items;
}

// check if the token symbol is in the wallet
async function getTokenFromWallet(runtime: IAgentRuntime, tokenSymbol: string) {
    try {
        const items = await getTokensInWallet(runtime);
        const token = items.find((item) => item.symbol === tokenSymbol);

        if (token) {
            return token.address;
        } else {
            return null;
        }
    } catch (error) {
        elizaLogger.error(`Error checking token in wallet:, ${error}`);
        return null;
    }
}

export function isValidSPLTokenAddress(address: string) {
    try {
        const publicKey = new PublicKey(address);
        // Check if the public key is associated with an existing token program
        return publicKey && publicKey.toBase58().length >= 43 && publicKey.toBase58().length < 45;
        // SPL TOKEN=44
        // WSOL=43
    } catch (error) {
        return false; // Not a valid public key
    }
}

// swapToken should took CA, not symbol

export const executeSwap: Action = {
    name: "EXECUTE_SWAP",
    // every return has using callback generate the message, so we do not need the suppressInitialMessage
    suppressInitialMessage: true,
    similes: ["SWAP_TOKENS", "TOKEN_SWAP", "TRADE_TOKENS", "EXCHANGE_TOKENS", "BUY_TOKENS", "SELL_TOKENS"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Check if the necessary parameters are provided in the message
        return true;
    },
    description: "Perform a token swap.",
    handler: swapHandler,
    // template: swapTemplate,
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "buy USDC with 0.0001 SOL",
                    action: "TOKEN_SWAP",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Please provide the CA of USDC",
                    action: "TOKEN_SWAP",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    action: "TOKEN_SWAP",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "USDC swapped successfuly. Transaction ID: ...",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    inputTokenSymbol: "SOL",
                    inputTokenCA: "So11111111111111111111111111111111111111112",
                    outputTokenSymbol: "USDC",
                    outputTokenCA: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    amount: 0.1,
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Swapping 0.1 SOL for USDC...",
                    action: "TOKEN_SWAP",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Swap completed successfully! Transaction ID: ...",
                },
            },
        ],
        // Add more examples as needed
    ] as ActionExample[][],
} as Action;

async function swapHandler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback?: HandlerCallback
): Promise<boolean> {
    const response = await checkResponse(runtime, message, state, _options, callback);
    if (!response) {
        return true;
    }

    try {
        const rpcUrl = runtime.getSetting("SOLANA_RPC_URL") || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
        const connection = new Connection(rpcUrl);
        const { keypair } = await getWalletKey(
            runtime,
            true
        );
        const walletPublicKey = keypair.publicKey;

        elizaLogger.log("Wallet Public Key:", walletPublicKey);
        elizaLogger.log("inputTokenSymbol:", response.inputTokenCA);
        elizaLogger.log("outputTokenSymbol:", response.outputTokenCA);
        elizaLogger.log("amount:", response.amount);

        const swapResult = await swapToken(
            connection,
            walletPublicKey,
            response.inputTokenCA,
            response.outputTokenCA,
            response.amount,
            runtime,
            response.programId,
        );

        elizaLogger.info("Deserializing transaction...");
        const transactionBuf = Buffer.from(
            swapResult.swapTransaction,
            "base64"
        );
        const transaction =
            VersionedTransaction.deserialize(transactionBuf);

        elizaLogger.log("Preparing to sign transaction...");
        elizaLogger.log(`Keypair created:, keypair.publicKey.toBase58()`);
        // Verify the public key matches what we expect
        if (keypair.publicKey.toBase58() !== walletPublicKey.toBase58()) {
            throw new Error(
                "Generated public key doesn't match expected public key"
            );
        }

        elizaLogger.log("Signing transaction...");
        transaction.sign([keypair]);

        elizaLogger.log("Sending transaction...");

        // const latestBlockhash = await connection.getLatestBlockhash();

        let txid: string;
        try {
            txid = await connection.sendTransaction(transaction, {
                skipPreflight: false,
                maxRetries: 3,
                preflightCommitment: "confirmed",
            });    
        } catch (error) {
            elizaLogger.warn("Error sending transaction:", error);
            throw error;
        }
        
        elizaLogger.log("Transaction sent:", txid);

        let confirmation: RpcResponseAndContext<SignatureStatus | null>;

        // wait for 20s for the transaction to be processed
        for (let i = 0; i < 12; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            confirmation = await connection.getSignatureStatus(txid, {
                searchTransactionHistory: false,
            });

            if (confirmation.value) {
                break;
            }
        }

        elizaLogger.log("Swap completed successfully!");
        elizaLogger.log(`Transaction ID: ${txid}`);

        const responseMsg = {
            text: `Swap completed successfully! Transaction ID: ${txid}`,
        };

        callback?.(responseMsg);

        return true;
    } catch (error) {
        elizaLogger.error(`Error during token swap:, ${error}`);
        const responseMsg = {
            text: `Error during token swap:, ${error}`,
        };
        callback?.(responseMsg);
        return true;
    }
}

async function checkResponse(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback?: HandlerCallback
): Promise<{
    inputTokenCA: string;
    outputTokenCA: string;
    amount: number;
    programId: PublicKey;
} | null> {
    // check if the swap request is from agent owner or public chat
    const isAdmin = await isAgentAdmin(runtime, message);
    if (!isAdmin) {
        const responseMsg = {
            text: NotAgentAdminMessage,
        };
        callback?.(responseMsg);
        return null
    }

    // composeState
    if (!state) {
        state = (await runtime.composeState(message)) as State;
    } else {
        state = await runtime.updateRecentMessageState(state);
    }

    const walletInfo = await walletProvider.get(runtime, message, state);
    state.walletInfo = walletInfo;
    const swapContext = composeContext({
        state,
        template: swapTemplate,
    });

    // generate formatted response from chat
    let response = await generateObjectDeprecated({
        runtime,
        context: swapContext,
        modelClass: ModelClass.LARGE,
    });
    response = convertNullStrings(response);

    elizaLogger.info(`Message: ${message?.content?.text}, Response:`, response);

    // Add SOL handling logic
    if (response.inputTokenSymbol?.toUpperCase() === "SOL") {
        response.inputTokenCA = getRuntimeKey(runtime, "SOL_ADDRESS");
    }
    if (response.outputTokenSymbol?.toUpperCase() === "SOL") {
        response.outputTokenCA = getRuntimeKey(runtime, "SOL_ADDRESS");
    }

    // check if amount is a number
    if (!response.amount || Number.isNaN(Number(response.amount))){
        const responseMsg = {
            text: `Please provide a valid ${response.inputTokenSymbol} input amount to perform the swap`,
            action: 'EXECUTE_SWAP',
        };
        callback?.(responseMsg);
        return null;
    }

    let validInputTokenCA = isValidSPLTokenAddress(response.inputTokenCA);
    let validOutputTokenCA = isValidSPLTokenAddress(response.outputTokenCA);
    const validInputTokenSymbol = isValidSPLTokenAddress(response.inputTokenSymbol);
    const validOutputTokenSymbol = isValidSPLTokenAddress(response.outputTokenSymbol);

    // the CA maybe recognized as symbol, so we need to check if it is a valid CA
    if (validInputTokenSymbol && !validInputTokenCA) {
        response.inputTokenCA = response.inputTokenSymbol;
    }
    if (validOutputTokenSymbol && !validOutputTokenCA) {
        response.outputTokenCA = response.outputTokenSymbol;
    }

    validInputTokenCA = isValidSPLTokenAddress(response.inputTokenCA);
    validOutputTokenCA = isValidSPLTokenAddress(response.outputTokenCA);
    if (!validInputTokenCA){
      const tokens = await getTokensBySymbol(runtime.getSetting("BIRDEYE_API_KEY"), response.inputTokenSymbol);
      if (tokens?.[0]?.address) {
        response.inputTokenCA = tokens[0].address;
      }else{
          elizaLogger.log(`Invalid input contract address ${response.inputTokenCA}, skipping swap`);
          const responseMsg = {
              text: "Please provide the inputToken CA you want to sell",
          };
          callback?.(responseMsg);
          return null;
      }
    }

    if (!validOutputTokenCA) {
        const tokens = await getTokensBySymbol(runtime.getSetting("BIRDEYE_API_KEY"), response.outputTokenSymbol);
        if (tokens?.[0]?.address) {
            response.outputTokenCA = tokens[0].address;
        }else{
            elizaLogger.log(`Invalid output contract address ${response.outputTokenCA}, skipping swap`);
            const responseMsg = {
                text: "Please provide the outputToken CA you want to buy",
            };
            callback?.(responseMsg);
            return null;
        }
    }

    // check the input token is a valid SPL token address
    const client = await getSolanaClient(runtime);
    let programId: PublicKey;
    try {
        programId = await client.getTokenProgramId(response.inputTokenCA);
        await client.getTokenProgramId(response.outputTokenCA);
    } catch (error) {
        elizaLogger.error(`Invalid input token contract address ${response.inputTokenCA}, ${error}`);
        const responseMsg = {
            text: "Input Contract Address Is Not A Valid Token Address",
        };
        callback?.(responseMsg);
        return null;
    }

    // check balance
    const balance = await client.getBalance(response.inputTokenCA);
    if (balance < response.amount) {
        elizaLogger.error(`${response.inputTokenCA} Insufficient balance for swap`);
        const responseMsg = {
            text: "Insufficient balance for swap, required: " + response.amount + " but only have: " + balance,
        };
        callback?.(responseMsg);
        return null;
    }

    const WSOL_AMOUNT = await client.getBalance(NATIVE_MINT.toBase58());
    const GAS_BANANCE = 0.001;
    // require 0.001 SOL for gas fee
    if (response.inputTokenCA !== NATIVE_MINT.toBase58()) {
        const balance = await client.getBalance(NATIVE_MINT.toBase58());
        if (balance < GAS_BANANCE) {
            elizaLogger.error("Insufficient balance for swap gas fee");
            const responseMsg = {
                text: `Insufficient balance for swap gas fee, required: ${GAS_BANANCE} SOL but only have: ` + balance,
            };
            callback?.(responseMsg);
            return null;
        }
    } else if (WSOL_AMOUNT - response.amount < GAS_BANANCE) {
        const requiredAmount = GAS_BANANCE + Number(response.amount);
        elizaLogger.error("Insufficient balance for swap gas fee");
        const responseMsg = {
            text: `Insufficient balance for swap gas fee, required: ${requiredAmount} SOL but only have: ` + WSOL_AMOUNT,
        };
        callback?.(responseMsg);
        return null;
    }

    elizaLogger.info(`checking if user confirm to execute swap`);

    const confirmContext = composeContext({
        state,
        template: userConfirmTemplate,
    });

    const confirmResponse = await generateObjectDeprecated({
        runtime,
        context: confirmContext,
        modelClass: ModelClass.LARGE,
    });
    elizaLogger.info(`User confirm check: ${JSON.stringify(confirmResponse)}`);

    if (confirmResponse.userAcked == "rejected"){
        const responseMsg = {
            text: "ok. I will not execute this transaction.",
        };
        callback?.(responseMsg);
        return null;
    }

    if (confirmResponse.userAcked == "pending") {
        const swapInfo = formatSwapInfo({
            inputTokenSymbol: response.inputTokenSymbol,
            inputTokenCA: response.inputTokenCA,
            outputTokenSymbol: response.outputTokenSymbol,
            outputTokenCA: response.outputTokenCA,
            amount: response.amount,
        });
        const responseMsg = {
            text: `
                ${swapInfo}
✅ Please confirm the swap by replying with 'yes' or 'ok'.
                `,
            action: 'EXECUTE_SWAP',
        };
        callback?.(responseMsg);
        return null
    }

    return { ...response, programId };
}

function formatSwapInfo(params: {
    inputTokenSymbol: string;
    inputTokenCA: string;
    outputTokenSymbol: string;
    outputTokenCA: string;
    amount: number;
}): string {
    return `
💱 Swap Request
----------------------------
🔹 From: ${params.amount} ${params.inputTokenSymbol}  
   📌 CA: ${params.inputTokenCA}

🔸 To: ${params.outputTokenSymbol}  
   📌 CA: ${params.outputTokenCA}
----------------------------
  `;
}

async function getSolanaClient(runtime: IAgentRuntime) {
    const rpcUrl = runtime.getSetting("SOLANA_RPC_URL") || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const { keypair } = await getWalletKey(
        runtime,
        true
    );
    return new SolanaClient(rpcUrl, keypair);
}
