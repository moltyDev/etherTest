// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV2RouterLike {
    function WETH() external view returns (address);
    function factory() external view returns (address);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IUniswapV2FactoryLike {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

/// @title MemePool
/// @notice Bonding-curve pool that auto-migrates liquidity to DEX at graduation threshold.
contract MemePool {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public immutable factory;
    address public immutable token;
    address public feeRecipient;

    uint256 public feeBps;
    uint256 public ethReserve;
    uint256 public tokenReserve;
    uint256 public immutable virtualEthReserve;
    uint256 public immutable virtualTokenReserve;

    // Graduation / migration config
    uint256 public graduationTargetEth;
    address public dexRouter;
    address public lpRecipient;

    bool public seeded;
    bool public graduated;
    bool private locked;

    address public migratedPair;
    uint256 public graduatedAt;

    event PoolSeeded(uint256 tokenLiquidity);
    event Buy(address indexed buyer, uint256 ethIn, uint256 feePaid, uint256 tokensOut);
    event Sell(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 feePaid);
    event FeeConfigUpdated(address indexed recipient, uint256 feeBps);
    event MigrationConfigUpdated(address dexRouter, address lpRecipient, uint256 graduationTargetEth);
    event Graduated(
        address indexed pair,
        uint256 tokenMigrated,
        uint256 ethMigrated,
        uint256 lpMinted,
        uint256 timestamp
    );
    event InstantGraduationTriggered(address indexed caller, uint256 ethReserve, uint256 tokenReserve);

    modifier onlyFactory() {
        require(msg.sender == factory, "only factory");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "reentrancy");
        locked = true;
        _;
        locked = false;
    }

    constructor(
        address _token,
        address _factory,
        address _feeRecipient,
        uint256 _feeBps,
        uint256 _virtualEthReserve,
        uint256 _virtualTokenReserve,
        uint256 _graduationTargetEth,
        address _dexRouter,
        address _lpRecipient
    ) payable {
        require(_token != address(0), "token required");
        require(_factory != address(0), "factory required");
        require(_feeRecipient != address(0), "fee recipient required");
        require(_feeBps <= 300, "fee too high");
        require(_virtualEthReserve > 0, "virtual eth required");
        require(_virtualTokenReserve > 0, "virtual token required");
        require(_graduationTargetEth > 0, "target required");

        if (_dexRouter != address(0)) {
            require(_lpRecipient != address(0), "lp recipient required");
        }

        token = _token;
        factory = _factory;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        virtualEthReserve = _virtualEthReserve;
        virtualTokenReserve = _virtualTokenReserve;

        graduationTargetEth = _graduationTargetEth;
        dexRouter = _dexRouter;
        lpRecipient = _lpRecipient;
        ethReserve = msg.value;
    }

    function seed(uint256 tokenAmount) external onlyFactory {
        require(!seeded, "already seeded");
        require(tokenAmount > 0, "token amount required");
        require(IERC20(token).balanceOf(address(this)) >= tokenAmount, "insufficient tokens");

        seeded = true;
        tokenReserve = tokenAmount;

        emit PoolSeeded(tokenAmount);
    }

    function configureFees(address newRecipient, uint256 newFeeBps) external onlyFactory {
        require(newRecipient != address(0), "recipient required");
        require(newFeeBps <= 300, "fee too high");

        feeRecipient = newRecipient;
        feeBps = newFeeBps;

        emit FeeConfigUpdated(newRecipient, newFeeBps);
    }

    function configureMigration(address newDexRouter, address newLpRecipient, uint256 newTargetEth) external onlyFactory {
        require(!graduated, "already graduated");
        require(newTargetEth > 0, "target required");

        if (newDexRouter != address(0)) {
            require(newLpRecipient != address(0), "lp recipient required");
        }

        dexRouter = newDexRouter;
        lpRecipient = newLpRecipient;
        graduationTargetEth = newTargetEth;

        emit MigrationConfigUpdated(newDexRouter, newLpRecipient, newTargetEth);
    }

    function buy(uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        require(seeded, "pool not seeded");
        require(!graduated, "graduated");
        require(msg.value > 0, "eth required");

        uint256 feePaid = (msg.value * feeBps) / BPS_DENOMINATOR;
        uint256 netEthIn = msg.value - feePaid;
        tokensOut = _getBuyQuoteFromNetEth(netEthIn);

        require(tokensOut > 0, "insufficient output");
        require(tokensOut >= minTokensOut, "slippage");
        require(tokensOut <= tokenReserve, "insufficient liquidity");

        ethReserve += netEthIn;
        tokenReserve -= tokensOut;

        if (feePaid > 0) {
            (bool feeOk, ) = feeRecipient.call{value: feePaid}("");
            require(feeOk, "fee transfer failed");
        }

        bool transferred = IERC20(token).transfer(msg.sender, tokensOut);
        require(transferred, "token transfer failed");

        emit Buy(msg.sender, msg.value, feePaid, tokensOut);

        _tryAutoGraduate();
    }

    function sell(uint256 tokenAmountIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        require(seeded, "pool not seeded");
        require(!graduated, "graduated");
        require(tokenAmountIn > 0, "token amount required");

        uint256 grossEthOut = _getSellQuoteGross(tokenAmountIn);
        require(grossEthOut > 0, "insufficient output");
        require(grossEthOut <= ethReserve, "insufficient eth reserve");

        uint256 feePaid = (grossEthOut * feeBps) / BPS_DENOMINATOR;
        ethOut = grossEthOut - feePaid;

        require(ethOut >= minEthOut, "slippage");

        bool pulled = IERC20(token).transferFrom(msg.sender, address(this), tokenAmountIn);
        require(pulled, "token transfer failed");

        tokenReserve += tokenAmountIn;
        ethReserve -= grossEthOut;

        (bool sentToSeller, ) = msg.sender.call{value: ethOut}("");
        require(sentToSeller, "eth transfer failed");

        if (feePaid > 0) {
            (bool sentFee, ) = feeRecipient.call{value: feePaid}("");
            require(sentFee, "fee transfer failed");
        }

        emit Sell(msg.sender, tokenAmountIn, ethOut, feePaid);
    }

    /// @notice Allows anyone to trigger migration if target is reached.
    function triggerGraduation() external nonReentrant {
        require(seeded, "pool not seeded");
        require(!graduated, "already graduated");
        require(ethReserve >= graduationTargetEth, "target not reached");

        _graduateToDex();
    }

    /// @notice Factory-only path to skip bonding curve and migrate immediately to DEX.
    function graduateNow() external onlyFactory nonReentrant {
        require(seeded, "pool not seeded");
        require(!graduated, "already graduated");
        require(ethReserve > 0, "no eth reserve");

        emit InstantGraduationTriggered(msg.sender, ethReserve, tokenReserve);
        _graduateToDex();
    }

    function quoteBuy(uint256 ethAmountIn) external view returns (uint256 tokensOut, uint256 feePaid) {
        if (!seeded || graduated || ethAmountIn == 0) {
            return (0, 0);
        }

        feePaid = (ethAmountIn * feeBps) / BPS_DENOMINATOR;
        uint256 netEth = ethAmountIn - feePaid;
        tokensOut = _getBuyQuoteFromNetEth(netEth);
    }

    function quoteSell(uint256 tokenAmountIn) external view returns (uint256 ethOut, uint256 feePaid) {
        if (!seeded || graduated || tokenAmountIn == 0) {
            return (0, 0);
        }

        uint256 grossEthOut = _getSellQuoteGross(tokenAmountIn);
        if (grossEthOut == 0) {
            return (0, 0);
        }

        feePaid = (grossEthOut * feeBps) / BPS_DENOMINATOR;
        ethOut = grossEthOut - feePaid;
    }

    /// @notice Spot ETH/token price scaled by 1e18.
    function spotPrice() external view returns (uint256) {
        uint256 y = tokenReserve + virtualTokenReserve;
        if (y == 0) {
            return 0;
        }

        uint256 x = ethReserve + virtualEthReserve;
        return (x * 1e18) / y;
    }

    function targetProgressBps() external view returns (uint256) {
        if (graduationTargetEth == 0) {
            return 0;
        }

        uint256 progress = (ethReserve * BPS_DENOMINATOR) / graduationTargetEth;
        if (progress > BPS_DENOMINATOR) {
            return BPS_DENOMINATOR;
        }

        return progress;
    }

    function _tryAutoGraduate() internal {
        if (graduated) {
            return;
        }

        if (ethReserve < graduationTargetEth) {
            return;
        }

        _graduateToDex();
    }

    function _graduateToDex() internal {
        require(dexRouter != address(0), "dex router not set");

        graduated = true;
        graduatedAt = block.timestamp;

        uint256 tokensToMigrate = tokenReserve;
        uint256 ethToMigrate = ethReserve;

        tokenReserve = 0;
        ethReserve = 0;

        IERC20(token).approve(dexRouter, 0);
        IERC20(token).approve(dexRouter, tokensToMigrate);

        (uint256 tokenUsed, uint256 ethUsed, uint256 lpMinted) = IUniswapV2RouterLike(dexRouter).addLiquidityETH{
            value: ethToMigrate
        }(token, tokensToMigrate, 0, 0, lpRecipient, block.timestamp + 1 hours);

        address pair = IUniswapV2FactoryLike(IUniswapV2RouterLike(dexRouter).factory()).getPair(
            token,
            IUniswapV2RouterLike(dexRouter).WETH()
        );
        migratedPair = pair;

        if (tokensToMigrate > tokenUsed) {
            uint256 tokenDust = tokensToMigrate - tokenUsed;
            bool sentTokenDust = IERC20(token).transfer(feeRecipient, tokenDust);
            require(sentTokenDust, "token dust transfer failed");
        }

        if (ethToMigrate > ethUsed) {
            uint256 ethDust = ethToMigrate - ethUsed;
            (bool sentEthDust, ) = feeRecipient.call{value: ethDust}("");
            require(sentEthDust, "eth dust transfer failed");
        }

        emit Graduated(pair, tokenUsed, ethUsed, lpMinted, block.timestamp);
    }

    function _getBuyQuoteFromNetEth(uint256 netEthIn) internal view returns (uint256) {
        if (netEthIn == 0) {
            return 0;
        }

        uint256 x = ethReserve + virtualEthReserve;
        uint256 y = tokenReserve + virtualTokenReserve;
        uint256 k = x * y;

        uint256 newX = x + netEthIn;
        uint256 newY = k / newX;

        if (y <= newY) {
            return 0;
        }

        uint256 tokensOut = y - newY;
        if (tokensOut > tokenReserve) {
            return tokenReserve;
        }

        return tokensOut;
    }

    function _getSellQuoteGross(uint256 tokenAmountIn) internal view returns (uint256) {
        uint256 x = ethReserve + virtualEthReserve;
        uint256 y = tokenReserve + virtualTokenReserve;
        uint256 k = x * y;

        uint256 newY = y + tokenAmountIn;
        uint256 newX = k / newY;

        if (x <= newX) {
            return 0;
        }

        uint256 grossEthOut = x - newX;
        if (grossEthOut > ethReserve) {
            return ethReserve;
        }

        return grossEthOut;
    }
}
