// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// NOT_RUN under Forge (not installed in the authoring environment). This file was only compile-checked, with the pinned
// solc 0.8.37 in tools/compile-contract, against the vendored contracts/lib/forge-std. Nothing here is a pass until
// `cd contracts && forge test` has run it and the result is recorded in docs/RELEASE_EVIDENCE.md.
//
// Reentrancy against BindSettlement, using the ReentrantSupplier attacker (contracts/test/helpers). The same six modes
// are run by tests/integration/bind-settlement-reentrancy.test.ts on the in-process EVM, which is the executed evidence.

import "forge-std/Test.sol";
import "../src/BindSettlement.sol";
import "./helpers/ReentrantSupplier.sol";

contract BindSettlementReentrancyTest is Test {
    BindSettlement internal settlement;
    ReentrantSupplier internal attacker;

    bytes32 internal constant ORDER = keccak256("ord_reentry");
    bytes32 internal constant OTHER = keccak256("ord_other");
    bytes32 internal constant E0 = keccak256("escrow_0");
    bytes32 internal constant E1 = keccak256("escrow_1");
    bytes32 internal constant E_NEW = keccak256("escrow_new");
    bytes32 internal constant MATCH = keccak256("match");
    address internal constant RECIPIENT = address(0xBEEF);
    address internal constant RECIPIENT_2 = address(0xCAFE);

    function setUp() public {
        // The test contract is the owner, because it deploys BindSettlement.
        settlement = new BindSettlement();
        attacker = new ReentrantSupplier();
        vm.deal(address(this), 100 ether);
    }

    function _config(uint8 mode, bool swallow, bytes32 escrowId, uint256 innerValue)
        internal
        view
        returns (ReentrantSupplier.Config memory c)
    {
        c.target = address(settlement);
        c.mode = mode;
        c.swallow = swallow;
        c.orderId = ORDER;
        c.otherOrderId = OTHER;
        c.escrowId = escrowId;
        c.recipient = RECIPIENT;
        c.matchHash = MATCH;
        c.innerValue = innerValue;
    }

    /// The inner settleOrder reverts with OrderAlreadySettled and the attacker swallows it. The outer order is correct.
    function test_sameOrderReentrySwallowed() public {
        attacker.configure(_config(attacker.MODE_SAME_ORDER(), true, bytes32(0), 1 ether));
        settlement.settleOrder{value: 5 ether}(ORDER, address(attacker), MATCH);

        assertTrue(settlement.settledOrders(ORDER));
        assertTrue(attacker.innerAttempted());
        assertFalse(attacker.innerSucceeded());
        assertEq(attacker.receivedTotal(), 5 ether);
        assertEq(address(settlement).balance, 0);
    }

    /// The same re-entry, bubbled: the outer call reverts with TransferFailed and no state changes.
    function test_sameOrderReentryBubbled() public {
        attacker.configure(_config(attacker.MODE_SAME_ORDER(), false, bytes32(0), 1 ether));
        vm.expectRevert(BindSettlement.TransferFailed.selector);
        settlement.settleOrder{value: 5 ether}(ORDER, address(attacker), MATCH);

        assertFalse(settlement.settledOrders(ORDER));
        assertEq(address(settlement).balance, 0);
        assertEq(attacker.receivedTotal(), 0);
    }

    /// A different order, paid from the attacker's own value and paid back to it. Both settle once.
    function test_otherOrderReentryPaysBackOnce() public {
        attacker.configure(_config(attacker.MODE_OTHER_ORDER(), true, bytes32(0), 1 ether));
        settlement.settleOrder{value: 5 ether}(ORDER, address(attacker), MATCH);

        assertTrue(settlement.settledOrders(ORDER));
        assertTrue(settlement.settledOrders(OTHER));
        assertTrue(attacker.innerSucceeded());
        assertEq(attacker.receivedTotal(), 6 ether);
    }

    /// The attacker is the depositor and the recipient of E0, and releases it. Its receive() calls releaseEscrow(E0)
    /// again: refused with EscrowAlreadySettled, so it is paid once.
    function test_releaseAsRecipientReentryRefused() public {
        attacker.configure(_config(attacker.MODE_NONE(), true, E0, 0));
        attacker.deposit{value: 1 ether}(E0, address(attacker), MATCH);
        settlement.depositEscrow{value: 2 ether}(E1, RECIPIENT_2, MATCH);
        attacker.configure(_config(attacker.MODE_RELEASE_AS_RECIPIENT(), true, E0, 0));

        attacker.release(E0);

        assertTrue(settlement.getEscrow(E0).released);
        assertFalse(attacker.innerSucceeded());
        assertEq(attacker.receivedTotal(), 1 ether);
        assertEq(address(settlement).balance, 2 ether);
    }

    /// The attacker deposits from inside the callback. The new escrow is held by the contract.
    function test_depositFromInsideCallback() public {
        attacker.configure(_config(attacker.MODE_DEPOSIT(), true, E_NEW, 1 ether));
        settlement.settleOrder{value: 5 ether}(ORDER, address(attacker), MATCH);

        BindSettlement.Escrow memory e = settlement.getEscrow(E_NEW);
        assertEq(e.depositor, address(attacker));
        assertEq(e.amount, 1 ether);
        assertEq(address(settlement).balance, 1 ether);
    }

    /// The attacker refunds an escrow it deposited, from inside its own callback. It is paid the refund once.
    function test_refundFromInsideCallback() public {
        attacker.configure(_config(attacker.MODE_NONE(), true, E0, 0));
        attacker.deposit{value: 2 ether}(E0, RECIPIENT, MATCH);
        attacker.configure(_config(attacker.MODE_REFUND(), true, E0, 0));
        settlement.settleOrder{value: 5 ether}(ORDER, address(attacker), MATCH);

        assertTrue(settlement.getEscrow(E0).refunded);
        assertEq(attacker.receivedTotal(), 7 ether);
        assertEq(address(settlement).balance, 0);
    }

    /// The attacker releases an escrow it deposited. The payout goes to the recipient, not to the attacker.
    function test_releaseFromInsideCallback() public {
        attacker.configure(_config(attacker.MODE_NONE(), true, E0, 0));
        attacker.deposit{value: 2 ether}(E0, RECIPIENT, MATCH);
        attacker.configure(_config(attacker.MODE_RELEASE(), true, E0, 0));
        uint256 recipientBefore = RECIPIENT.balance;
        settlement.settleOrder{value: 5 ether}(ORDER, address(attacker), MATCH);

        assertTrue(settlement.getEscrow(E0).released);
        assertEq(RECIPIENT.balance - recipientBefore, 2 ether);
        assertEq(attacker.receivedTotal(), 5 ether);
    }

    /// Fuzzed outer value: a swallowed same-order re-entry never pays the attacker more than the outer value.
    function testFuzz_sameOrderReentryNeverOverpays(uint96 outerValue) public {
        vm.assume(outerValue > 0 && outerValue < 50 ether);
        attacker.configure(_config(attacker.MODE_SAME_ORDER(), true, bytes32(0), 1 ether));
        settlement.settleOrder{value: outerValue}(ORDER, address(attacker), MATCH);

        assertEq(attacker.receivedTotal(), outerValue);
        assertEq(address(settlement).balance, 0);
    }
}
