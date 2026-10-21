// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {MockToken} from "../src/MockToken.sol";

/// @notice Generates `Transfer` events for the indexer: one mint to the signer, then TRANSFER_COUNT transfers
///         rotating over RECIPIENT_COUNT fixed addresses.
/// @dev Only the signer needs a key and gas, so the same script works on anvil and on a public testnet.
///      Usage (anvil): TOKEN_ADDRESS=0x... TRANSFER_COUNT=500 forge script script/SpamTransfers.s.sol:SpamTransfers \
///        --rpc-url http://localhost:8545 --broadcast --slow --private-key <owner key>
///      --slow waits for each receipt before sending the next transaction. Without it, anvil packs many transfers
///      into a few blocks; with it, each transfer gets its own block, which exercises the indexer's range handling.
contract SpamTransfers is Script {
    error SpamTransfers__NotOwner(address signer, address owner);
    error SpamTransfers__ZeroCount();

    uint256 internal constant DEFAULT_TRANSFER_COUNT = 100;
    uint256 internal constant DEFAULT_RECIPIENT_COUNT = 10;

    function run() external {
        MockToken token = MockToken(vm.envAddress("TOKEN_ADDRESS"));
        uint256 transferCount = vm.envOr("TRANSFER_COUNT", DEFAULT_TRANSFER_COUNT);
        uint256 recipientCount = vm.envOr("RECIPIENT_COUNT", DEFAULT_RECIPIENT_COUNT);

        spam(token, transferCount, recipientCount);
    }

    function spam(MockToken token, uint256 transferCount, uint256 recipientCount) public {
        if (transferCount == 0 || recipientCount == 0) revert SpamTransfers__ZeroCount();

        uint256 total;
        for (uint256 i; i < transferCount; ++i) {
            total += amountAt(i);
        }

        vm.startBroadcast();
        (, address signer,) = vm.readCallers();
        // Fail before sending anything, instead of broadcasting a mint that reverts on-chain.
        if (token.owner() != signer) revert SpamTransfers__NotOwner(signer, token.owner());

        token.mint(signer, total);
        for (uint256 i; i < transferCount; ++i) {
            token.transfer(recipientAt(i % recipientCount), amountAt(i));
        }
        vm.stopBroadcast();

        console2.log("minted=%s transfers=%s recipients=%s", total, transferCount, recipientCount);
    }

    /// @notice The i-th fixed recipient. Derived from a seed, so no key exists for it and runs are repeatable.
    function recipientAt(uint256 i) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("gapless.recipient", i)))));
    }

    /// @notice The i-th amount: between 0.001 and 1 token, varied so rows are distinguishable.
    function amountAt(uint256 i) public pure returns (uint256) {
        return (uint256(keccak256(abi.encode("gapless.amount", i))) % 1000 + 1) * 1e15;
    }
}
