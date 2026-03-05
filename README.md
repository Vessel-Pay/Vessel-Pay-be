# ArtaPay Backend

Backend service for ArtaPay dApp that signs Paymaster data and builds StableSwap
calldata for gasless stablecoin transactions on Base Sepolia and Etherlink Shadownet.

## Overview

ArtaPay Backend provides:

- **Paymaster Signing**: Generates signatures for ERC-4337 paymaster validation
- **Swap Quotes**: Reads on-chain StableSwap quotes for token conversions
- **Swap Calldata Builder**: Encodes `swap()` calls for smart accounts/wallets
- **Health + Signer Info**: Simple endpoints for monitoring and integration

## Architecture

### Core Modules

#### 1. **Express API** - HTTP Service

Main HTTP server providing JSON endpoints.

**Key Features:**

- CORS configuration via env
- JSON request/response
- Health and signer discovery endpoints

#### 2. **Paymaster Signer** - Signature Service

Signs paymaster data for gasless transactions.

**Key Features:**

- Uses a dedicated signer private key
- Hash: `keccak256(abi.encode(payer, token, validUntil, validAfter))`
- Compatible with Paymaster validation logic

**Main Functions:**

- `signPaymasterData()` - Builds and signs the paymaster hash

#### 3. **StableSwap Helper** - Quote + Calldata

Reads quotes and encodes swap calldata for StableSwap.

**Key Features:**

- Uses `getSwapQuote()` on-chain
- Encodes `swap()` calldata for client usage
- Validates addresses and amounts

**Main Functions:**

- `getSwapQuote()` (via `readContract`)
- `buildSwapCalldata()` (via `encodeFunctionData`)

## Fee Structure

This backend does not charge fees. On-chain fees are defined in the smart
contracts (see `artapay-sc`).

| Fee Type       | Rate          | Paid By | Token      |
| -------------- | ------------- | ------- | ---------- |
| Platform Fee   | 0.3% (30 BPS) | Payer   | Stablecoin |
| Swap Fee       | 0.1% (10 BPS) | User    | Stablecoin |

## Setup & Installation

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
# From repo root
cd artapay-be

# Install dependencies
npm install
```

### Environment Setup

Create a `.env` file in the root directory:

```bash
# =====================================================
# PAYMASTER SIGNER BACKEND CONFIGURATION
# =====================================================

# IMPORTANT: This must be a PRIVATE KEY, not an address
PAYMASTER_SIGNER_PRIVATE_KEY=0x...

# RPC endpoints for reading StableSwap (quotes/calldata)
RPC_URL=https://sepolia.base.org
RPC_URL_ETHERLINK=https://node.shadownet.etherlink.com

# Default chain for requests without explicit chain/chainId/header
DEFAULT_CHAIN=etherlink

# StableSwap contract addresses (for quote/build)
STABLE_SWAP_ADDRESS=0x...
STABLE_SWAP_ADDRESS_ETHERLINK=0x...

# Server port
PORT=3001

# Allowed CORS origins (comma-separated)
CORS_ORIGINS=http://localhost:5173
```

### Chain Selection

For multichain requests, include one of the following:

- Query or body: `chain=base` / `chain=etherlink`
- Query or body: `chainId=84532` / `chainId=127823`
- Header: `x-chain: base` or `x-chain: etherlink`

If omitted, the backend defaults to `DEFAULT_CHAIN` (fallback: Etherlink Shadownet).

## Deployment

### Run Locally (Watch Mode)

```bash
npm run dev
```

### Run Server

```bash
npm run start
```

### Build TypeScript

```bash
npm run build
```

## Network Information

### Base Sepolia Testnet

- **Chain ID**: 84532
- **RPC URL**: https://sepolia.base.org
- **Block Explorer**: https://base-sepolia.blockscout.com
- **EntryPoint v0.7**: `0x0000000071727De22E5E9d8BAf0edAc6f37da032`

### Etherlink Shadownet Testnet

- **Chain ID**: 127823
- **RPC URL**: https://node.shadownet.etherlink.com
- **Block Explorer**: https://shadownet.explorer.etherlink.com
- **EntryPoint v0.7**: `0x0000000071727De22E5E9d8BAf0edAc6f37da032`

## Supported Stablecoins

### Base Sepolia

| Symbol | Name               | Decimals | Region |
| ------ | ------------------ | -------- | ------ |
| USDC   | USD Coin          | 6        | US     |
| USDS   | Sky Dollar        | 6        | US     |
| EURC   | Euro Coin         | 6        | EU     |
| BRZ    | Brazilian Digital | 6        | BR     |
| AUDD   | AUDD              | 6        | AU     |
| CADC   | CAD Coin          | 6        | CA     |
| ZCHF   | Frankencoin       | 6        | CH     |
| TGBP   | Tokenised GBP     | 18       | GB     |
| IDRX   | Indonesia Rupiah  | 6        | ID     |

### Etherlink Shadownet

| Symbol | Name              | Decimals | Region |
| ------ | ----------------- | -------- | ------ |
| USDC   | USD Coin          | 6        | US     |
| USDT   | Tether USD        | 6        | US     |
| IDRX   | Indonesia Rupiah  | 6        | ID     |

## Contract Addresses

### Base Sepolia (Testnet)

```
EntryPoint:            0x0000000071727De22E5E9d8BAf0edAc6f37da032
StablecoinRegistry:    0x573f4D2b5e9E5157693a9Cc0008FcE4e7167c584
Paymaster:             0x1b14BF9ab47069a77c70Fb0ac02Bcb08A9Ffe290
StableSwap:            0x822e1dfb7bf410249b2bE39809A5Ae0cbfae612f
PaymentProcessor:      0x4D053b241a91c4d8Cd86D0815802F69D34a0164B
SimpleAccountFactory:  0xfEA9DD0034044C330c0388756Fd643A5015d94D2
QRISRegistry:          0x5268D80f943288bBe50fc20142e09EcC9B6b1F3e

Mock Tokens:
  USDC:  0x74FB067E49CBd0f97Dc296919e388CB3CFB62b4D
  USDS:  0x79f3293099e96b840A0423B58667Bc276Ea19aC0
  EURC:  0xfF4dD486832201F6DC41126b541E3b47DC353438
  BRZ:   0x9d30F685C04f024f84D9A102d0fE8dF348aE7E7d
  AUDD:  0x9f6b8aF49747304Ce971e2b9d131B2bcd1841d83
  CADC:  0x6BB3FFD9279fBE76FE0685Df7239c23488bC96e4
  ZCHF:  0xF27edF22FD76A044eA5B77E1958863cf9A356132
  tGBP:  0xb4db79424725256a6E6c268fc725979b24171857
  IDRX:  0x34976B6c7Aebe7808c7Cab34116461EB381Bc2F8
```

### Etherlink Shadownet (Testnet)

```
EntryPoint:            0x0000000071727De22E5E9d8BAf0edAc6f37da032
StablecoinRegistry:    0x6fe372ef0B695ec05575D541e0DA60bf18A3D0f0
Paymaster:             0xFC7E8c60315e779b1109B252fcdBFB8f3524F9B6
StableSwap:            0xB67b210dEe4C1A744c1d51f153b3B3caF5428F60
PaymentProcessor:      0x5D4748951fB0AF37c57BcCb024B3EE29360148bc
SimpleAccountFactory:  0xb7E56FbAeC1837c5693AAf35533cc94e35497d86
QRISRegistry:          0xD17d8f2819C068A57f0F4674cF439d1eC96C56f5

Mock Tokens:
  USDC:  0x60E48d049EB0c75BF428B028Da947c66b68f5dd2
  USDT:  0xcaF86109F34d74DE0e554FD5E652C412517374fb
  IDRX:  0x8A272505426D4F129EE3493A837367B884653237
```

## Security Considerations

- **Private Key Management**: Never commit private keys. Use environment files.
- **Signer Permissions**: Use a dedicated signer with limited authority.
- **CORS Control**: Restrict `CORS_ORIGINS` to trusted frontends.
- **Rate Limiting**: Add a reverse proxy if exposing this publicly.
- **Input Validation**: Addresses and amounts are validated server-side.

## Development

### Code Style

This project uses:

- TypeScript
- Express for HTTP APIs
- viem for EVM interactions

### Project Structure

```
artapay-be/
|-- src/
|   |-- index.ts        # API server and signer logic
|-- .env.example        # Environment template
|-- package.json
|-- tsconfig.json
```

## License

MIT License - see LICENSE file for details
