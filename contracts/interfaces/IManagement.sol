// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IManagement {
    function treasury() external view returns (address);

    function marketplace() external view returns (address);

    function commissionFee() external view returns (uint256);

    function paymentTokens(address _token) external view returns (bool);

    function collections(address _collection) external view returns (bool);
    
    function hasRole(bytes32 role, address account) external view returns (bool);
}
