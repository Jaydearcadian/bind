// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BindSettlement.sol";

contract BindSettlementTest is Test {
    BindSettlement public settlement;
    address public owner;
    address public depositor;
    address public supplier;
    address public contractor;
    address public nonWhitelistedVendor;

    function setUp() public {
        owner = address(this);
        depositor = address(0x1111);
        supplier = address(0x2222);
        contractor = address(0x3333);
        nonWhitelistedVendor = address(0x4444);

        vm.deal(depositor, 1000 ether);
        settlement = new BindSettlement();
    }

    function test_DepositAndReleaseEscrow() public {
        bytes32 commitmentId = keccak256("commitment_001");
        bytes32 matchHash = keccak256("po_receipt_bill_match");
        uint256 depositAmount = 1 ether; // 1 USDC

        vm.prank(depositor);
        settlement.depositEscrow{value: depositAmount}(commitmentId, contractor, matchHash);

        BindSettlement.Escrow memory esc = settlement.getEscrow(commitmentId);
        assertEq(esc.depositor, depositor);
        assertEq(esc.recipient, contractor);
        assertEq(esc.amount, depositAmount);
        assertEq(esc.matchHash, matchHash);
        assertFalse(esc.released);
        assertFalse(esc.refunded);

        uint256 contractorBalBefore = contractor.balance;

        // Release by depositor
        vm.prank(depositor);
        settlement.releaseEscrow(commitmentId);

        BindSettlement.Escrow memory escAfter = settlement.getEscrow(commitmentId);
        assertTrue(escAfter.released);
        assertEq(contractor.balance, contractorBalBefore + depositAmount);
    }

    function test_RefundEscrow() public {
        bytes32 commitmentId = keccak256("commitment_refund");
        bytes32 matchHash = keccak256("rejected_order");
        uint256 depositAmount = 2 ether;

        vm.prank(depositor);
        settlement.depositEscrow{value: depositAmount}(commitmentId, supplier, matchHash);

        uint256 depositorBalBefore = depositor.balance;

        // Refund escrow back to depositor
        vm.prank(depositor);
        settlement.refundEscrow(commitmentId);

        BindSettlement.Escrow memory esc = settlement.getEscrow(commitmentId);
        assertTrue(esc.refunded);
        assertEq(depositor.balance, depositorBalBefore + depositAmount);
    }

    function test_DirectOrderSettlement() public {
        bytes32 orderId = keccak256("order_po_42");
        bytes32 matchHash = keccak256("three_way_match_verified");
        uint256 orderAmount = 0.5 ether;

        uint256 supplierBalBefore = supplier.balance;

        vm.prank(depositor);
        settlement.settleOrder{value: orderAmount}(orderId, supplier, matchHash);

        assertTrue(settlement.settledOrders(orderId));
        assertEq(supplier.balance, supplierBalBefore + orderAmount);

        // Cannot settle duplicate order
        vm.expectRevert(BindSettlement.OrderAlreadySettled.selector);
        vm.prank(depositor);
        settlement.settleOrder{value: orderAmount}(orderId, supplier, matchHash);
    }

    // Policy Test: Daily spend limit enforcement & revert
    function test_DailySpendLimit_RevertWhenExceeded() public {
        uint256 limit = 10 ether;
        settlement.setDailyLimit(limit);
        assertEq(settlement.dailySpendLimit(), limit);

        bytes32 orderId1 = keccak256("order_daily_1");
        bytes32 orderId2 = keccak256("order_daily_2");
        bytes32 matchHash = keccak256("match_hash");

        // First order within limit (6 ether)
        vm.prank(depositor);
        settlement.settleOrder{value: 6 ether}(orderId1, supplier, matchHash);
        assertEq(settlement.dailySpent(), 6 ether);

        // Second order exceeds daily limit (6 + 5 = 11 > 10)
        vm.expectRevert(abi.encodeWithSelector(BindSettlement.DailyLimitExceeded.selector, 11 ether, 10 ether));
        vm.prank(depositor);
        settlement.settleOrder{value: 5 ether}(orderId2, supplier, matchHash);
    }

    // Policy Test: Daily spend limit 24h rolling reset
    function test_DailySpendLimit_ResetsAfter24Hours() public {
        uint256 limit = 10 ether;
        settlement.setDailyLimit(limit);

        bytes32 orderId1 = keccak256("order_day1");
        bytes32 orderId2 = keccak256("order_day2");
        bytes32 matchHash = keccak256("match_hash");

        // Exhaust daily limit
        vm.prank(depositor);
        settlement.settleOrder{value: 10 ether}(orderId1, supplier, matchHash);
        assertEq(settlement.dailySpent(), 10 ether);

        // Warp time forward by 1 day + 1 second
        vm.warp(block.timestamp + 1 days + 1);

        // Now next day's settlement should reset dailySpent and succeed
        vm.prank(depositor);
        settlement.settleOrder{value: 5 ether}(orderId2, supplier, matchHash);
        assertEq(settlement.dailySpent(), 5 ether);
    }

    // Policy Test: Refund restores daily spent budget
    function test_RefundRestoresDailyBudget() public {
        settlement.setDailyLimit(5 ether);

        bytes32 commitmentId = keccak256("commit_restore");
        bytes32 matchHash = keccak256("match_restore");

        vm.prank(depositor);
        settlement.depositEscrow{value: 4 ether}(commitmentId, supplier, matchHash);
        assertEq(settlement.dailySpent(), 4 ether);

        // Refund escrow
        vm.prank(depositor);
        settlement.refundEscrow(commitmentId);
        assertEq(settlement.dailySpent(), 0);
    }

    // Policy Test: Vendor Whitelist Enforcement
    function test_VendorWhitelist_Enforcement() public {
        settlement.setEnforceVendorWhitelist(true);
        assertTrue(settlement.enforceVendorWhitelist());

        bytes32 orderId = keccak256("order_vendor_check");
        bytes32 commitmentId = keccak256("commit_vendor_check");
        bytes32 matchHash = keccak256("match_vendor");

        // Attempting to settle with non-whitelisted vendor reverts
        vm.expectRevert(abi.encodeWithSelector(BindSettlement.VendorNotWhitelisted.selector, nonWhitelistedVendor));
        vm.prank(depositor);
        settlement.settleOrder{value: 1 ether}(orderId, nonWhitelistedVendor, matchHash);

        // Attempting to deposit escrow for non-whitelisted vendor reverts
        vm.expectRevert(abi.encodeWithSelector(BindSettlement.VendorNotWhitelisted.selector, nonWhitelistedVendor));
        vm.prank(depositor);
        settlement.depositEscrow{value: 1 ether}(commitmentId, nonWhitelistedVendor, matchHash);

        // Owner whitelists the vendor
        settlement.setVendorStatus(nonWhitelistedVendor, true);
        assertTrue(settlement.whitelistedVendors(nonWhitelistedVendor));

        // Now settlement succeeds
        vm.prank(depositor);
        settlement.settleOrder{value: 1 ether}(orderId, nonWhitelistedVendor, matchHash);
        assertTrue(settlement.settledOrders(orderId));
    }

    // Access Control Test: Only owner can update policy configurations
    function test_PolicyAdmin_OnlyOwner() public {
        address attacker = address(0x9999);

        vm.prank(attacker);
        vm.expectRevert(BindSettlement.Unauthorized.selector);
        settlement.setDailyLimit(100 ether);

        vm.prank(attacker);
        vm.expectRevert(BindSettlement.Unauthorized.selector);
        settlement.setVendorStatus(supplier, true);

        vm.prank(attacker);
        vm.expectRevert(BindSettlement.Unauthorized.selector);
        settlement.setEnforceVendorWhitelist(true);

        // Owner setting vendor address(0) reverts
        vm.expectRevert(BindSettlement.Unauthorized.selector);
        settlement.setVendorStatus(address(0), true);
    }

    // Fuzz Testing: Deposit amount invariant
    function testFuzz_DepositAndRelease(uint96 amount) public {
        vm.assume(amount > 0 && amount < 50 ether);
        bytes32 commitmentId = keccak256(abi.encodePacked("fuzz_commit", amount));
        bytes32 matchHash = keccak256("fuzz_match");

        vm.prank(depositor);
        settlement.depositEscrow{value: amount}(commitmentId, contractor, matchHash);

        uint256 contractorBefore = contractor.balance;

        vm.prank(depositor);
        settlement.releaseEscrow(commitmentId);

        assertEq(contractor.balance - contractorBefore, amount);
    }

    // Adversarial: Unauthorized caller cannot release or refund
    function test_UnauthorizedCallerCannotRelease() public {
        bytes32 commitmentId = keccak256("adversarial_test");
        bytes32 matchHash = keccak256("adversarial_match");

        vm.prank(depositor);
        settlement.depositEscrow{value: 1 ether}(commitmentId, contractor, matchHash);

        address attacker = address(0x9999);
        vm.prank(attacker);
        vm.expectRevert(BindSettlement.Unauthorized.selector);
        settlement.releaseEscrow(commitmentId);
    }
}
