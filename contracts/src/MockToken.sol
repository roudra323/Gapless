// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin-contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin-contracts/access/Ownable.sol";

/// @title MockToken
/// @notice Plain ERC-20 whose `Transfer` events feed the Gapless indexer.
/// @dev No initial supply. The owner mints on demand (deploy and spam scripts).
///      Mints emit `Transfer` from the zero address, which the indexer stores like any other transfer.
contract MockToken is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Gapless Mock Token", "GMT") Ownable(initialOwner) {}

    /// @notice Mints `amount` tokens to `to`. Only the owner can call it.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
