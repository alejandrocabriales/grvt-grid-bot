/**
 * EIP-712 Order Signing for GRVT
 * Reference: https://gist.github.com/minhbsq/40842859bd8029694d8d33352b216ba8
 * Chain IDs: 325 (mainnet), 326 (testnet), 327 (devnet)
 */

import { ethers } from "ethers";

// GRVT Chain IDs (from ChainList / official docs)
export const GRVT_CHAIN_ID = 325;          // Mainnet
export const GRVT_TESTNET_CHAIN_ID = 326;  // Testnet

// EIP-712 Domain for GRVT (no verifyingContract or salt)
const EIP712_DOMAIN = {
  name: "GRVT Exchange",
  version: "0",
  chainId: GRVT_CHAIN_ID,
};

// EIP-712 Types for Order — camelCase field names per GRVT spec
const ORDER_TYPES = {
  Order: [
    { name: "subAccountID", type: "uint64" },
    { name: "isMarket", type: "bool" },
    { name: "timeInForce", type: "uint8" },
    { name: "postOnly", type: "bool" },
    { name: "reduceOnly", type: "bool" },
    { name: "legs", type: "OrderLeg[]" },
    { name: "nonce", type: "uint32" },
    { name: "expiration", type: "int64" },
  ],
  OrderLeg: [
    { name: "assetID", type: "uint256" },
    { name: "contractSize", type: "uint64" },
    { name: "limitPrice", type: "uint64" },
    { name: "isBuyingContract", type: "bool" },
  ],
};

// Time in Force mapping
export const TIME_IN_FORCE = {
  GOOD_TILL_TIME: 1,
  ALL_OR_NONE: 2,
  IMMEDIATE_OR_CANCEL: 3,
  FILL_OR_KILL: 4,
};

export interface SignedOrderParams {
  subAccountId: string;
  instrument: string;
  instrumentId: string; // uint256 from /full/v1/instrument — required for EIP-712
  size: string;       // in base units (e.g., ETH amount)
  limitPrice: string; // in quote units (e.g., USDC price)
  isBuying: boolean;
  isMarket?: boolean;
  privateKey: string;
  useTestnet?: boolean;
}

export interface SignedOrder {
  sub_account_id: string;
  is_market: boolean;
  time_in_force: string;
  post_only: boolean;
  reduce_only: boolean;
  legs: {
    instrument: string;
    size: string;
    limit_price: string;
    is_buying_asset: boolean;
  }[];
  signature: {
    signer: string;
    r: string;
    s: string;
    v: number;
    expiration: string;
    nonce: number;
  };
  metadata: {
    client_order_id: string;
  };
}

/**
 * Convert a price/size string to GRVT's internal representation (9 decimals)
 */
function toGrvtDecimals(value: string, decimals = 9): bigint {
  const [integer, fraction = ""] = value.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(integer + paddedFraction);
}

/**
 * Sign a single-leg limit order with EIP-712
 */
export async function signLimitOrder(
  params: SignedOrderParams
): Promise<SignedOrder> {
  const {
    subAccountId,
    instrument,
    instrumentId,
    size,
    limitPrice,
    isBuying,
    isMarket = false,
    privateKey,
    useTestnet = false,
  } = params;

  const wallet = new ethers.Wallet(privateKey);
  const chainId = useTestnet ? GRVT_TESTNET_CHAIN_ID : GRVT_CHAIN_ID;

  // Nonce: random 32-bit int
  const nonce = Math.floor(Math.random() * 2 ** 32);

  // Expiration: 1 hour from now in nanoseconds
  const expirationNs = BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n;

  const domain = { ...EIP712_DOMAIN, chainId };

  // EIP-712 signed data — uses camelCase field names
  const orderData = {
    subAccountID: BigInt(subAccountId),
    isMarket,
    timeInForce: TIME_IN_FORCE.GOOD_TILL_TIME,
    postOnly: false,
    reduceOnly: false,
    legs: [
      {
        assetID: BigInt(instrumentId),
        contractSize: toGrvtDecimals(size),
        limitPrice: toGrvtDecimals(limitPrice),
        isBuyingContract: isBuying,
      },
    ],
    nonce,
    expiration: expirationNs,
  };

  const signature = await wallet.signTypedData(domain, ORDER_TYPES, orderData);
  const sig = ethers.Signature.from(signature);

  // REST API payload — uses snake_case, signature in nested object
  return {
    sub_account_id: subAccountId,
    is_market: isMarket,
    time_in_force: "GOOD_TILL_TIME",
    post_only: false,
    reduce_only: false,
    legs: [
      {
        instrument,
        size,
        limit_price: limitPrice,
        is_buying_asset: isBuying,
      },
    ],
    signature: {
      signer: wallet.address,
      r: sig.r,
      s: sig.s,
      v: sig.v,
      expiration: expirationNs.toString(),
      nonce,
    },
    metadata: {
      client_order_id: String(nonce),
    },
  };
}
