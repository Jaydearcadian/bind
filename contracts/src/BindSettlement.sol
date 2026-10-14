// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BindSettlement
 * @notice On-chain settlement, milestone escrow, and 3-way match audit registry for Bind on Arc L1.
 * @dev On Arc L1, native gas is native USDC (18 decimals).
 */
contract BindSettlement {
    struct Escrow {
        address depositor;
        address recipient;
        uint256 amount;
        bytes32 matchHash; // keccak256 hash of (PO, DeliveryReceipt, SupplierBill)
        bool released;
        bool refunded;
        uint256 createdAt;
    }

    address public owner;
    mapping(bytes32 => Escrow) public escrows;
    mapping(bytes32 => bool) public settledOrders;

    event EscrowDeposited(
        bytes32 indexed commitmentId,
        address indexed depositor,
        address indexed recipient,
        uint256 amount,
        bytes32 matchHash
    );

    event EscrowReleased(bytes32 indexed commitmentId, address indexed recipient, uint256 amount);

    event EscrowRefunded(bytes32 indexed commitmentId, address indexed depositor, uint256 amount);

    event SettlementExecuted(
        bytes32 indexed orderId,
        address indexed payer,
        address indexed supplier,
        uint256 amount,
        bytes32 matchHash,
        uint256 timestamp
    );

    error Unauthorized();
    error EscrowAlreadyExists();
    error EscrowNotFound();
    error EscrowAlreadySettled();
    error InsufficientValue();
    error TransferFailed();
    error OrderAlreadySettled();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Deposits funds into milestone or order escrow.
     * @param commitmentId Unique identifier for the commitment.
     * @param recipient The supplier or contractor address receiving funds upon release.
     * @param matchHash The 3-way match verification hash or milestone spec hash.
     */
    function depositEscrow(bytes32 commitmentId, address recipient, bytes32 matchHash) external payable {
        if (msg.value == 0) revert InsufficientValue();
        if (recipient == address(0)) revert Unauthorized();
        if (escrows[commitmentId].depositor != address(0)) revert EscrowAlreadyExists();

        escrows[commitmentId] = Escrow({
            depositor: msg.sender,
            recipient: recipient,
            amount: msg.value,
            matchHash: matchHash,
            released: false,
            refunded: false,
            createdAt: block.timestamp
        });

        emit EscrowDeposited(commitmentId, msg.sender, recipient, msg.value, matchHash);
    }

    /**
     * @notice Releases escrowed funds to recipient after deliverable / 3-way match confirmation.
     * @param commitmentId The identifier of the escrow to release.
     */
    function releaseEscrow(bytes32 commitmentId) external {
        Escrow storage esc = escrows[commitmentId];
        if (esc.depositor == address(0)) revert EscrowNotFound();
        if (esc.released || esc.refunded) revert EscrowAlreadySettled();
        if (msg.sender != esc.depositor && msg.sender != owner) revert Unauthorized();

        esc.released = true;
        uint256 amount = esc.amount;
        address recipient = esc.recipient;

        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit EscrowReleased(commitmentId, recipient, amount);
    }

    /**
     * @notice Refunds escrowed funds to depositor if cancelled or rejected.
     * @param commitmentId The identifier of the escrow to refund.
     */
    function refundEscrow(bytes32 commitmentId) external {
        Escrow storage esc = escrows[commitmentId];
        if (esc.depositor == address(0)) revert EscrowNotFound();
        if (esc.released || esc.refunded) revert EscrowAlreadySettled();
        if (msg.sender != esc.depositor && msg.sender != owner) revert Unauthorized();

        esc.refunded = true;
        uint256 amount = esc.amount;
        address depositor = esc.depositor;

        (bool success,) = payable(depositor).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit EscrowRefunded(commitmentId, depositor, amount);
    }

    /**
     * @notice Direct settlement of an approved order with on-chain 3-way match proof.
     * @param orderId Unique order reference ID.
     * @param supplier Supplier address.
     * @param matchHash The keccak256 hash of the matched PO, Receipt, and Bill.
     */
    function settleOrder(bytes32 orderId, address supplier, bytes32 matchHash) external payable {
        if (msg.value == 0) revert InsufficientValue();
        if (supplier == address(0)) revert Unauthorized();
        if (settledOrders[orderId]) revert OrderAlreadySettled();

        settledOrders[orderId] = true;

        (bool success,) = payable(supplier).call{value: msg.value}("");
        if (!success) revert TransferFailed();

        emit SettlementExecuted(orderId, msg.sender, supplier, msg.value, matchHash, block.timestamp);
    }

    /**
     * @notice View function to retrieve full escrow details.
     */
    function getEscrow(bytes32 commitmentId) external view returns (Escrow memory) {
        return escrows[commitmentId];
    }
}
