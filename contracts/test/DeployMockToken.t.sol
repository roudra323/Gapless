// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {DeployMockToken} from "../script/DeployMockToken.s.sol";
import {MockToken} from "../src/MockToken.sol";

contract DeployMockTokenTest is Test {
    DeployMockToken internal script;

    function setUp() public {
        script = new DeployMockToken();
    }

    // In a test, a bare vm.startBroadcast() signs as the test's caller, the same way --private-key picks the
    // signer in a real run. (vm.prank can't set it: Foundry rejects pranks combined with broadcasts.)
    function test_DeploysTokenOwnedByBroadcaster() public {
        (MockToken token,) = script.run();

        assertEq(token.owner(), msg.sender);
        assertEq(token.name(), "Gapless Mock Token");
        assertEq(token.totalSupply(), 0);
    }

    // The deploy transaction is mined in a block after the current one, so the next block is the earliest
    // one that can hold it. On a fresh chain (block 0) this gives 1, never the genesis block.
    function test_StartBlockIsTheNextBlock() public {
        (, uint256 startBlock) = script.run();

        assertEq(startBlock, block.number + 1);
    }

    function test_StartBlockIsOneOnAFreshChain() public {
        vm.roll(0);
        (, uint256 startBlock) = script.run();

        assertEq(startBlock, 1);
    }

    function test_BroadcasterCanMintAfterDeploy() public {
        (MockToken token,) = script.run();

        vm.prank(msg.sender);
        token.mint(msg.sender, 1 ether);
        assertEq(token.balanceOf(msg.sender), 1 ether);
    }
}
