// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// NOT_RUN under Forge (not installed in the authoring environment). This file was only compile-checked, with the pinned
// solc 0.8.37 in tools/compile-contract, against the vendored contracts/lib/forge-std. Nothing here is a pass until
// `cd contracts && forge test` has run it and the result is recorded in docs/RELEASE_EVIDENCE.md.
//
// Stateful invariants for BindSettlement, as far as Solidity can state them. The handler performs bounded random
// actions. Some actions are made by non-owners on purpose, so the authorisation invariants have something to refuse.
// The daily limit is set once in setUp and never changed by the handler, so dailySpent <= limit is a fair invariant.
// The TypeScript property suite (tests/integration/bind-settlement-properties.test.ts) is the executed counterpart.

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import "../src/BindSettlement.sol";

contract BindSettlementHandler is Test {
    uint256 internal constant ORDERS = 8;
    uint256 internal constant ESCROWS = 8;
    uint256 internal constant ACTORS = 4;

    BindSettlement public immutable settlement;
    address public immutable owner;

    bytes32[ORDERS] public orderIds;
    bytes32[ESCROWS] public escrowIds;
    address[ACTORS] public actors;
    address[ACTORS] public suppliers;

    // Ghost state. The invariants read these, because a failed call cannot be observed from outside.
    mapping(bytes32 => bool) public everSettled;
    bool public unauthorizedAdminSucceeded;
    bool public unauthorizedReleaseSucceeded;
    bool public releasedOrRefundedTwiceSucceeded;

    constructor(BindSettlement _settlement, address _owner) {
        settlement = _settlement;
        owner = _owner;
        for (uint256 i = 0; i < ORDERS; i++) {
            orderIds[i] = keccak256(abi.encodePacked("inv_order", i));
        }
        for (uint256 i = 0; i < ESCROWS; i++) {
            escrowIds[i] = keccak256(abi.encodePacked("inv_escrow", i));
        }
        for (uint256 i = 0; i < ACTORS; i++) {
            actors[i] = address(uint160(0x1000 + i));
            suppliers[i] = address(uint160(0x2000 + i));
            vm.deal(actors[i], 1_000 ether);
        }
    }

    function settle(uint256 seed, uint256 amountSeed) external {
        bytes32 id = orderIds[seed % ORDERS];
        address payer = actors[seed % ACTORS];
        address supplier = suppliers[(seed / ACTORS) % ACTORS];
        uint256 amount = bound(amountSeed, 1, 3 ether);
        vm.prank(payer);
        try settlement.settleOrder{value: amount}(id, supplier, keccak256("match")) {
            everSettled[id] = true;
        } catch {}
    }

    function deposit(uint256 seed, uint256 amountSeed) external {
        bytes32 id = escrowIds[seed % ESCROWS];
        address payer = actors[seed % ACTORS];
        address recipient = suppliers[(seed / ACTORS) % ACTORS];
        uint256 amount = bound(amountSeed, 1, 3 ether);
        vm.prank(payer);
        try settlement.depositEscrow{value: amount}(id, recipient, keccak256("match")) {} catch {}
    }

    function release(uint256 seed, uint256 callerSeed) external {
        bytes32 id = escrowIds[seed % ESCROWS];
        address caller = actors[callerSeed % ACTORS];
        BindSettlement.Escrow memory before = settlement.getEscrow(id);
        vm.prank(caller);
        try settlement.releaseEscrow(id) {
            if (caller != before.depositor && caller != owner) unauthorizedReleaseSucceeded = true;
            if (before.released || before.refunded) releasedOrRefundedTwiceSucceeded = true;
        } catch {}
    }

    function refund(uint256 seed, uint256 callerSeed) external {
        bytes32 id = escrowIds[seed % ESCROWS];
        address caller = actors[callerSeed % ACTORS];
        BindSettlement.Escrow memory before = settlement.getEscrow(id);
        vm.prank(caller);
        try settlement.refundEscrow(id) {
            if (caller != before.depositor && caller != owner) unauthorizedReleaseSucceeded = true;
            if (before.released || before.refunded) releasedOrRefundedTwiceSucceeded = true;
        } catch {}
    }

    /// Admin calls by non-owners. Every success is recorded and the invariant below fails on it.
    function adminAttempt(uint256 seed, uint256 valueSeed) external {
        address caller = actors[seed % ACTORS];
        vm.prank(caller);
        try settlement.setDailyLimit(valueSeed) {
            unauthorizedAdminSucceeded = true;
        } catch {}
        vm.prank(caller);
        try settlement.setEnforceVendorWhitelist(valueSeed % 2 == 0) {
            unauthorizedAdminSucceeded = true;
        } catch {}
        vm.prank(caller);
        try settlement.setVendorStatus(suppliers[seed % ACTORS], true) {
            unauthorizedAdminSucceeded = true;
        } catch {}
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 0, 3 days));
    }
}

contract BindSettlementInvariantTest is StdInvariant, Test {
    BindSettlement internal settlement;
    BindSettlementHandler internal handler;
    uint256 internal constant LIMIT = 10 ether;

    function setUp() public {
        settlement = new BindSettlement();
        settlement.setDailyLimit(LIMIT);
        handler = new BindSettlementHandler(settlement, address(this));
        targetContract(address(handler));
    }

    /// I1: an order id that the handler saw settle (a successful call) is still settled. The handler records only
    /// successes, so this checks that no later action clears the flag. Double settlement is refused by the contract
    /// and is covered by the TypeScript property suite and the reentrancy suite.
    function invariant_settledOrdersNeverUnset() public view {
        for (uint256 i = 0; i < 8; i++) {
            bytes32 id = handler.orderIds(i);
            if (handler.everSettled(id)) {
                assertTrue(settlement.settledOrders(id));
            }
        }
    }

    /// I2: the native balance equals the sum of the escrows that are neither released nor refunded.
    function invariant_balanceEqualsOpenEscrows() public view {
        uint256 open = 0;
        for (uint256 i = 0; i < 8; i++) {
            BindSettlement.Escrow memory e = settlement.getEscrow(handler.escrowIds(i));
            if (e.depositor != address(0) && !e.released && !e.refunded) {
                open += e.amount;
            }
        }
        assertEq(address(settlement).balance, open);
    }

    /// I4: within the window the spend total never exceeds the limit. The limit is constant in this handler.
    function invariant_dailySpentWithinLimit() public view {
        uint256 limit = settlement.dailySpendLimit();
        if (limit > 0) {
            assertLe(settlement.dailySpent(), limit);
        }
    }

    /// I5: an escrow is never released and refunded, and never released or refunded twice.
    function invariant_noEscrowReleasedAndRefunded() public view {
        for (uint256 i = 0; i < 8; i++) {
            BindSettlement.Escrow memory e = settlement.getEscrow(handler.escrowIds(i));
            assertFalse(e.released && e.refunded);
        }
        assertFalse(handler.releasedOrRefundedTwiceSucceeded());
    }

    /// I5: only the depositor or the owner releases or refunds. The handler records any other success.
    function invariant_onlyDepositorOrOwnerReleases() public view {
        assertFalse(handler.unauthorizedReleaseSucceeded());
    }

    /// I6: only the owner can call the admin functions, and the owner is the test contract.
    function invariant_onlyOwnerAdmin() public view {
        assertEq(settlement.owner(), address(this));
        assertFalse(handler.unauthorizedAdminSucceeded());
    }
}
