// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";

contract Management is AccessControlEnumerable {
    
    bytes32 public constant VERSION = keccak256("MANAGEMENT_v1");

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant AUTHORIZER_ROLE = keccak256("AUTHORIZER_ROLE");

    address public treasury;
    address public marketplace;
    uint256 public commissionFee;

    mapping(address => bool) public paymentTokens;
    mapping(address => bool) public collections;

    constructor(address _admin, address _treasury, uint256 _commissionFee) {
        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
        treasury = _treasury;
        commissionFee = _commissionFee;
    }

    /**
       @notice Update new Address of Treasury
       @dev Caller must have DEFAULT_ADMIN_ROLE
       @param _newTreasury        Address of the new Treasury
    */
    function updateTreasury(address _newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_newTreasury != address(0), "Set zero address");

        treasury = _newTreasury;
    }

    /**
       @notice Update new Address of Marketplace contract
       @dev Caller must have MANAGER_ROLE
       @param _newMarket        Address of new Marketplace contract
    */
    function updateMarketplace(address _newMarket) external onlyRole(MANAGER_ROLE) {
        require(_newMarket != address(0), "Set zero address");

        marketplace = _newMarket;
    }

    /**
       @notice Update new Commission Fee Rate
       @dev Caller must have MANAGER_ROLE
       @param _commissionFee        A new value of Commission Fee
       Note: fee_rate = commissionFee / 10**4. If fee_rate = 1%, commissionFee = 100 (100 / 10,000 = 1 / 100 = 1%)
    */
    function setCommissionFee(uint256 _commissionFee) external onlyRole(MANAGER_ROLE) {
        commissionFee = _commissionFee;
    }

    /**
       @notice Register Payment Token
       @dev Caller must have MANAGER_ROLE
       @param _token           Address of Token contract (0x00 - Native)
    */
    function addPayment(address _token) external onlyRole(MANAGER_ROLE) {
        require(!paymentTokens[_token], "Payment already accepted");

        paymentTokens[_token] = true;
    }

    /**
       @notice Unregister Payment Token
       @dev  Caller must have MANAGER_ROLE
       @param _token         Address of Payment Token (0x00 - Native Coin)
    */
    function removePayment(address _token) external onlyRole(MANAGER_ROLE) {
        require(paymentTokens[_token], "Not found");

        delete paymentTokens[_token];
    }

    /**
       @notice Register Collection
       @dev Caller must have MANAGER_ROLE
       @param _collection           Address of NFT Token (ERC721/ERC1155/Collection) contract
    */
    function addCollection(address _collection) external onlyRole(MANAGER_ROLE) {
        require(_collection != address(0), "Set zero address");
        require(!collections[_collection], "Collection exists");

        collections[_collection] = true;
    }

    /**
       @notice Unregister Collection
       @dev Caller must have MANAGER_ROLE
       @param _collection           Address of NFT Token contract to be removed
    */
    function removeCollection(address _collection) external onlyRole(MANAGER_ROLE) {
        require(collections[_collection], "Collection not found");

        delete collections[_collection];
    }
}
