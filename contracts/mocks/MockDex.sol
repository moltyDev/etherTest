// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract MockDexPair {
    address public immutable token;
    address public immutable weth;

    uint256 public tokenLiquidity;
    uint256 public ethLiquidity;

    address public immutable router;

    constructor(address _token, address _weth, address _router) {
        token = _token;
        weth = _weth;
        router = _router;
    }

    function notifyTokenLiquidity(uint256 tokenAmount) external {
        require(msg.sender == router, "only router");
        tokenLiquidity += tokenAmount;
    }

    receive() external payable {
        require(msg.sender == router, "only router");
        ethLiquidity += msg.value;
    }
}

contract MockDexFactory {
    mapping(address => mapping(address => address)) public getPair;

    event PairCreated(address indexed token0, address indexed token1, address pair);

    function createPair(address tokenA, address tokenB, address router) public returns (address pair) {
        require(tokenA != tokenB, "identical");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "zero");
        require(getPair[token0][token1] == address(0), "exists");

        pair = address(new MockDexPair(token0, token1, router));
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;

        emit PairCreated(token0, token1, pair);
    }
}

contract MockDexRouter {
    address public immutable WETH;
    address public immutable factory;

    constructor(address _weth) {
        require(_weth != address(0), "weth required");
        WETH = _weth;
        factory = address(new MockDexFactory());
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        address pair = MockDexFactory(factory).getPair(token, WETH);
        if (pair == address(0)) {
            pair = MockDexFactory(factory).createPair(token, WETH, address(this));
        }

        bool ok = IERC20Like(token).transferFrom(msg.sender, pair, amountTokenDesired);
        require(ok, "token transfer failed");

        MockDexPair(payable(pair)).notifyTokenLiquidity(amountTokenDesired);

        (bool sentEth, ) = pair.call{value: msg.value}("");
        require(sentEth, "eth transfer failed");

        amountToken = amountTokenDesired;
        amountETH = msg.value;

        uint256 minAmount = amountToken < amountETH ? amountToken : amountETH;
        liquidity = minAmount;
    }
}