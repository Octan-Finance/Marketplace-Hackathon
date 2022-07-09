// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./utils/ERC721URIStorage.sol";
import "./interfaces/IManagement.sol";

contract PubCollection721 is ERC721URIStorage {
    
    bytes32 public constant VERSION = keccak256("Public_Collection_721_v1");
    bytes32 private constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");

    IManagement public management;
    string private baseURI_;

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

    constructor(IManagement _management) ERC721("Public Collection 721", "PUBC") {
        management = _management;
    }

    /**
        @notice Minting NFT Token to `_to`
        @dev    Caller must have MINTER_ROLE

        @param _to           Address of Beneficiary
        @param _tokenId      Token ID number
        @param _uri          Token URI
    */
    function mint(
        address _to,
        uint256 _tokenId,
        string calldata _uri
    ) public onlyMinter {
        _safeMint(_to, _tokenId);
        _setTokenURI(_tokenId, _uri);
    }

    /**
        @notice Minting a batch of Tokens to `_to`
        @dev    Caller must have MINTER_ROLE

        @param _to            Address of Beneficiary
        @param _tokenIds      A list of minting Token ID
        @param _uris          A list of Token URIs
    */
    function mintBatch(
        address _to,
        uint256[] calldata _tokenIds,
        string[] calldata _uris
    ) public onlyMinter {
        uint256 _len = _tokenIds.length;
        require(_uris.length == _len, "Length mismatch");

        for (uint256 i; i < _len; i++)
            mint(_to, _tokenIds[i], _uris[i]);
    }

    /**
        @notice Update new URI of `tokenId`
        @dev    Caller must have MANAGER_ROLE

        @param _tokenId       Token ID
        @param _uri           New token URI
    */
    function updateTokenURI(uint256 _tokenId, string calldata _uri) external onlyManager {
        _setTokenURI(_tokenId, _uri);
    }

    /**
        @notice Update new Base URI
        @dev    Caller must have MANAGER_ROLE

        @param _uri           New Base URI
    */
    function updateBaseURI(string calldata _uri) external onlyManager {
        baseURI_ = _uri;
    }

    /**
        @notice Query TokenURI of `_tokenId`
        @dev    Caller can be ANY

        @param _tokenId       Token ID
    */
    function tokenURI(uint256 _tokenId) public view override returns (string memory) {
        _requireMinted(_tokenId);

        string memory _tokenURI = _tokenURIs[_tokenId];
        if (bytes(_tokenURI).length > 0) {
            return _tokenURI;
        }

        string memory base = _baseURI();
        if (bytes(base).length == 0) {
            return string(abi.encodePacked(base, _tokenId));
        }
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI_;
    }
}
