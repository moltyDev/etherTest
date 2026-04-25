const hre = require("hardhat");

async function main() {
  const factoryAddr = "0xAe99029Af3300AC173aC6DC2335C61c1AE982292";
  const [signer] = await hre.ethers.getSigners();
  console.log("Signer:", signer.address);

  const factory = await hre.ethers.getContractAt("MemeLaunchFactory", factoryAddr, signer);

  const count = await factory.getLaunchCount();
  console.log("Launch count:", count.toString());

  const name = "TestMeme";
  const symbol = "TMEME";
  const image = "";
  const desc = "debug";
  const totalSupply = hre.ethers.parseUnits("1000000", 18);
  const creatorBps = 500;

  try {
    await factory.createLaunch.staticCall(name, symbol, image, desc, totalSupply, creatorBps);
    console.log("staticCall: OK");
  } catch (e) {
    console.log("staticCall failed:", e.shortMessage || e.message);
    console.log("details:", e.reason || e.data || e);
    return;
  }

  const tx = await factory.createLaunch(name, symbol, image, desc, totalSupply, creatorBps);
  console.log("tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("mined block:", rcpt.blockNumber);

  const countAfter = await factory.getLaunchCount();
  console.log("Launch count after:", countAfter.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});