// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MemeToken
/// @notice Minimal ERC20 used by the meme launcher factory.
contract MemeToken {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant TRADE_FEE_BPS = 50; // 0.5%
    uint256 public constant CREATOR_FEE_BPS = 30; // 0.3%
    uint256 public constant PLATFORM_FEE_BPS = 20; // 0.2%

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable factory;
    address public immutable creator;
    address public immutable platformFeeRecipient;
    address public dexPair;
    bool public factoryControlRenounced;

    uint256 public creatorClaimable;
    uint256 public platformClaimable;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event DexPairSet(address indexed pair);
    event FactoryControlRenounced(address indexed byFactory);
    event TradeFeeAccrued(address indexed from, address indexed to, uint256 creatorFee, uint256 platformFee);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event PlatformFeesClaimed(address indexed recipient, uint256 amount);

    modifier onlyFactory() {
        require(msg.sender == factory, "only factory");
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        uint256 _totalSupply,
        address _factory,
        address _creator,
        address _platformFeeRecipient
    ) {
        require(bytes(_name).length > 0, "name required");
        require(bytes(_symbol).length > 0, "symbol required");
        require(_totalSupply > 0, "supply required");
        require(_factory != address(0), "factory required");
        require(_creator != address(0), "creator required");
        require(_platformFeeRecipient != address(0), "platform required");
        require(CREATOR_FEE_BPS + PLATFORM_FEE_BPS == TRADE_FEE_BPS, "invalid fee split");

        name = _name;
        symbol = _symbol;
        totalSupply = _totalSupply;
        factory = _factory;
        creator = _creator;
        platformFeeRecipient = _platformFeeRecipient;
        balanceOf[_factory] = _totalSupply;

        emit Transfer(address(0), _factory, _totalSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance exceeded");

        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }

        _transfer(from, to, amount);
        return true;
    }

    function setDexPair(address pair) external onlyFactory {
        require(pair != address(0), "pair required");
        require(!factoryControlRenounced, "factory control renounced");
        require(dexPair == address(0), "pair already set");
        dexPair = pair;
        emit DexPairSet(pair);
    }

    /// @notice Irreversibly removes any factory-level control hooks.
    function renounceFactoryControl() external onlyFactory {
        require(!factoryControlRenounced, "already renounced");
        factoryControlRenounced = true;
        emit FactoryControlRenounced(msg.sender);
    }

    function claimCreatorFees() external returns (uint256 amount) {
        require(msg.sender == creator, "only creator");
        amount = creatorClaimable;
        require(amount > 0, "nothing to claim");
        creatorClaimable = 0;
        _payout(address(this), creator, amount);
        emit CreatorFeesClaimed(creator, amount);
    }

    function claimPlatformFees() external returns (uint256 amount) {
        require(msg.sender == platformFeeRecipient, "only platform");
        amount = platformClaimable;
        require(amount > 0, "nothing to claim");
        platformClaimable = 0;
        _payout(address(this), platformFeeRecipient, amount);
        emit PlatformFeesClaimed(platformFeeRecipient, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "zero address");
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= amount, "balance too low");

        uint256 sendAmount = amount;
        if (_isDexTrade(from, to) && amount > 0) {
            uint256 feeAmount = (amount * TRADE_FEE_BPS) / BPS_DENOMINATOR;
            if (feeAmount > 0) {
                uint256 creatorFee = (amount * CREATOR_FEE_BPS) / BPS_DENOMINATOR;
                uint256 platformFee = feeAmount - creatorFee;
                sendAmount = amount - feeAmount;

                creatorClaimable += creatorFee;
                platformClaimable += platformFee;
                balanceOf[address(this)] += feeAmount;

                emit Transfer(from, address(this), feeAmount);
                emit TradeFeeAccrued(from, to, creatorFee, platformFee);
            }
        }

        balanceOf[from] = fromBalance - amount;
        balanceOf[to] += sendAmount;

        emit Transfer(from, to, sendAmount);
    }

    function _payout(address from, address to, uint256 amount) internal {
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= amount, "insufficient fee vault");
        balanceOf[from] = fromBalance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _isDexTrade(address from, address to) internal view returns (bool) {
        if (dexPair == address(0)) {
            return false;
        }
        return from == dexPair || to == dexPair;
    }
}
