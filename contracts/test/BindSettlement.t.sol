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

    function setUp() public {
        owner = address(this);
        depositor = address(0x1111);
        supplier = address(0x2222);
        contractor = address(0x3333);

        vm.deal(depositor, 100 ether);
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
