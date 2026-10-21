// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {MockToken} from "../src/MockToken.sol";

/// @notice Deploys MockToken. The broadcasting account becomes the owner, so the same key can mint later.
/// @dev Usage (anvil): forge script script/DeployMockToken.s.sol:DeployMockToken \
///        --rpc-url http://localhost:8545 --broadcast --private-key <anvil account 0 key>
///      On a public chain, sign with a keystore (`--account <name>`), never a raw key.
contract DeployMockToken is Script {
    function run() external returns (MockToken token) {
        // Read before deploying: the deploy transaction lands in this block or a later one, so this is a
        // safe START_BLOCK for the indexer (never after the first Transfer event; see docs/03 "No gaps").
        uint256 startBlock = block.number;

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        token = new MockToken(deployer);
        vm.stopBroadcast();

        console2.log("TOKEN_ADDRESS=%s", address(token));
        console2.log("START_BLOCK=%s", startBlock);
        console2.log("owner=%s", deployer);
    }
}
