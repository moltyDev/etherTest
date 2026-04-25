// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MemeToken.sol";
import "./MemePool.sol";

/// @title MemeLaunchFactory
/// @notice Launches meme tokens with bonding-curve pools and auto DEX graduation.
contract MemeLaunchFactory {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    struct LaunchInfo {
        address token;
        address pool;
        address creator;
        string name;
        string symbol;
        string imageURI;
        string description;
        uint256 totalSupply;
        uint256 creatorAllocation;
        uint256 createdAt;
    }

    address public owner;
    address public feeRecipient;
    address public platformFeeRecipient;
    uint256 public defaultFeeBps;
    uint256 public launchFeeWei;
    uint256 public defaultVirtualEthReserve;
    uint256 public defaultVirtualTokenReserve;

    // Graduation defaults (pump-style auto migration)
    uint256 public defaultGraduationTargetEth;
    address public defaultDexRouter;
    address public defaultLpRecipient;

    LaunchInfo[] private launches;
    mapping(address token => address pool) public poolByToken;

    event LaunchCreated(
        uint256 indexed launchId,
        address indexed creator,
        address indexed token,
        address pool,
        uint256 totalSupply,
        uint256 creatorAllocation,
        uint256 feeBps,
        uint256 graduationTargetEth,
        address dexRouter,
        address lpRecipient
    );

    event DefaultsUpdated(
        address feeRecipient,
        address platformFeeRecipient,
        uint256 feeBps,
        uint256 launchFeeWei,
        uint256 virtualEthReserve,
        uint256 virtualTokenReserve,
        uint256 graduationTargetEth,
        address dexRouter,
        address lpRecipient
    );

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event InstantLaunchRequested(address indexed creator, uint256 ethLiquidity);
    event LaunchFeePaid(address indexed payer, address indexed recipient, uint256 amountWei);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor(
        address _feeRecipient,
        address _platformFeeRecipient,
        uint256 _defaultFeeBps,
        uint256 _launchFeeWei,
        uint256 _defaultVirtualEthReserve,
        uint256 _defaultVirtualTokenReserve,
        uint256 _defaultGraduationTargetEth,
        address _defaultDexRouter,
        address _defaultLpRecipient
    ) {
        require(_feeRecipient != address(0), "fee recipient required");
        require(_defaultFeeBps <= 300, "fee too high");
        require(_platformFeeRecipient != address(0), "platform recipient required");
        require(_defaultVirtualEthReserve > 0, "virtual eth required");
        require(_defaultVirtualTokenReserve > 0, "virtual token required");
        require(_defaultGraduationTargetEth > 0, "target required");

        if (_defaultDexRouter != address(0)) {
            require(_defaultLpRecipient != address(0), "lp recipient required");
        }

        owner = msg.sender;
        feeRecipient = _feeRecipient;
        platformFeeRecipient = _platformFeeRecipient;
        defaultFeeBps = _defaultFeeBps;
        launchFeeWei = _launchFeeWei;
        defaultVirtualEthReserve = _defaultVirtualEthReserve;
        defaultVirtualTokenReserve = _defaultVirtualTokenReserve;
        defaultGraduationTargetEth = _defaultGraduationTargetEth;
        defaultDexRouter = _defaultDexRouter;
        defaultLpRecipient = _defaultLpRecipient;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner required");

        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setDefaults(
        address newFeeRecipient,
        address newPlatformFeeRecipient,
        uint256 newFeeBps,
        uint256 newLaunchFeeWei,
        uint256 newVirtualEthReserve,
        uint256 newVirtualTokenReserve,
        uint256 newGraduationTargetEth,
        address newDexRouter,
        address newLpRecipient
    ) external onlyOwner {
        require(newFeeRecipient != address(0), "fee recipient required");
        require(newPlatformFeeRecipient != address(0), "platform recipient required");
        require(newFeeBps <= 300, "fee too high");
        require(newVirtualEthReserve > 0, "virtual eth required");
        require(newVirtualTokenReserve > 0, "virtual token required");
        require(newGraduationTargetEth > 0, "target required");

        if (newDexRouter != address(0)) {
            require(newLpRecipient != address(0), "lp recipient required");
        }

        feeRecipient = newFeeRecipient;
        platformFeeRecipient = newPlatformFeeRecipient;
        defaultFeeBps = newFeeBps;
        launchFeeWei = newLaunchFeeWei;
        defaultVirtualEthReserve = newVirtualEthReserve;
        defaultVirtualTokenReserve = newVirtualTokenReserve;
        defaultGraduationTargetEth = newGraduationTargetEth;
        defaultDexRouter = newDexRouter;
        defaultLpRecipient = newLpRecipient;

        emit DefaultsUpdated(
            newFeeRecipient,
            newPlatformFeeRecipient,
            newFeeBps,
            newLaunchFeeWei,
            newVirtualEthReserve,
            newVirtualTokenReserve,
            newGraduationTargetEth,
            newDexRouter,
            newLpRecipient
        );
    }

    function createLaunch(
        string calldata name,
        string calldata symbol,
        string calldata imageURI,
        string calldata description,
        uint256 totalSupply,
        uint256 creatorAllocationBps
    ) external payable returns (uint256 launchId, address tokenAddress, address poolAddress) {
        require(msg.value == launchFeeWei, "launch fee mismatch");
        _collectLaunchFee();
        (launchId, tokenAddress, poolAddress) = _createLaunch(
            name,
            symbol,
            imageURI,
            description,
            totalSupply,
            creatorAllocationBps,
            0,
            false
        );
    }

    /// @notice Klik-style launch: deploy and migrate directly to Uniswap using provided ETH.
    function createLaunchInstant(
        string calldata name,
        string calldata symbol,
        string calldata imageURI,
        string calldata description,
        uint256 totalSupply,
        uint256 creatorAllocationBps
    ) external payable returns (uint256 launchId, address tokenAddress, address poolAddress) {
        require(defaultDexRouter != address(0), "dex router not set");
        require(defaultLpRecipient != address(0), "lp recipient not set");
        require(msg.value > launchFeeWei, "insufficient eth for fee+liquidity");

        uint256 initialLiquidity = msg.value - launchFeeWei;
        _collectLaunchFee();

        emit InstantLaunchRequested(msg.sender, initialLiquidity);

        (launchId, tokenAddress, poolAddress) = _createLaunch(
            name,
            symbol,
            imageURI,
            description,
            totalSupply,
            creatorAllocationBps,
            initialLiquidity,
            true
        );
    }

    function _createLaunch(
        string calldata name,
        string calldata symbol,
        string calldata imageURI,
        string calldata description,
        uint256 totalSupply,
        uint256 creatorAllocationBps,
        uint256 initialEthLiquidity,
        bool graduateNow
    ) internal returns (uint256 launchId, address tokenAddress, address poolAddress) {
        require(bytes(name).length > 0, "name required");
        require(bytes(symbol).length > 0, "symbol required");
        require(totalSupply > 0, "supply required");
        require(creatorAllocationBps <= 2_000, "allocation too high");

        MemeToken token = new MemeToken(name, symbol, totalSupply, address(this), msg.sender, platformFeeRecipient);
        MemePool pool = new MemePool{value: initialEthLiquidity}(
            address(token),
            address(this),
            feeRecipient,
            defaultFeeBps,
            defaultVirtualEthReserve,
            defaultVirtualTokenReserve,
            defaultGraduationTargetEth,
            defaultDexRouter,
            defaultLpRecipient
        );

        uint256 creatorAllocation = (totalSupply * creatorAllocationBps) / BPS_DENOMINATOR;
        uint256 poolAllocation = totalSupply - creatorAllocation;

        require(token.transfer(address(pool), poolAllocation), "pool transfer failed");

        if (creatorAllocation > 0) {
            require(token.transfer(msg.sender, creatorAllocation), "creator transfer failed");
        }

        pool.seed(poolAllocation);
        if (graduateNow) {
            pool.graduateNow();
            address pair = pool.migratedPair();
            if (pair != address(0)) {
                token.setDexPair(pair);
            }
        }

        tokenAddress = address(token);
        poolAddress = address(pool);

        poolByToken[tokenAddress] = poolAddress;

        launchId = launches.length;
        launches.push();

        LaunchInfo storage info = launches[launchId];
        info.token = tokenAddress;
        info.pool = poolAddress;
        info.creator = msg.sender;
        info.name = name;
        info.symbol = symbol;
        info.imageURI = imageURI;
        info.description = description;
        info.totalSupply = totalSupply;
        info.creatorAllocation = creatorAllocation;
        info.createdAt = block.timestamp;

        emit LaunchCreated(
            launchId,
            msg.sender,
            tokenAddress,
            poolAddress,
            totalSupply,
            creatorAllocation,
            defaultFeeBps,
            defaultGraduationTargetEth,
            defaultDexRouter,
            defaultLpRecipient
        );
    }

    function getLaunchCount() external view returns (uint256) {
        return launches.length;
    }

    function getLaunch(uint256 launchId) external view returns (LaunchInfo memory) {
        require(launchId < launches.length, "invalid launch id");
        return launches[launchId];
    }

    function getLaunches(uint256 offset, uint256 limit) external view returns (LaunchInfo[] memory data) {
        uint256 total = launches.length;
        if (offset >= total) {
            return new LaunchInfo[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        data = new LaunchInfo[](end - offset);
        uint256 cursor = 0;

        for (uint256 i = offset; i < end; i++) {
            data[cursor] = launches[i];
            cursor++;
        }
    }

    function _collectLaunchFee() internal {
        require(msg.value >= launchFeeWei, "insufficient launch fee");
        if (launchFeeWei == 0) {
            return;
        }
        (bool sent, ) = platformFeeRecipient.call{value: launchFeeWei}("");
        require(sent, "launch fee transfer failed");
        emit LaunchFeePaid(msg.sender, platformFeeRecipient, launchFeeWei);
    }
}
