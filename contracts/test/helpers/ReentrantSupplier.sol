// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReentrantSupplier
 * @notice Test-only attacker for BindSettlement. It is the supplier of settleOrder, the recipient of a release, or the
 *         depositor of an escrow, and it re-enters BindSettlement from receive() once per arming.
 * @dev Self-contained on purpose: tools/compile-contract/generate.mjs compiles this file alone (no imports), and writes
 *      contracts/artifacts/helpers/ReentrantSupplier.json. Not deployed anywhere but a test chain.
 *      Forge: NOT_RUN under Forge (not installed). The in-process TypeScript suite
 *      tests/integration/bind-settlement-reentrancy.test.ts is the executed evidence for these modes.
 */

interface IBindSettlementCalls {
    function settleOrder(bytes32 orderId, address supplier, bytes32 matchHash) external payable;
    function releaseEscrow(bytes32 commitmentId) external;
    function refundEscrow(bytes32 commitmentId) external;
    function depositEscrow(bytes32 commitmentId, address recipient, bytes32 matchHash) external payable;
}

contract ReentrantSupplier {
    uint8 public constant MODE_NONE = 0;
    /// Inner settleOrder with the same order id as the outer call. Must fail with OrderAlreadySettled.
    uint8 public constant MODE_SAME_ORDER = 1;
    /// Inner settleOrder with a different order id and this contract's own value, paid back to this contract.
    uint8 public constant MODE_OTHER_ORDER = 2;
    /// Inner releaseEscrow of an escrow this contract deposited (this contract is the depositor).
    uint8 public constant MODE_RELEASE = 3;
    /// Inner refundEscrow of an escrow this contract deposited (this contract is the depositor).
    uint8 public constant MODE_REFUND = 4;
    /// Inner depositEscrow with this contract's own value.
    uint8 public constant MODE_DEPOSIT = 5;
    /// This contract is the recipient of a release. Its receive() calls releaseEscrow on the same id again.
    uint8 public constant MODE_RELEASE_AS_RECIPIENT = 6;

    struct Config {
        address target;
        uint8 mode;
        bool swallow;
        bytes32 orderId;
        bytes32 otherOrderId;
        bytes32 escrowId;
        address recipient;
        bytes32 matchHash;
        uint256 innerValue;
    }

    Config internal cfg;

    /// True from configure() until the first receive() that makes an inner attempt. One attempt per arming.
    bool public armed;
    bool public innerAttempted;
    bool public innerSucceeded;
    bytes public innerReturnData;
    /// Every wei this contract has been sent (legitimate payouts and the inner payouts it is owed).
    uint256 public receivedTotal;
    uint256 public receiveCount;

    /// Sets the attack. swallow=true: an inner failure is ignored. swallow=false: it is bubbled to the caller.
    function configure(Config calldata c) external {
        cfg = c;
        armed = c.mode != MODE_NONE;
        innerAttempted = false;
        innerSucceeded = false;
        delete innerReturnData;
    }

    /// Deposits an escrow with this contract as depositor. Used by the test setup.
    function deposit(bytes32 commitmentId, address recipient, bytes32 matchHash) external payable {
        IBindSettlementCalls(cfg.target).depositEscrow{value: msg.value}(commitmentId, recipient, matchHash);
    }

    /// Settles an order paid from this contract. Used by the test to fund the attacker through its own settlement.
    function payOrder(bytes32 orderId, address supplier, bytes32 matchHash) external payable {
        IBindSettlementCalls(cfg.target).settleOrder{value: msg.value}(orderId, supplier, matchHash);
    }

    /// Calls releaseEscrow from this contract (as depositor).
    function release(bytes32 commitmentId) external {
        IBindSettlementCalls(cfg.target).releaseEscrow(commitmentId);
    }

    /// Calls refundEscrow from this contract (as depositor).
    function refund(bytes32 commitmentId) external {
        IBindSettlementCalls(cfg.target).refundEscrow(commitmentId);
    }

    receive() external payable {
        receivedTotal += msg.value;
        receiveCount += 1;
        if (!armed) {
            return;
        }
        armed = false;
        _attempt();
    }

    function _attempt() internal {
        bytes memory data;
        uint256 value = 0;
        address target = cfg.target;

        if (cfg.mode == MODE_SAME_ORDER) {
            data = abi.encodeCall(IBindSettlementCalls.settleOrder, (cfg.orderId, address(this), cfg.matchHash));
            value = cfg.innerValue;
        } else if (cfg.mode == MODE_OTHER_ORDER) {
            data = abi.encodeCall(IBindSettlementCalls.settleOrder, (cfg.otherOrderId, address(this), cfg.matchHash));
            value = cfg.innerValue;
        } else if (cfg.mode == MODE_RELEASE || cfg.mode == MODE_RELEASE_AS_RECIPIENT) {
            data = abi.encodeCall(IBindSettlementCalls.releaseEscrow, (cfg.escrowId));
        } else if (cfg.mode == MODE_REFUND) {
            data = abi.encodeCall(IBindSettlementCalls.refundEscrow, (cfg.escrowId));
        } else if (cfg.mode == MODE_DEPOSIT) {
            data = abi.encodeCall(IBindSettlementCalls.depositEscrow, (cfg.escrowId, cfg.recipient, cfg.matchHash));
            value = cfg.innerValue;
        } else {
            return;
        }

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        innerAttempted = true;
        innerSucceeded = ok;
        innerReturnData = ret;

        if (!ok && !cfg.swallow) {
            // Bubble the inner revert data unchanged. The outer BindSettlement call then reverts with TransferFailed.
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
