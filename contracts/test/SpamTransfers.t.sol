// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SpamTransfers} from "../script/SpamTransfers.s.sol";
import {MockToken} from "../src/MockToken.sol";

contract SpamTransfersTest is Test {
    SpamTransfers internal script;
    MockToken internal token;

    function setUp() public {
        script = new SpamTransfers();
        // The test's caller is the default broadcaster (see DeployMockToken.t.sol), so it must own the token.
        token = new MockToken(msg.sender);
    }

    function test_EmitsOneMintAndExactlyNTransfers() public {
        vm.recordLogs();
        script.spam(token, 25, 4);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 mints;
        uint256 transfers;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(token) || logs[i].topics[0] != IERC20.Transfer.selector) continue;
            address from = address(uint160(uint256(logs[i].topics[1])));
            if (from == address(0)) ++mints;
            else if (from == msg.sender) ++transfers;
        }
        assertEq(mints, 1);
        assertEq(transfers, 25);
    }

    function test_RecipientsReceiveEveryAmountAndSignerKeepsNothing() public {
        uint256 count = 30;
        uint256 recipientCount = 7;
        script.spam(token, count, recipientCount);

        uint256 expectedTotal;
        uint256 received;
        for (uint256 i; i < count; ++i) {
            expectedTotal += script.amountAt(i);
        }
        for (uint256 r; r < recipientCount; ++r) {
            uint256 balance = token.balanceOf(script.recipientAt(r));
            assertGt(balance, 0, "every recipient in the rotation receives tokens");
            received += balance;
        }

        assertEq(received, expectedTotal);
        assertEq(token.totalSupply(), expectedTotal);
        assertEq(token.balanceOf(msg.sender), 0);
    }

    function test_RevertWhen_SignerIsNotOwner() public {
        address other = makeAddr("other");
        MockToken foreign = new MockToken(other);

        vm.expectRevert(abi.encodeWithSelector(SpamTransfers.SpamTransfers__NotOwner.selector, msg.sender, other));
        script.spam(foreign, 5, 2);
    }

    function test_RevertWhen_CountIsZero() public {
        vm.expectRevert(SpamTransfers.SpamTransfers__ZeroCount.selector);
        script.spam(token, 0, 2);

        vm.expectRevert(SpamTransfers.SpamTransfers__ZeroCount.selector);
        script.spam(token, 5, 0);
    }

    function test_RunReadsSettingsFromEnv() public {
        vm.setEnv("TOKEN_ADDRESS", vm.toString(address(token)));
        vm.setEnv("TRANSFER_COUNT", "12");
        vm.setEnv("RECIPIENT_COUNT", "3");

        script.run();

        uint256 expectedTotal;
        for (uint256 i; i < 12; ++i) {
            expectedTotal += script.amountAt(i);
        }
        assertEq(token.totalSupply(), expectedTotal);
        assertGt(token.balanceOf(script.recipientAt(2)), 0);
        assertEq(token.balanceOf(script.recipientAt(3)), 0, "only RECIPIENT_COUNT recipients are used");
    }

    function testFuzz_AmountsStayInRange(uint256 i) public view {
        uint256 amount = script.amountAt(i);
        assertGe(amount, 0.001 ether);
        assertLe(amount, 1 ether);
    }
}
