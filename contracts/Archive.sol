// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IManagement.sol";

contract Archive {

    struct OnSale {
        uint256 amount;
        bool locked;
    }

    bytes32 private constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    IManagement public management;

    mapping(uint256 => OnSale) public currentOnSale;
    mapping(uint256 => bool) public prevSaleIds;

    modifier onlyAuthorizer() {
        require(
            management.marketplace() == msg.sender, "Unauthorized "
        );
        _;
    }

    modifier onlyManager() {
        require(
            management.hasRole(MANAGER_ROLE, msg.sender), "Only Manager"
        );
        _;
    }

    constructor(IManagement _management) {
        management = _management;
    }

    /**
        @notice Change a new Management contract
        @dev    Caller must have MANAGER_ROLE

        @param _newManagement       Address of new Management contract
    */
    function updateManagement(address _newManagement) external onlyManager {
        require(_newManagement != address(0), "Set zero address");
        management = IManagement(_newManagement);
    }

    /**
        @notice Query an amount of item that is currently 'on sale'
        @dev    Caller can be ANY

        @param _saleId       An unique identification number of Sale Info
    */
    function getCurrentOnSale(uint256 _saleId) external view returns (uint256 _currentAmt) {
        _currentAmt = currentOnSale[_saleId].amount;
    }

    /**
        @notice Update new amount of items that are 'on sale'
        @dev    Restricted Caller

        @param _saleId          An unique identification number of Sale Info
        @param _newAmt          New amount is 'on sale'  
    */
    function setCurrentOnSale(uint256 _saleId, uint256 _newAmt) external onlyAuthorizer {
        currentOnSale[_saleId].amount = _newAmt;
    }

    /**
        @notice Query locking state of one `saleId`
        @dev    Caller can be ANY

        @param _saleId       An unique identification number of Sale Info
    */
    function getLocked(uint256 _saleId) external view returns (bool _locked) {
        _locked = currentOnSale[_saleId].locked;
    }

    /**
        @notice Set locking state of one `saleId`
        @dev    Restricted Caller

        @param _saleId          An unique identification number of Sale Info

        Note: Once locking state of one `saleId` is set, it cannot be reset
    */
    function setLocked(uint256 _saleId) external onlyAuthorizer {
        currentOnSale[_saleId].locked = true;
    }

    /**
        @notice Archive `saleId`
        @dev    Restricted Caller
        
        @param _saleId          An unique identification number of Sale Info
    */
    function cancel(uint256 _saleId) external onlyAuthorizer {
        prevSaleIds[_saleId] = true;
    }
}
