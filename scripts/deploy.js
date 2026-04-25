const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const DEFAULT_UNISWAP_V2_ROUTER_BY_CHAIN = {
    1: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    11155111: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3"
  };

  console.log("Deploying with account:", deployer.address);
  console.log("Chain ID:", chainId);

  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;
  const platformFeeRecipient =
    process.env.PLATFORM_FEE_RECIPIENT || "0x024469De02f5efFc7c10667f3e2A852Bd4a5149f";
  const feeBps = process.env.FEE_BPS ? Number(process.env.FEE_BPS) : 50;
  const launchFeeWei = process.env.LAUNCH_FEE_WEI
    ? BigInt(process.env.LAUNCH_FEE_WEI)
    : process.env.LAUNCH_FEE_ETH
      ? hre.ethers.parseEther(process.env.LAUNCH_FEE_ETH)
      : hre.ethers.parseEther("0.0015");

  const virtualEthReserve = process.env.VIRTUAL_ETH_RESERVE
    ? hre.ethers.parseEther(process.env.VIRTUAL_ETH_RESERVE)
    : hre.ethers.parseEther("0.5");

  const virtualTokenReserve = process.env.VIRTUAL_TOKEN_RESERVE
    ? hre.ethers.parseUnits(process.env.VIRTUAL_TOKEN_RESERVE, 18)
    : hre.ethers.parseUnits("1000000", 18);

  const graduationTargetEth = process.env.GRADUATION_TARGET_ETH
    ? hre.ethers.parseEther(process.env.GRADUATION_TARGET_ETH)
    : hre.ethers.parseEther("12");

  let dexRouter = process.env.DEX_ROUTER || DEFAULT_UNISWAP_V2_ROUTER_BY_CHAIN[chainId] || hre.ethers.ZeroAddress;

  if (dexRouter === hre.ethers.ZeroAddress && chainId === 31337 && process.env.DEPLOY_LOCAL_MOCK_DEX !== "false") {
    const defaultWeth = process.env.WETH_ADDRESS || "0x4200000000000000000000000000000000000006";
    const MockRouter = await hre.ethers.getContractFactory("MockDexRouter");
    const mockRouter = await MockRouter.deploy(defaultWeth);
    await mockRouter.waitForDeployment();
    dexRouter = await mockRouter.getAddress();
    console.log("MockDexRouter deployed:", dexRouter);
  }

  const lpRecipient =
    dexRouter === hre.ethers.ZeroAddress
      ? hre.ethers.ZeroAddress
      : process.env.LP_RECIPIENT || feeRecipient;

  const Factory = await hre.ethers.getContractFactory("MemeLaunchFactory");
  const factory = await Factory.deploy(
    feeRecipient,
    platformFeeRecipient,
    feeBps,
    launchFeeWei,
    virtualEthReserve,
    virtualTokenReserve,
    graduationTargetEth,
    dexRouter,
    lpRecipient
  );

  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log("MemeLaunchFactory deployed:", factoryAddress);
  console.log("feeRecipient:", feeRecipient);
  console.log("platformFeeRecipient:", platformFeeRecipient);
  console.log("feeBps:", feeBps);
  console.log("launchFeeWei:", launchFeeWei.toString());
  console.log("graduationTargetEth:", hre.ethers.formatEther(graduationTargetEth));
  console.log("dexRouter:", dexRouter);
  console.log("lpRecipient:", lpRecipient);

  const output = {
    chainId,
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

  const outPath = path.join(__dirname, "..", "frontend", "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("Wrote frontend deployment config to", outPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
