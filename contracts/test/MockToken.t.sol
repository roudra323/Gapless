// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin-contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin-contracts/access/Ownable.sol";
import {MockToken} from "../src/MockToken.sol";

contract MockTokenTest is Test {
    MockToken internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new MockToken(owner);
    }

    function test_Metadata() public view {
        assertEq(token.name(), "Gapless Mock Token");
        assertEq(token.symbol(), "GMT");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 0);
        assertEq(token.owner(), owner);
    }

    function test_RevertWhen_InitialOwnerIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MockToken(address(0));
    }

    function test_OwnerCanMint() public {
        vm.prank(owner);
        token.mint(alice, 100 ether);

        assertEq(token.balanceOf(alice), 100 ether);
        assertEq(token.totalSupply(), 100 ether);
    }

    // The indexer stores mints as transfers from the zero address.
    function test_MintEmitsTransferFromZeroAddress() public {
        vm.expectEmit(address(token));
        emit IERC20.Transfer(address(0), alice, 1 ether);

        vm.prank(owner);
        token.mint(alice, 1 ether);
    }

    function test_RevertWhen_NonOwnerMints() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        token.mint(alice, 1 ether);
    }

    function test_TransferMovesBalanceAndEmitsEvent() public {
        vm.prank(owner);
        token.mint(alice, 10 ether);

        vm.expectEmit(address(token));
        emit IERC20.Transfer(alice, bob, 3 ether);

        vm.prank(alice);
        assertTrue(token.transfer(bob, 3 ether));

        assertEq(token.balanceOf(alice), 7 ether);
        assertEq(token.balanceOf(bob), 3 ether);
    }

    function test_RevertWhen_TransferExceedsBalance() public {
        vm.prank(owner);
        token.mint(alice, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 1 ether, 2 ether));
        vm.prank(alice);
        token.transfer(bob, 2 ether);
    }

    function testFuzz_MintThenTransfer(uint256 minted, uint256 sent) public {
        sent = bound(sent, 0, minted);

        vm.prank(owner);
        token.mint(alice, minted);

        vm.prank(alice);
        assertTrue(token.transfer(bob, sent));

        assertEq(token.balanceOf(alice), minted - sent);
        assertEq(token.balanceOf(bob), sent);
        assertEq(token.totalSupply(), minted);
    }
}
