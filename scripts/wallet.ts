/**
 * coldstart — testnet wallet helper. Never prints the private key.
 *
 *   npx tsx scripts/wallet.ts new       # generate a throwaway key into .env
 *   npx tsx scripts/wallet.ts check     # address + STT (gas) + tUSDC balances
 *   npx tsx scripts/wallet.ts faucet    # mint 10,000 tUSDC (needs STT for gas)
 *
 * Written as a file with an async main, not `tsx -e`: inline scripts compile as
 * CJS and reject top-level await.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createPublicClient, http, formatEther, formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const MODE = process.argv[2] ?? "check";
const RPC = "https://dream-rpc.somnia.network";
const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as const;
const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint8" }] },
] as const;

function writeKey(pk: string) {
  const path = ".env";
  let env = existsSync(path) ? readFileSync(path, "utf8") : "";
  env = /^SOMNIA_PK=.*$/m.test(env)
    ? env.replace(/^SOMNIA_PK=.*$/m, `SOMNIA_PK=${pk}`)
    : env.replace(/\n*$/, "\n") + `SOMNIA_PK=${pk}\n`;
  writeFileSync(path, env);
  chmodSync(path, 0o600);
}

function account() {
  const pk = process.env.SOMNIA_PK;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error("no valid SOMNIA_PK in .env — run: npx tsx scripts/wallet.ts new");
    process.exit(1);
  }
  return privateKeyToAccount(pk as `0x${string}`);
}

async function balances(address: `0x${string}`) {
  const c = createPublicClient({ transport: http(RPC) });
  const [stt, bal] = await Promise.all([
    c.getBalance({ address }),
    c.readContract({ address: TUSDC, abi: ERC20, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
  ]);
  return { stt, bal };
}

async function main() {
  if (MODE === "new") {
    const pk = generatePrivateKey();
    writeKey(pk);
    const addr = privateKeyToAccount(pk).address;
    console.log("address:", addr);
    console.log("key written to .env (chmod 600, gitignored) — not printed, do not paste it anywhere");
    console.log("\nnext: fund this address with STT for gas, then `wallet.ts faucet` for tUSDC");
    return;
  }

  const acct = account();
  const { stt, bal } = await balances(acct.address);
  console.log(`${acct.address}`);
  console.log(`  STT (gas)  : ${formatEther(stt)}`);
  console.log(`  tUSDC      : ${formatUnits(bal, 6)}`);

  if (MODE === "faucet") {
    if (stt === 0n) {
      console.error("\n0 STT — the faucet call needs gas. Fund the address above first.");
      process.exit(1);
    }
    const exchange: any = new SomniaMarkets({
      indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
      chain: somniaShannon,
      wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
      addresses: SOMNIA_TESTNET_ADDRESSES,
      privateKey: process.env.SOMNIA_PK as `0x${string}`,
    });
    const res = await exchange.trader.faucet();
    console.log("\nfaucet tx:", res?.receipt?.transactionHash ?? res);
    console.log("explorer :", `https://shannon-explorer.somnia.network/tx/${res?.receipt?.transactionHash ?? ""}`);
    const after = await balances(acct.address);
    console.log("tUSDC now:", formatUnits(after.bal, 6));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
