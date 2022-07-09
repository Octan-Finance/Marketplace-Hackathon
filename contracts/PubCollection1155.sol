// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "./utils/ERC1155URIStorage.sol";
import "./interfaces/IManagement.sol";

contract PubCollection1155 is ERC1155URIStorage {

    bytes32 public constant VERSION = keccak256("Public_Collection_1155_v1");
    bytes32 private constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");

    IManagement public management;

    modifier onlyManager() {
        require(
            management.hasRole(MANAGER_ROLE, msg.sender), "Only Manager"
        );
        _;
    }

    modifier onlyMinter() {
        require(
            management.hasRole(MINTER_ROLE, msg.sender), "Only Minter"
        );
        _;
    }

    constructor(IManagement _management, string memory _uri) ERC1155(_uri) {
        management = _management;
    }

    /**
        @notice Minting new NFT Token (ERC1155)
        @dev    Caller must have MINTER_ROLE

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
    ) public onlyMinter {
        require(!_existed(_tokenId), "Token already minted");

        _mint(_to, _tokenId, _amount, "");
        _setURI(_tokenId, _uri);
    }

    /**
        @notice Minting a batch of NFT Tokens (ERC1155)
        @dev    Caller must have MINTER_ROLE

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
    ) external onlyMinter {
        uint256 _len = _tokenIds.length;
        require(_amounts.length == _len && _uris.length == _len, "Length mismatch");

        for (uint256 i; i < _len; i++)
            mint(_to, _tokenIds[i], _amounts[i], _uris[i]);
    }

    /**
        @notice Update new URI of `tokenId`
        @dev    Caller must have MANAGER_ROLE

        @param _tokenId       Token ID
        @param _uri           New token URI
    */
    function updateTokenURI(uint256 _tokenId, string calldata _uri) external onlyManager {
        _setURI(_tokenId, _uri);
    }

    /**
        @notice Update new Base URI
        @dev    Caller must have MANAGER_ROLE

        @param _newURI           New Base URI
    */
    function updateBaseURI(string calldata _newURI) external onlyManager {
        _setBaseURI(_newURI);
    }

    /**
        @notice Query TokenURI of `_tokenId`
        @dev    Caller can be ANY

        @param _tokenId       Token ID
    */
    function uri(uint256 _tokenId) public view override returns (string memory) {
        string memory _tokenURI = _tokenURIs[_tokenId];

        // If token URI is set, return token URI 
        // Otherwise, concatenate base URI and tokenId (via abi.encodePacked).
        return bytes(_tokenURI).length > 0 ? _tokenURI: string(abi.encodePacked(_baseURI, _tokenId));
    }

    function _existed(uint256 _tokenId) internal view returns (bool) {
        return bytes(uri(_tokenId)).length > 0;
    }
}
