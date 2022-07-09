const { BigNumber } = require('@ethersproject/bignumber');
const chai = require('chai');
const chaiAsPromise = require('chai-as-promised');
const { intToBuffer } = require('ethjs-util');
const { ethers, upgrades } = require('hardhat');
const collectionABI = require('../build/artifacts/contracts/Collection.sol/Collection.json');

chai.use(chaiAsPromise);
const expect = chai.expect;

const ERC721_MINT = 0;

function encodeURIs(...uris) {
    return ethers.utils.solidityPack([...Array(uris.length).fill('string')], [...uris]);
}

function creationSignature(verifier, collectionId, maxEdition, requestId, admin, registry) {
    let message = ethers.utils.solidityKeccak256(['uint256', 'uint256', 'uint256', 'address', 'address'],
        [collectionId, maxEdition, requestId, admin, registry]);

    return verifier.signMessage(ethers.utils.arrayify(message));   
}

function verifySignature(verifier, toAddress, tokenId, uri, type) {
    let message = ethers.utils.solidityKeccak256(['address', 'uint256', 'string', 'uint256'],
        [toAddress, tokenId, uri, type]);

    return verifier.signMessage(ethers.utils.arrayify(message));
}

function verifySignatureBatch(verifier, toAddress, encodeURIs, type, ...tokenIds) {
    let message = ethers.utils.solidityKeccak256(['address', ...Array(tokenIds.length).fill('uint256'), 'bytes', 'uint256'],
        [toAddress, ...tokenIds, encodeURIs, type]);

    return verifier.signMessage(ethers.utils.arrayify(message));
}

//  Two phases in this test scenario:
//      + Phase 1: SporesRegistry is deployed as Proxy and Collection 1 is created
//      + Phase 2: SporesRegistry is upgraded --> Collection 2 is created, Collection 1 is still active and valid
//  Attention: Should not use multiple Verifier if Registry contract saves a list of signatures that have been used
//  Reason: A successful request can be signed by different Verifier.

describe('Collection Contract Testing', () => {
    let deployer, creator, verifier, feeCollector, creator2, verifier2, verifier3;
    let token721, token1155, collection, collection2;
    before(async() => {
        //  Get pre-fund accounts
        [deployer, creator, verifier, feeCollector, creator2, verifier2, verifier3] = await ethers.getSigners();

        //  Deploy and initialize SporesNFT721 contract
        //  SporesNFT721 contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesNFT721 = await ethers.getContractFactory('SporesNFT721', deployer);
        token721 = await SporesNFT721.deploy();
        token721.init('Spores NFT', 'SPONFT');

        //  Deploy and initialize SporesNFT1155 contract
        //  SporesNFT1155 contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesNFT1155 = await ethers.getContractFactory('SporesNFT1155', deployer);
        token1155 = await SporesNFT1155.deploy();
        token1155.init();

        //  Deploy and initialize SporesRegistry contract
        //  SporesRegistry contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesRegistry = await ethers.getContractFactory('SporesRegistry', deployer);
        const supportTokens = [];
        registry = await upgrades.deployProxy(
            SporesRegistry,
            [feeCollector.address, verifier.address, token721.address, token1155.address, supportTokens],
            {initializer: 'init'}
        );
        await registry.deployed();
    });

    it('Should be able to create a new Collection', async() => {
        const collectionId = 99;
        const maxEdition = 10;
        const collectionName = 'Collection 1';
        const requestId = 18002080;
        //  Create a signature to request adding 
        const signature = await creationSignature(verifier, collectionId, maxEdition, requestId, deployer.address, registry.address);

        //  Create a new Collection
        const Collection = await ethers.getContractFactory('Collection', creator);
        collection = await Collection.deploy(
            deployer.address, registry.address, collectionId, maxEdition, requestId, collectionName, '', signature
        );
        const receipt = await collection.deployTransaction.wait();
        const iface = new ethers.utils.Interface(collectionABI.abi);
        const event = iface.decodeEventLog(
            'NewCollection',
            receipt.logs[1].data,
            receipt.logs[1].topics
        );
        expect(event != undefined).true;
        expect(event._collectionId).deep.equal(collectionId);
        expect(event._subCollectionId).deep.equal(1);
        expect(event._maxEdition).deep.equal(maxEdition);
        expect(event._collectionAddr).deep.equal(collection.address);

        expect(await collection.admin()).deep.equal(deployer.address);
        expect(await collection.owner()).deep.equal(creator.address);
        expect(await collection.collectionId()).deep.equal(collectionId);
        expect(await collection.name()).deep.equal(collectionName);
        expect(await collection.subcollectionId()).deep.equal(1);
        expect(await collection.registry()).deep.equal(registry.address);
        expect((await collection.subcollections(1)).maxEdition).deep.equal(maxEdition);
        expect((await collection.subcollections(1)).mintedAmt).deep.equal(0);
    });

    /**********************************************************************************************************
                                                    Phase 1
    ***********************************************************************************************************/

    it('Should revert when non-admin role tries to update Registry contract', async() => {
        await expect(
            collection.connect(creator).updateRegistry(feeCollector.address)    
        ).to.be.revertedWith('Collection: Unauthorized');

        //  Expect Registry contract remains unchanged
        expect(await collection.registry()).deep.equal(registry.address);
    });

    it('Should succeed when admin roles tries to update Registry contract', async() => {
        //  Assume feeCollector is a SporesRegistry
        await collection.connect(deployer).updateRegistry(feeCollector.address);
        //  Expect Registry contract is updated
        expect(await collection.registry()).deep.equal(feeCollector.address);

        //  Change back to normal
        await collection.connect(deployer).updateRegistry(registry.address);
        //  Expect Registry contract is set back to normal
        expect(await collection.registry()).deep.equal(registry.address);
    });

    // it('Should revert when Creator tries to mint NFT item (single), but Collection not registered', async() => {
    //     const tokenId = BigNumber.from('990001000000000001');
    //     const uri = 'https://test.metadata/990001000000000001';
    //     const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

    //     //  Send a minting request when Collection has not yet registered
    //     await expect(
    //         collection.connect(creator).mint(creator.address, tokenId, uri, signature)    
    //     ).to.be.revertedWith('SporesRegistry: Unauthorized');

    //     expect(collection.balanceOf(creator.address)).deep.equal(0);
    //     await expect(
    //         collection.ownerOf(tokenId)    
    //     ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    // });

    // it('Should revert when Creator tries to mint NFT items (batch), but Collection not registered', async() => {
    //     const tokenId1 = BigNumber.from('990001000000000001');
    //     const uri1 = 'https://test.metadata/990001000000000001';

    //     const tokenId2 = BigNumber.from('990001000000000002');
    //     const uri2 = 'https://test.metadata/990001000000000002';

    //     const tokenId3 = BigNumber.from('990001000000000003');
    //     const uri3 = 'https://test.metadata/990001000000000003';

    //     const tokenIds = [tokenId1, tokenId2, tokenId3];
    //     const uris = [uri1, uri2, uri3];
    //     const encodedURIs = await encodeURIs(uri1, uri2, uri3);
    //     const signature = await verifySignatureBatch(
    //         verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
    //     );

    //     //  Send a minting request when Collection has not yet registered
    //     await expect(
    //         collection.connect(creator).mint(creator.address, tokenIds, uris, signature)    
    //     ).to.be.revertedWith('SporesRegistry: Unauthorized');

    //     expect(collection.balanceOf(creator.address)).deep.equal(0);
    //     await expect(
    //         collection.ownerOf(tokenId1)    
    //     ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    //     await expect(
    //         collection.ownerOf(tokenId2)    
    //     ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    //     await expect(
    //         collection.ownerOf(tokenId3)    
    //     ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    // });

    it('Should succeed when minting a valid TokenId - Single Minting', async() => {
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request when Collection has registered
        await collection.connect(creator).mint(creator.address, tokenId, uri, signature)    

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore + 1);
        expect(await collection.ownerOf(tokenId)).deep.equal(creator.address);
    });

    it('Should succeed when minting valid TokenIds - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000002');
        const uri1 = 'https://test.metadata/990001000000000002';

        const tokenId2 = BigNumber.from('990001000000000003');
        const uri2 = 'https://test.metadata/990001000000000003';

        const tokenId3 = BigNumber.from('990001000000000004');
        const uri3 = 'https://test.metadata/990001000000000004';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request when Collection has registered
        await collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature);    

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore.add(3));
        expect(await collection.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection.ownerOf(tokenId2)).deep.equal(creator.address);
        expect(await collection.ownerOf(tokenId3)).deep.equal(creator.address);
    });

    it('Should revert when creator requests minting, but tokenId exists - Single Minting', async() => {
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';
        const signature = await verifySignature(verifier, creator2.address, tokenId, uri, ERC721_MINT);

        const balanceBefore1 = await collection.balanceOf(creator.address);
        const balanceBefore2 = await collection.balanceOf(creator2.address);
        //  Send a minting request, but tokenID exists
        await expect(
            collection.connect(creator).mint(creator2.address, tokenId, uri, signature)    
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore1);
        expect(await collection.balanceOf(creator2.address)).deep.equal(balanceBefore2);
        expect(await collection.ownerOf(tokenId)).deep.equal(creator.address);
    });

    it('Should revert when creator requests minting, but tokenId exists - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000005');
        const uri1 = 'https://test.metadata/990001000000000005';

        const tokenId2 = BigNumber.from('990001000000000006');
        const uri2 = 'https://test.metadata/990001000000000006';

        const tokenId3 = BigNumber.from('990001000000000004');  // minted
        const uri3 = 'https://test.metadata/990001000000000004';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore1 = await collection.balanceOf(creator.address);
        const balanceBefore2 = await collection.balanceOf(creator2.address);
        //  Send a minting request, but tokenID exists
        await expect(
            collection.connect(creator).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore1);
        expect(await collection.balanceOf(creator2.address)).deep.equal(balanceBefore2);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collection.ownerOf(tokenId3)).deep.equal(creator.address); 
    });

    it('Should revert when collectionId of minting TokenId does not match Collection ID - Single Minting', async() => {
        const tokenId = BigNumber.from('980001000000000005');
        const uri = 'https://test.metadata/980001000000000005';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - collectionId, derived from TokenId, not match CollectionId of a contract
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, uri, signature)    
        ).to.be.revertedWith('Collection: Invalid collection');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when collectionId of minting TokenIds does not match Collection ID - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('980001000000000005');
        const uri1 = 'https://test.metadata/980001000000000005';

        const tokenId2 = BigNumber.from('980001000000000006');
        const uri2 = 'https://test.metadata/980001000000000006';

        const tokenId3 = BigNumber.from('980001000000000007');
        const uri3 = 'https://test.metadata/980001000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - collectionId, derived from TokenId, not match CollectionId of a contract
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: Invalid collection');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when subcollectionId of minting TokenId is invalid - Single Minting', async() => {
        const tokenId = BigNumber.from('990002000000000005');
        const uri = 'https://test.metadata/990002000000000005';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - subcollectionId, derived from TokenId, not match subcollectionId of a contract
        //  This Collection's version supports only one sub-collection in a collection
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, uri, signature)    
        ).to.be.revertedWith('Collection: Reach max edition');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when subcollectionId of minting TokenIds is invalid - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990002000000000005');
        const uri1 = 'https://test.metadata/990002000000000005';

        const tokenId2 = BigNumber.from('990002000000000006');
        const uri2 = 'https://test.metadata/990002000000000006';

        const tokenId3 = BigNumber.from('990002000000000007');
        const uri3 = 'https://test.metadata/990002000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - subcollectionId, derived from TokenId, not match subcollectionId of a contract
        //  This Collection's version supports only one sub-collection in a collection
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: Reach max edition');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when TokenIds and URIs not match - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000005');
        const uri1 = 'https://test.metadata/990001000000000005';

        const tokenId2 = BigNumber.from('990001000000000006');
        const uri2 = 'https://test.metadata/990001000000000006';

        const tokenId3 = BigNumber.from('990001000000000007');
        const uri3 = 'https://test.metadata/990001000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - tokenIds and URIs not match respectively
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: TokenIDs and URIs not match');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting TokenIds of multiple sub-collections - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000005');
        const uri1 = 'https://test.metadata/990001000000000005';

        const tokenId2 = BigNumber.from('990002000000000006');
        const uri2 = 'https://test.metadata/990002000000000006';

        const tokenId3 = BigNumber.from('990003000000000007');
        const uri3 = 'https://test.metadata/990003000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - tokenIds of multiple sub-collections
        //  This Collection's version supports only one sub-collection in a collection
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: Invalid TokenIds');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when Receiver - signed and param - are not matched - Single Minting', async() => {
        const tokenId = BigNumber.from('990001000000000005');
        const uri = 'https://test.metadata/990001000000000005';
        const signature = await verifySignature(verifier, creator2.address, tokenId, uri, ERC721_MINT);

        const balanceBefore1 = await collection.balanceOf(creator.address);
        const balanceBefore2 = await collection.balanceOf(creator2.address);
        //  Send a minting request - Receiver provided in signature and in param are not matched
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, uri, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore1);
        expect(await collection.balanceOf(creator2.address)).deep.equal(balanceBefore2);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when Receiver - signed and param - are not matched - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000005');
        const uri1 = 'https://test.metadata/990001000000000005';

        const tokenId2 = BigNumber.from('990001000000000006');
        const uri2 = 'https://test.metadata/990001000000000006';

        const tokenId3 = BigNumber.from('990001000000000007');
        const uri3 = 'https://test.metadata/990001000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore1 = await collection.balanceOf(creator.address);
        const balanceBefore2 = await collection.balanceOf(creator2.address);
        //  Send a minting request - Receiver provided in signature and in param are not matched
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore1);
        expect(await collection.balanceOf(creator2.address)).deep.equal(balanceBefore2);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when tokenId - signed and param - are not matched - Single Minting', async() => {
        const tokenId = BigNumber.from('990001000000000005');
        const uri = 'https://test.metadata/990001000000000005';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);
        const invalidTokenId = BigNumber.from('990001000000000006');

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - TokenId provided in signature and in param are not matched
        await expect(
            collection.connect(creator).mint(creator.address, invalidTokenId, uri, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(invalidTokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when tokenId - signed and param - are not matched - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000005');
        const uri1 = 'https://test.metadata/990001000000000005';

        const tokenId2 = BigNumber.from('990001000000000006');
        const uri2 = 'https://test.metadata/990001000000000006';

        const tokenId3 = BigNumber.from('990001000000000007');
        const uri3 = 'https://test.metadata/990001000000000007';
        const invalidTokenId = BigNumber.from('990001000000000008');

        const tokenIds = [tokenId1, tokenId2, invalidTokenId];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - TokenId provided in signature and in param are not matched
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(invalidTokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when URI - signed and param - are not matched - Single Minting', async() => {
        const tokenId = BigNumber.from('990001000000000005');
        const uri = 'https://test.metadata/990001000000000005';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);
        const invalidURI = 'https://test.metadata/invalidTokenId';

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - URI provided in signature and in param are not matched
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, invalidURI, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when URI - signed and param - are not matched - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000005');
        const uri1 = 'https://test.metadata/990001000000000005';

        const tokenId2 = BigNumber.from('990001000000000006');
        const uri2 = 'https://test.metadata/990001000000000006';

        const tokenId3 = BigNumber.from('990001000000000007');
        const uri3 = 'https://test.metadata/990001000000000007';
        const invalidURI = 'https://test.metadata/invalidTokenId';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, invalidURI];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - URI provided in signature and in param are not matched
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting without a signature - Single Minting', async() => {
        const tokenId = BigNumber.from('990001000000000005');
        const uri = 'https://test.metadata/990001000000000005';
        const emptySig = ethers.utils.arrayify(0);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request without a signature
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, uri, emptySig)    
        ).to.be.revertedWith('ECDSA: invalid signature length');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting without a signature - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000005');
        const uri1 = 'https://test.metadata/990001000000000005';

        const tokenId2 = BigNumber.from('990001000000000006');
        const uri2 = 'https://test.metadata/990001000000000006';

        const tokenId3 = BigNumber.from('990001000000000007');
        const uri3 = 'https://test.metadata/990001000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const emptySig = ethers.utils.arrayify(0);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request without a signature
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, emptySig)    
        ).to.be.revertedWith('ECDSA: invalid signature length');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a signature is given by unauthorizer - Single Minting', async() => {
        const tokenId = BigNumber.from('990001000000000005');
        const uri = 'https://test.metadata/990001000000000005';
        const signature = await verifySignature(creator, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - signature is provided by creator
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, uri, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a signature is given by unauthorizer - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000005');
        const uri1 = 'https://test.metadata/990001000000000005';

        const tokenId2 = BigNumber.from('990001000000000006');
        const uri2 = 'https://test.metadata/990001000000000006';

        const tokenId3 = BigNumber.from('990001000000000007');
        const uri3 = 'https://test.metadata/990001000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            creator, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - a signature is provided by a creator
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a signature was previously used - Single Minting', async() => {
        //  This case assumes that Creator uses a signature, provided in previous request and successfully minted, 
        //  and re-uses for multiple requests
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - signature was used in the previous request
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, uri, signature)    
        ).to.be.revertedWith('SporesRegistry: Signature was used');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        expect(await collection.ownerOf(tokenId)).deep.equal(creator.address);  
    });

    it('Should revert when a signature was previously used - Batch Minting', async() => {
        //  This case assumes that Creator uses a signature, provided in previous request and successfully minted, 
        //  and re-uses for multiple requests
        const tokenId1 = BigNumber.from('990001000000000002');
        const uri1 = 'https://test.metadata/990001000000000002';

        const tokenId2 = BigNumber.from('990001000000000003');
        const uri2 = 'https://test.metadata/990001000000000003';

        const tokenId3 = BigNumber.from('990001000000000004');
        const uri3 = 'https://test.metadata/990001000000000004';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - signature was used in the previous request
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Signature was used');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        expect(await collection.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection.ownerOf(tokenId2)).deep.equal(creator.address);
        expect(await collection.ownerOf(tokenId3)).deep.equal(creator.address);
    });

    /**********************************************************************************************************
                                                    Phase 2
    ***********************************************************************************************************/
    it('Should succeed upgrade SporesRegistry', async() => {
        const SporesRegistry_v2 = await ethers.getContractFactory('SporesRegistryUpgradeTest');
        registry = await upgrades.upgradeProxy(registry.address, SporesRegistry_v2);

        //  A mapping(address => bool) verifiers is added after other state variables in the SporesRegistry
        //  address public verifier is still existed. Thus, it must be set back to address(0)
        await registry.removeOldVerifier();

        //  Register two new Verifiers
        //  updateVerifier(verifier.address, isRemoved)
        //  isRemoved = true => delete Verifier
        //  isRemoved = false => add Verifier
        await registry.updateVerifier(verifier2.address, false);
        await registry.updateVerifier(verifier3.address, false);
    });

    it('Should succeed minting a valid TokenId - Collection 1 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('990001000000000005');
        const uri = 'https://test.metadata/990001000000000005';
        const signature = await verifySignature(verifier2, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request
        await collection.connect(creator).mint(creator.address, tokenId, uri, signature);   
       
        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore.add(1));
        expect(await collection.ownerOf(tokenId)).deep.equal(creator.address);  
    });

    it('Should succeed minting valid TokenIds - Collection 1 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('990001000000000006');
        const uri1 = 'https://test.metadata/990001000000000006';

        const tokenId2 = BigNumber.from('990001000000000007');
        const uri2 = 'https://test.metadata/990001000000000007';

        const tokenId3 = BigNumber.from('990001000000000008');
        const uri3 = 'https://test.metadata/990001000000000008';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request
        await collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature);   

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore.add(3));
        expect(await collection.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection.ownerOf(tokenId2)).deep.equal(creator.address);
        expect(await collection.ownerOf(tokenId3)).deep.equal(creator.address);
    });

    it('Should revert when a signature is given by Old Verifier - Collection 1 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('990001000000000009');
        const uri = 'https://test.metadata/990001000000000009';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - a signature is given by old verifier
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, uri, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');
       
        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a signature is given by Old Verifier - Collection 1 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('990001000000000009');
        const uri1 = 'https://test.metadata/990001000000000009';

        const tokenId2 = BigNumber.from('990001000000000010');
        const uri2 = 'https://test.metadata/990001000000000010';

        const tokenIds = [tokenId1, tokenId2];
        const uris = [uri1, uri2];
        const encodedURIs = await encodeURIs(uri1, uri2);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - a signature is given by old verifier
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when exceeds max number of editions - Collection 1 - Single Minting - After upgrading', async() => {
        //  Try to mint to make it reach a max number of editions
        const tokenId1 = BigNumber.from('990001000000000009');
        const uri1 = 'https://test.metadata/990001000000000009';

        const tokenId2 = BigNumber.from('990001000000000010');
        const uri2 = 'https://test.metadata/990001000000000010';

        const tokenIds = [tokenId1, tokenId2];
        const uris = [uri1, uri2];
        const encodedURIs = await encodeURIs(uri1, uri2);
        const signature1 = await verifySignatureBatch(
            verifier2, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2
        );
        //  Send a minting request - Try to fill-up a collection first
        await collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature1)
        expect( (await collection.subcollections(1)).maxEdition ).deep.equal(10)
        expect( (await collection.subcollections(1)).mintedAmt ).deep.equal(10)

        //  Now, assume we have a scenario that
        //  Creator tries to mint another single NFT item when a sub-collection has already reached a max number of editions
        const tokenId3 = BigNumber.from('990001000000000011');
        const uri3 = 'https://test.metadata/990001000000000011';
        const signature2 = await verifySignature(verifier2, creator.address, tokenId3, uri3, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - a sub-collection has reached the max number of editions
        await expect(
            collection.connect(creator).mint(creator.address, tokenId3, uri3, signature2)    
        ).to.be.revertedWith('Collection: Reach max edition');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when exceeds max number of editions - Collection 1 - Batch Minting - After upgrading', async() => {
        //  In the previous test, Collection contract has reached max capacity of one sub-collection
        //  Now, Creator tries to mint a batch of NFT items
        const tokenId1 = BigNumber.from('990001000000000011');
        const uri1 = 'https://test.metadata/990001000000000011';

        const tokenId2 = BigNumber.from('990001000000000012');
        const uri2 = 'https://test.metadata/990001000000000012';

        const tokenId3 = BigNumber.from('990001000000000013');
        const uri3 = 'https://test.metadata/990001000000000013';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - a sub-collection has reached the max number of editions
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: Reach max edition');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should be able to create a new Collection - After upgrading', async() => {
        const collectionId = 100;
        const maxEdition = 10;
        const collectionName = 'Collection 2';
        const requestId = 18002080;

        //  Create a signature to request adding 
        const signature = await creationSignature(verifier2, collectionId, maxEdition, requestId, deployer.address, registry.address);

        //  Create a new Collection
        const Collection = await ethers.getContractFactory('Collection', creator2);
        collection2 = await Collection.deploy(
            deployer.address, registry.address, collectionId, maxEdition, requestId, collectionName, '', signature
        );
        const receipt = await collection2.deployTransaction.wait();
        const iface = new ethers.utils.Interface(collectionABI.abi);
        const event = iface.decodeEventLog(
            'NewCollection',
            receipt.logs[1].data,
            receipt.logs[1].topics
        );
        expect(event != undefined).true;
        expect(event._collectionId).deep.equal(collectionId);
        expect(event._subCollectionId).deep.equal(1);
        expect(event._maxEdition).deep.equal(maxEdition);
        expect(event._collectionAddr).deep.equal(collection2.address);

        expect(await collection2.admin()).deep.equal(deployer.address);
        expect(await collection2.owner()).deep.equal(creator2.address);
        expect(await collection2.collectionId()).deep.equal(collectionId);
        expect(await collection2.name()).deep.equal(collectionName);
        expect(await collection2.subcollectionId()).deep.equal(1);
        expect(await collection2.registry()).deep.equal(registry.address);
        expect((await collection2.subcollections(1)).maxEdition).deep.equal(maxEdition);
        expect((await collection2.subcollections(1)).mintedAmt).deep.equal(0);
    });

    // it('Should revert when Creator2 tries to mint NFT item (single), but Collection2 not registered - After upgrading', async() => {
    //     const tokenId = BigNumber.from('1000001000000000001');
    //     const uri = 'https://test.metadata/1000001000000000001';
    //     const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

    //     //  Send a minting request when Collection has not yet registered
    //     await expect(
    //         collection2.connect(creator2).mint(creator2.address, tokenId, uri, signature)    
    //     ).to.be.revertedWith('SporesRegistry: Unauthorized');

    //     expect(collection2.balanceOf(creator2.address)).deep.equal(0);
    //     await expect(
    //         collection2.ownerOf(tokenId)    
    //     ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    // });

    // it('Should revert when Creator2 tries to mint NFT items (batch), but Collection2 not registered - After upgrading', async() => {
    //     const tokenId1 = BigNumber.from('1000001000000000001');
    //     const uri1 = 'https://test.metadata/1000001000000000001';

    //     const tokenId2 = BigNumber.from('1000001000000000002');
    //     const uri2 = 'https://test.metadata/1000001000000000002';

    //     const tokenId3 = BigNumber.from('1000001000000000003');
    //     const uri3 = 'https://test.metadata/1000001000000000003';

    //     const tokenIds = [tokenId1, tokenId2, tokenId3];
    //     const uris = [uri1, uri2, uri3];
    //     const encodedURIs = await encodeURIs(uri1, uri2, uri3);
    //     const signature = await verifySignatureBatch(
    //         verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
    //     );

    //     //  Send a minting request when Collection has not yet registered
    //     await expect(
    //         collection2.connect(creator2).mint(creator2.address, tokenIds, uris, signature)    
    //     ).to.be.revertedWith('SporesRegistry: Unauthorized');

    //     expect(collection2.balanceOf(creator2.address)).deep.equal(0);
    //     await expect(
    //         collection2.ownerOf(tokenId1)    
    //     ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    //     await expect(
    //         collection2.ownerOf(tokenId2)    
    //     ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    //     await expect(
    //         collection2.ownerOf(tokenId3)    
    //     ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    // });

    it('Should succeed when minting a valid TokenId - Collection 2 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('1000001000000000001');
        const uri = 'https://test.metadata/1000001000000000001';
        const signature = await verifySignature(verifier2, creator2.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request
        await collection2.connect(creator2).mint(creator2.address, tokenId, uri, signature);   
       
        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore.add(1));
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator2.address);  
    });

    it('Should succeed when minting valid TokenIds - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000001000000000002');
        const uri1 = 'https://test.metadata/1000001000000000002';

        const tokenId2 = BigNumber.from('1000001000000000003');
        const uri2 = 'https://test.metadata/1000001000000000003';

        const tokenId3 = BigNumber.from('1000001000000000004');
        const uri3 = 'https://test.metadata/1000001000000000004';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request
        await collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature);   

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore.add(3));
        expect(await collection2.ownerOf(tokenId1)).deep.equal(creator2.address);
        expect(await collection2.ownerOf(tokenId2)).deep.equal(creator2.address);
        expect(await collection2.ownerOf(tokenId3)).deep.equal(creator2.address);
    });

    it('Should revert when creator requests minting, but tokenId exists - Collection 2 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('1000001000000000001');
        const uri = 'https://test.metadata/1000001000000000001';
        const signature = await verifySignature(verifier3, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore1 = await collection2.balanceOf(creator.address);
        const balanceBefore2 = await collection2.balanceOf(creator2.address);
        //  Send a minting request, but tokenID exists
        await expect(
            collection2.connect(creator2).mint(creator.address, tokenId, uri, signature)    
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await collection2.balanceOf(creator.address)).deep.equal(balanceBefore1);
        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore2);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator2.address);
    });

    it('Should revert when creator requests minting, but tokenId exists - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000001000000000005');
        const uri1 = 'https://test.metadata/1000001000000000005';

        const tokenId2 = BigNumber.from('1000001000000000006');
        const uri2 = 'https://test.metadata/1000001000000000006';

        const tokenId3 = BigNumber.from('1000001000000000004');  // minted
        const uri3 = 'https://test.metadata/1000001000000000004';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore1 = await collection2.balanceOf(creator.address);
        const balanceBefore2 = await collection2.balanceOf(creator2.address);
        //  Send a minting request, but tokenID exists
        await expect(
            collection2.connect(creator2).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await collection2.balanceOf(creator.address)).deep.equal(balanceBefore1);
        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore2);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collection2.ownerOf(tokenId3)).deep.equal(creator2.address); 
    });

    it('Should revert when collectionId of minting TokenId does not match Collection ID - Collection 2 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('980001000000000005');
        const uri = 'https://test.metadata/980001000000000005';
        const signature = await verifySignature(verifier3, creator2.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - collectionId, derived from TokenId, not match CollectionId of a contract
        await expect(
            collection2.connect(creator2).mint(creator2.address, tokenId, uri, signature)    
        ).to.be.revertedWith('Collection: Invalid collection');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when collectionId of minting TokenIds does not match Collection ID - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('980001000000000005');
        const uri1 = 'https://test.metadata/980001000000000005';

        const tokenId2 = BigNumber.from('980001000000000006');
        const uri2 = 'https://test.metadata/980001000000000006';

        const tokenId3 = BigNumber.from('980001000000000007');
        const uri3 = 'https://test.metadata/980001000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - collectionId, derived from TokenId, not match CollectionId of a contract
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: Invalid collection');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when subcollectionId of minting TokenId is invalid - Collection 2 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('1000002000000000005');
        const uri = 'https://test.metadata/1000002000000000005';
        const signature = await verifySignature(verifier2, creator2.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - subcollectionId, derived from TokenId, not match subcollectionId of a contract
        //  This Collection's version supports only one sub-collection in a collection
        await expect(
            collection2.connect(creator2).mint(creator2.address, tokenId, uri, signature)    
        ).to.be.revertedWith('Collection: Reach max edition');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when subcollectionId of minting TokenIds is invalid - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000002000000000005');
        const uri1 = 'https://test.metadata/1000002000000000005';

        const tokenId2 = BigNumber.from('1000002000000000006');
        const uri2 = 'https://test.metadata/1000002000000000006';

        const tokenId3 = BigNumber.from('1000002000000000007');
        const uri3 = 'https://test.metadata/1000002000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier2, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - subcollectionId, derived from TokenId, not match subcollectionId of a contract
        //  This Collection's version supports only one sub-collection in a collection
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: Reach max edition');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when TokenIds and URIs not match - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000001000000000005');
        const uri1 = 'https://test.metadata/1000001000000000005';

        const tokenId2 = BigNumber.from('1000001000000000006');
        const uri2 = 'https://test.metadata/1000001000000000006';

        const tokenId3 = BigNumber.from('1000001000000000007');
        const uri3 = 'https://test.metadata/1000001000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier2, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - tokenIds and URIs not match respectively
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: TokenIDs and URIs not match');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting TokenIds of multiple sub-collections - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000001000000000005');
        const uri1 = 'https://test.metadata/1000001000000000005';

        const tokenId2 = BigNumber.from('1000002000000000006');
        const uri2 = 'https://test.metadata/1000002000000000006';

        const tokenId3 = BigNumber.from('1000003000000000007');
        const uri3 = 'https://test.metadata/1000003000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - tokenIds of multiple sub-collections
        //  This Collection's version supports only one sub-collection in a collection
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: Invalid TokenIds');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when Receiver - signed and param - are not matched - Collection 2 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('1000001000000000005');
        const uri = 'https://test.metadata/1000001000000000005';
        const signature = await verifySignature(verifier3, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore1 = await collection2.balanceOf(creator.address);
        const balanceBefore2 = await collection2.balanceOf(creator2.address);
        //  Send a minting request - Receiver provided in signature and in param are not matched
        await expect(
            collection2.connect(creator2).mint(creator2.address, tokenId, uri, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection2.balanceOf(creator.address)).deep.equal(balanceBefore1);
        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore2);
        await expect(
            collection2.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when Receiver - signed and param - are not matched - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000001000000000005');
        const uri1 = 'https://test.metadata/1000001000000000005';

        const tokenId2 = BigNumber.from('1000001000000000006');
        const uri2 = 'https://test.metadata/1000001000000000006';

        const tokenId3 = BigNumber.from('1000001000000000008');
        const uri3 = 'https://test.metadata/1000001000000000008';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier2, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore1 = await collection2.balanceOf(creator.address);
        const balanceBefore2 = await collection2.balanceOf(creator2.address);
        //  Send a minting request - Receiver provided in signature and in param are not matched
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection2.balanceOf(creator.address)).deep.equal(balanceBefore1);
        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore2);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when tokenId - signed and param - are not matched - Collection 2 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('1000001000000000005');
        const uri = 'https://test.metadata/1000001000000000005';
        const signature = await verifySignature(verifier2, creator2.address, tokenId, uri, ERC721_MINT);
        const invalidTokenId = BigNumber.from('1000001000000000006');

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - TokenId provided in signature and in param are not matched
        await expect(
            collection2.connect(creator2).mint(creator2.address, invalidTokenId, uri, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(invalidTokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when tokenId - signed and param - are not matched - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000001000000000005');
        const uri1 = 'https://test.metadata/1000001000000000005';

        const tokenId2 = BigNumber.from('1000001000000000006');
        const uri2 = 'https://test.metadata/1000001000000000006';

        const tokenId3 = BigNumber.from('1000001000000000007');
        const uri3 = 'https://test.metadata/1000001000000000007';
        const invalidTokenId = BigNumber.from('1000001000000000008');

        const tokenIds = [tokenId1, tokenId2, invalidTokenId];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - TokenId provided in signature and in param are not matched
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(invalidTokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when URI - signed and param - are not matched - Collection 2 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('1000001000000000005');
        const uri = 'https://test.metadata/1000001000000000005';
        const signature = await verifySignature(verifier3, creator2.address, tokenId, uri, ERC721_MINT);
        const invalidURI = 'https://test.metadata/invalidTokenId';

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - URI provided in signature and in param are not matched
        await expect(
            collection2.connect(creator2).mint(creator2.address, tokenId, invalidURI, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when URI - signed and param - are not matched - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000001000000000005');
        const uri1 = 'https://test.metadata/1000001000000000005';

        const tokenId2 = BigNumber.from('1000001000000000006');
        const uri2 = 'https://test.metadata/1000001000000000006';

        const tokenId3 = BigNumber.from('1000001000000000007');
        const uri3 = 'https://test.metadata/1000001000000000007';
        const invalidURI = 'https://test.metadata/invalidTokenId';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, invalidURI];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - URI provided in signature and in param are not matched
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting without a signature - Collection 2 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('1000001000000000005');
        const uri = 'https://test.metadata/1000001000000000005';
        const emptySig = ethers.utils.arrayify(0);

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request without a signature
        await expect(
            collection2.connect(creator2).mint(creator2.address, tokenId, uri, emptySig)    
        ).to.be.revertedWith('ECDSA: invalid signature length');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting without a signature - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000001000000000005');
        const uri1 = 'https://test.metadata/1000001000000000005';

        const tokenId2 = BigNumber.from('1000001000000000006');
        const uri2 = 'https://test.metadata/1000001000000000006';

        const tokenId3 = BigNumber.from('1000001000000000007');
        const uri3 = 'https://test.metadata/1000001000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const emptySig = ethers.utils.arrayify(0);

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request without a signature
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, emptySig)    
        ).to.be.revertedWith('ECDSA: invalid signature length');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a signature is given by unauthorizer - Collection 2 - Single Minting - After upgrading', async() => {
        const tokenId = BigNumber.from('1000001000000000005');
        const uri = 'https://test.metadata/1000001000000000005';
        const signature = await verifySignature(creator, creator2.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - signature is provided by creator
        await expect(
            collection2.connect(creator2).mint(creator2.address, tokenId, uri, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a signature is given by unauthorizer - Collection 2 - Batch Minting - After upgrading', async() => {
        const tokenId1 = BigNumber.from('1000001000000000005');
        const uri1 = 'https://test.metadata/1000001000000000005';

        const tokenId2 = BigNumber.from('1000001000000000006');
        const uri2 = 'https://test.metadata/1000001000000000006';

        const tokenId3 = BigNumber.from('1000001000000000007');
        const uri3 = 'https://test.metadata/1000001000000000007';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            creator, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - a signature is provided by a creator
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a signature was previously used - Collection 2 - Single Minting - After upgrading', async() => {
        //  This case assumes that Creator2 uses a signature, provided in previous request and successfully minted, 
        //  and re-uses for multiple requests
        const tokenId = BigNumber.from('1000001000000000001');
        const uri = 'https://test.metadata/1000001000000000001';
        const signature = await verifySignature(verifier2, creator2.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - signature was used in the previous request
        await expect(
            collection2.connect(creator2).mint(creator2.address, tokenId, uri, signature)    
        ).to.be.revertedWith('SporesRegistry: Signature was used');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator2.address);  
    });

    it('Should revert when a signature was previously used - Collection 2 - Batch Minting - After upgrading', async() => {
        //  This case assumes that Creator2 uses a signature, provided in previous request and successfully minted, 
        //  and re-uses for multiple requests
        const tokenId1 = BigNumber.from('1000001000000000002');
        const uri1 = 'https://test.metadata/1000001000000000002';

        const tokenId2 = BigNumber.from('1000001000000000003');
        const uri2 = 'https://test.metadata/1000001000000000003';

        const tokenId3 = BigNumber.from('1000001000000000004');
        const uri3 = 'https://test.metadata/1000001000000000004';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - signature was used in the previous request
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('SporesRegistry: Signature was used');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        expect(await collection2.ownerOf(tokenId1)).deep.equal(creator2.address);
        expect(await collection2.ownerOf(tokenId2)).deep.equal(creator2.address);
        expect(await collection2.ownerOf(tokenId3)).deep.equal(creator2.address);
    });

    it('Should revert when exceeds max number of editions - Collection 2 - Single Minting - After upgrading', async() => {
        //  Try to mint to make it reach a max number of editions
        const tokenId1 = BigNumber.from('1000001000000000005');
        const uri1 = 'https://test.metadata/1000001000000000005';

        const tokenId2 = BigNumber.from('1000001000000000006');
        const uri2 = 'https://test.metadata/1000001000000000006';

        const tokenId3 = BigNumber.from('1000001000000000007');
        const uri3 = 'https://test.metadata/1000001000000000007';

        const tokenId4 = BigNumber.from('1000001000000000008');
        const uri4 = 'https://test.metadata/1000001000000000008';

        const tokenId5 = BigNumber.from('1000001000000000009');
        const uri5 = 'https://test.metadata/1000001000000000009';

        const tokenId6 = BigNumber.from('1000001000000000010');
        const uri6 = 'https://test.metadata/1000001000000000010';

        const tokenIds = [tokenId1, tokenId2, tokenId3, tokenId4, tokenId5, tokenId6];
        const uris = [uri1, uri2, uri3, uri4, uri5, uri6];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3, uri4, uri5, uri6);
        const signature1 = await verifySignatureBatch(
            verifier2, creator2.address, encodedURIs, ERC721_MINT,
            tokenId1, tokenId2, tokenId3, tokenId4, tokenId5, tokenId6
        );
        //  Send a minting request - Try to fill-up a collection first
        await collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature1)
        expect( (await collection2.subcollections(1)).maxEdition ).deep.equal(10)
        expect( (await collection2.subcollections(1)).mintedAmt ).deep.equal(10)

        //  Now, assume we have a scenario that
        //  Creator tries to mint another single NFT item when a sub-collection has already reached a max number of editions
        const tokenId7 = BigNumber.from('1000001000000000011');
        const uri7 = 'https://test.metadata/1000001000000000011';
        const signature2 = await verifySignature(verifier2, creator2.address, tokenId7, uri7, ERC721_MINT);

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - a sub-collection has reached the max number of editions
        await expect(
            collection2.connect(creator2).mint(creator2.address, tokenId7, uri7, signature2)    
        ).to.be.revertedWith('Collection: Reach max edition');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId7)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when exceeds max number of editions - Collection 2 - Batch Minting - After upgrading', async() => {
        //  In the previous test, Collection 2 contract has reached max capacity of one sub-collection
        //  Now, Creator2 tries to mint a batch of NFT items
        const tokenId1 = BigNumber.from('1000001000000000011');
        const uri1 = 'https://test.metadata/1000001000000000011';

        const tokenId2 = BigNumber.from('1000001000000000012');
        const uri2 = 'https://test.metadata/1000001000000000012';

        const tokenId3 = BigNumber.from('1000001000000000013');
        const uri3 = 'https://test.metadata/1000001000000000013';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier3, creator2.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection2.balanceOf(creator2.address);
        //  Send a minting request - a sub-collection has reached the max number of editions
        await expect(
            collection2.connect(creator2).mintBatch(creator2.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('Collection: Reach max edition');

        expect(await collection2.balanceOf(creator2.address)).deep.equal(balanceBefore);
        await expect(
            collection2.ownerOf(tokenId1)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId2)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collection2.ownerOf(tokenId3)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });
});