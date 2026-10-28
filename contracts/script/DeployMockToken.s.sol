// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {MockToken} from "../src/MockToken.sol";

/// @notice Deploys MockToken. The broadcasting account becomes the owner, so the same key can mint later.
/// @dev Usage (anvil): forge script script/DeployMockToken.s.sol:DeployMockToken \
///        --rpc-url http://localhost:8545 --broadcast --private-key <anvil account 0 key>
///      On a public chain, sign with a keystore (`--account <name>`), never a raw key.
contract DeployMockToken is Script {
    function run() external returns (MockToken token, uint256 startBlock) {
        // block.number is the latest mined block; the deploy transaction lands in the next block or a later
        // one. So block.number + 1 is a safe START_BLOCK (never after the first Transfer event; see docs/03
        // "No gaps"), and it is always >= 1, as docs/03 "Startup" requires.
        startBlock = block.number + 1;

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        token = new MockToken(deployer);
        vm.stopBroadcast();

        console2.log("TOKEN_ADDRESS=%s", address(token));
        console2.log("START_BLOCK=%s", startBlock);
        console2.log("owner=%s", deployer);
    }
}
