# MemeForge ETH Launchpad

A low-fee meme token launch platform for Ethereum inspired by Pump.fun.

## What this includes

- `MemeLaunchFactory`: launches new meme tokens + pools with default graduation config.
- `MemeToken`: minimal ERC20 token for each launch.
- `MemePool`: bonding-curve pool with virtual reserves, low fees, and auto DEX liquidity migration.
- `MockDexRouter` (local testing): simulates auto LP migration flow on localhost.
- Hardhat tests and deploy script.
- Multi-page web app (`frontend/`) with pump-style flows: Explore, Create, Token, Profile.

## Pump-style behavior implemented

- No manual LP step for creators.
- Trading starts on bonding curve.
- When pool ETH reserve reaches `graduationTargetEth`, migration auto-runs.
- Pool migrates remaining ETH + token reserves to configured DEX router via `addLiquidityETH`.
- Bonding-curve trading is then closed (`graduated=true`) and UI shows DEX pair.

## Design highlights

- Launches are on-chain and permissionless.
- Trading fee defaults to `0.50%` (`50` bps) on DEX trades, split as:
  - `0.30%` to token creator (claimable on profile)
  - `0.20%` to platform recipient
- Launch fee is configurable (`launchFeeWei`) and sent to the platform recipient.
- Virtual reserves smooth initial pricing and reduce launch slippage spikes.
- Creator allocation is capped at `20%` for fairer launches.
- Graduation settings are factory defaults, so each launch is consistent.

## Quick start (local)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Compile and test:
   ```bash
   npm run compile
   npm test
   ```
3. Run local chain:
   ```bash
   npm run node
   ```
4. In another terminal, deploy:
   ```bash
   npm run deploy:local
   ```
5. Start web app server:
   ```bash
   npm run app
   ```
6. Open:
   - `http://localhost:4173/` (Explore)
   - `http://localhost:4173/create` (Create)
   - `http://localhost:4173/token?token=<TOKEN_ADDRESS>` (Token page)
   - `http://localhost:4173/profile?address=<WALLET_ADDRESS>` (Profile page)

## Deploy to Sepolia

1. Copy `.env.example` to `.env` and set values.
2. Configure real `DEX_ROUTER` and `LP_RECIPIENT`.
3. Export env vars in your shell.
4. Run:
   ```bash
   npm run deploy:sepolia
   ```

## Deploy to Ethereum mainnet

1. Copy `.env.example` to `.env` and set:
   - `MAINNET_RPC_URL`
   - `PRIVATE_KEY` (use a burner wallet)
   - `FEE_RECIPIENT`
   - `PLATFORM_FEE_RECIPIENT`
   - `LP_RECIPIENT`
2. Optional:
   - `LAUNCH_FEE_ETH`
   - `DEX_ROUTER` (defaults to Uniswap V2 Router02 on mainnet)
3. Deploy:
   ```bash
   npm run deploy:mainnet
   ```
4. Start app in mainnet mode:
   - `CHAIN_ID=1`
   - `FACTORY_ADDRESS=<deployed factory address>`

## Environment variables

- `SEPOLIA_RPC_URL`
- `MAINNET_RPC_URL`
- `PRIVATE_KEY`
- `CHAIN_ID`
- `FACTORY_ADDRESS`
- `FACTORY_ADDRESSES` (JSON map for multi-chain production auto-discovery)
- `RPC_URLS_BY_CHAIN` (JSON map for chain-specific RPC endpoints)
- `UPLOAD_MODE` (`disk` for traditional server, `inline` for serverless deployments)
- `FEE_RECIPIENT`
- `PLATFORM_FEE_RECIPIENT`
- `FEE_BPS`
- `LAUNCH_FEE_WEI` or `LAUNCH_FEE_ETH`
- `VIRTUAL_ETH_RESERVE`
- `VIRTUAL_TOKEN_RESERVE`
- `GRADUATION_TARGET_ETH`
- `DEX_ROUTER`
- `LP_RECIPIENT`

## Notes

- Mainnet deployment still requires external security audit.
- Frontend uses MetaMask + direct contract calls, with an Express backend for live chain reads and page routing.
- Frontend supports local image upload (stored as `data:image/...` URI); keep image size under `35 KB`.
- If contracts change, redeploy to refresh `frontend/deployment.json`.
- Production API supports `?chainId=<id>` and auto-resolves factory per chain from env config.
- `vercel.json` is included for deploying the Express app as a single Vercel Node function.
