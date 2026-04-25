const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { ethers } = require("ethers");

dotenv.config();

async function main() {
  const ROOT = path.join(__dirname, "..");
  const artifactPath = path.join(
    ROOT,
    "artifacts",
    "contracts",
    "MemeLaunchFactory.sol",
    "MemeLaunchFactory.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing artifact: ${artifactPath}. Run npm run compile first.`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const rpcUrl = String(process.env.MAINNET_RPC_URL || "").trim();
  const privateKey = String(process.env.PRIVATE_KEY || "").trim();
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL is required");
  if (!privateKey) throw new Error("PRIVATE_KEY is required");

  const provider = new ethers.JsonRpcProvider(rpcUrl, 1);
  const wallet = new ethers.Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, provider);
  const chain = await provider.getNetwork();
  if (Number(chain.chainId) !== 1) {
    throw new Error(`Unexpected chainId ${chain.chainId}. MAINNET_RPC_URL must point to Ethereum mainnet.`);
  }

  const feeRecipient = process.env.FEE_RECIPIENT || wallet.address;
  const platformFeeRecipient = process.env.PLATFORM_FEE_RECIPIENT || wallet.address;
  const feeBps = process.env.FEE_BPS ? Number(process.env.FEE_BPS) : 50;
  const launchFeeWei = process.env.LAUNCH_FEE_WEI
    ? BigInt(process.env.LAUNCH_FEE_WEI)
    : process.env.LAUNCH_FEE_ETH
      ? ethers.parseEther(process.env.LAUNCH_FEE_ETH)
      : ethers.parseEther("0.0015");
  const virtualEthReserve = process.env.VIRTUAL_ETH_RESERVE
    ? ethers.parseEther(process.env.VIRTUAL_ETH_RESERVE)
    : ethers.parseEther("0.5");
  const virtualTokenReserve = process.env.VIRTUAL_TOKEN_RESERVE
    ? ethers.parseUnits(process.env.VIRTUAL_TOKEN_RESERVE, 18)
    : ethers.parseUnits("1000000", 18);
  const graduationTargetEth = process.env.GRADUATION_TARGET_ETH
    ? ethers.parseEther(process.env.GRADUATION_TARGET_ETH)
    : ethers.parseEther("12");
  const dexRouter = process.env.DEX_ROUTER || "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const lpRecipient = process.env.LP_RECIPIENT || feeRecipient;
  const feeData = await provider.getFeeData();
  const latestBlock = await provider.getBlock("latest");
  const baseFeePerGas = latestBlock?.baseFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("1", "gwei");
  const envPriorityGwei = String(process.env.DEPLOY_PRIORITY_FEE_GWEI || "").trim();
  const envMaxFeeGwei = String(process.env.DEPLOY_MAX_FEE_GWEI || "").trim();
  const maxPriorityFeePerGas = envPriorityGwei
    ? ethers.parseUnits(envPriorityGwei, "gwei")
    : feeData.maxPriorityFeePerGas ?? 100000n;
  const maxFeePerGas = envMaxFeeGwei
    ? ethers.parseUnits(envMaxFeeGwei, "gwei")
    : baseFeePerGas + maxPriorityFeePerGas + 100000n;
  const txOverrides = {
    maxPriorityFeePerGas,
    maxFeePerGas
  };

  console.log("Deploying with account:", wallet.address);
  console.log("Chain ID:", chain.chainId.toString());
  console.log("feeRecipient:", feeRecipient);
  console.log("platformFeeRecipient:", platformFeeRecipient);
  console.log("lpRecipient:", lpRecipient);
  console.log("baseFeePerGas:", baseFeePerGas.toString());
  console.log("maxPriorityFeePerGas:", maxPriorityFeePerGas.toString());
  console.log("maxFeePerGas:", maxFeePerGas.toString());

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(
    feeRecipient,
    platformFeeRecipient,
    feeBps,
    launchFeeWei,
    virtualEthReserve,
    virtualTokenReserve,
    graduationTargetEth,
    dexRouter,
    lpRecipient,
    txOverrides
  );

  console.log("Deploy tx:", contract.deploymentTransaction()?.hash || "");
  await contract.waitForDeployment();
  const factoryAddress = await contract.getAddress();
  console.log("MemeLaunchFactory deployed:", factoryAddress);

  const output = {
    chainId: 1,
    deployedAt: new Date().toISOString(),
    memeLaunchFactory: factoryAddress,
    feeRecipient,
    platformFeeRecipient,
    feeBps,
    launchFeeWei: launchFeeWei.toString(),
    virtualEthReserve: virtualEthReserve.toString(),
    virtualTokenReserve: virtualTokenReserve.toString(),
    graduationTargetEth: graduationTargetEth.toString(),
    dexRouter,
    lpRecipient
  };

  const outPath = path.join(ROOT, "frontend", "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("Wrote frontend deployment config to", outPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
