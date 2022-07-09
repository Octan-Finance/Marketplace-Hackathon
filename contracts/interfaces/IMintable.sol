// SPDX-License-Identifier: None

pragma solidity ^0.8.0;

interface IMintable {

    /**
        @notice Minting NFT Token (ERC1155)
        @dev Caller must have MINTER_ROLE
        @param _to           Address of Beneficiary
        @param _tokenId      Token ID number
        @param _amount       An amount of Token being minted
        @param _uri          Token URI
    */
    function mint(
        address _to,
        uint256 _tokenId,
        uint256 _amount,
        string calldata _uri
    ) external;

    /**
        @notice Minting NFT Token (ERC721) to `_to`
        @dev Caller must have MINTER_ROLE
        @param _to           Address of Beneficiary
        @param _tokenId      Token ID number
        @param _uri          Token URI
    */
    function mint(
        address _to,
        uint256 _tokenId,
        string calldata _uri
    ) external;

    /**
        @notice Minting a batch of NFT Tokens (ERC1155)
        @dev Caller must have MINTER_ROLE
        @param _to            Address of Beneficiary
        @param _tokenIds      A list of minting tokenId
        @param _amounts       A list of amounts being minted per tokenId
        @param _uris          A list of token uri
    */
    function mintBatch(
        address _to,
        uint256[] calldata _tokenIds,
        uint256[] calldata _amounts,
        string[] calldata _uris
    ) external;

    /**
        @notice Minting a batch of Tokens to `_to`
        @dev Caller must have MINTER_ROLE
        @param _to            Address of Beneficiary
        @param _tokenIds      A list of tokenId being minted
        @param _uris          A list of Token URIs
    */
    function mintBatch(
        address _to,
        uint256[] calldata _tokenIds,
        string[] calldata _uris
    ) external;
}
