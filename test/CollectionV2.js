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

describe('CollectionV2 Contract Testing', () => {
    let admin, creator, verifier, treasury, buyer;
    let token721, token1155, collection;
    let market;
    before(async() => {
        //  Get pre-fund accounts
        [admin, creator, verifier, treasury, buyer, market] = await ethers.getSigners();

        //  Deploy and initialize SporesNFT721 contract
        //  SporesNFT721 contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesNFT721 = await ethers.getContractFactory('SporesNFT721', admin);
        token721 = await SporesNFT721.deploy();
        token721.init('Spores NFT', 'SPONFT');

        //  Deploy and initialize SporesNFT1155 contract
        //  SporesNFT1155 contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesNFT1155 = await ethers.getContractFactory('SporesNFT1155', admin);
        token1155 = await SporesNFT1155.deploy();
        token1155.init();

        //  Deploy and initialize SporesRegistry contract
        //  SporesRegistry contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesRegistry = await ethers.getContractFactory('SporesRegistry', admin);
        const supportTokens = [];
        registry = await upgrades.deployProxy(
            SporesRegistry,
            [treasury.address, verifier.address, token721.address, token1155.address, supportTokens],
            {initializer: 'init'}
        );
        await registry.deployed();
        
        //  market.address is a contract of SporesNFTMarket
        await registry.connect(admin).updateMarket(market.address);
    });

    it('Should be able to create a new Collection', async() => {
        const collectionId = 99;
        const maxEdition = 10;
        const collectionName = 'CollectionV2 - Collection 1';
        const requestId = 18002080;
        //  Create a signature to request adding 
        const signature = await creationSignature(verifier, collectionId, maxEdition, requestId, admin.address, registry.address);

        //  Create a new Collection
        const Collection = await ethers.getContractFactory('CollectionV2', creator);
        collection = await Collection.deploy(
            admin.address, registry.address, collectionId, maxEdition, requestId, collectionName, '', signature
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

        expect(await collection.admin()).deep.equal(admin.address);
        expect(await collection.owner()).deep.equal(creator.address);
        expect(await collection.collectionId()).deep.equal(collectionId);
        expect(await collection.name()).deep.equal(collectionName);
        expect(await collection.subcollectionId()).deep.equal(1);
        expect(await collection.registry()).deep.equal(registry.address);
        expect((await collection.subcollections(1)).maxEdition).deep.equal(maxEdition);
        expect((await collection.subcollections(1)).mintedAmt).deep.equal(0);
    });

    it('Should revert when non-admin role tries to update Registry contract', async() => {
        await expect(
            collection.connect(creator).updateRegistry(treasury.address)    
        ).to.be.revertedWith('CollectionV2: Unauthorized');

        //  Expect Registry contract remains unchanged
        expect(await collection.registry()).deep.equal(registry.address);
    });

    it('Should succeed when admin roles tries to update Registry contract', async() => {
        //  Assume Treasury is a SporesRegistry
        await collection.connect(admin).updateRegistry(treasury.address);
        //  Expect Registry contract is updated
        expect(await collection.registry()).deep.equal(treasury.address);

        //  Change back to normal
        await collection.connect(admin).updateRegistry(registry.address);
        //  Expect Registry contract is set back to normal
        expect(await collection.registry()).deep.equal(registry.address);
    });

    it('Should revert when non-creator tries to add sub-collection', async() => {
        const subCollectionId = 2;
        const maxEdition = 20;
        const infoBefore = await collection.subcollections(subCollectionId);

        await expect(
            collection.connect(admin).addSubCollection(maxEdition)    
        ).to.be.revertedWith('Ownable: caller is not the owner');

        const infoAfter = await collection.subcollections(subCollectionId);

        expect(infoBefore.maxEdition).deep.equal(ethers.constants.Zero);
        expect(infoBefore.mintedAmt).deep.equal(ethers.constants.Zero);
        expect(infoAfter.maxEdition).deep.equal(ethers.constants.Zero);
        expect(infoAfter.mintedAmt).deep.equal(ethers.constants.Zero);
    });

    it('Should revert when Creator tries to add sub-collection, but maxEdition is zero', async() => {
        const subCollectionId = 2;
        const maxEdition = 0;
        const infoBefore = await collection.subcollections(subCollectionId);

        await expect(
            collection.connect(creator).addSubCollection(maxEdition)    
        ).to.be.revertedWith('CollectionV2: Max Edition is non-zero');

        const infoAfter = await collection.subcollections(subCollectionId);

        expect(infoBefore.maxEdition).deep.equal(ethers.constants.Zero);
        expect(infoBefore.mintedAmt).deep.equal(ethers.constants.Zero);
        expect(infoAfter.maxEdition).deep.equal(ethers.constants.Zero);
        expect(infoAfter.mintedAmt).deep.equal(ethers.constants.Zero);
    });

    it('Should succeed when Creator adds sub-collection with valid settings', async() => {
        const collectionId = 99;
        const subCollectionId = 2;
        const maxEdition = 20;
        const infoBefore = await collection.subcollections(subCollectionId);

        const tx = await collection.connect(creator).addSubCollection(maxEdition);
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'NewCollection' });

        expect(event != undefined).true;
        expect(event.args._collectionId).deep.equal(collectionId);
        expect(event.args._subCollectionId).deep.equal(2);
        expect(event.args._maxEdition).deep.equal(maxEdition);
        expect(event.args._collectionAddr).deep.equal(collection.address);

        const infoAfter = await collection.subcollections(subCollectionId);

        expect(infoBefore.maxEdition).deep.equal(ethers.constants.Zero);
        expect(infoBefore.mintedAmt).deep.equal(ethers.constants.Zero);
        expect(infoAfter.maxEdition).deep.equal(maxEdition);
        expect(infoAfter.mintedAmt).deep.equal(ethers.constants.Zero);
    });

    it('Should revert when non-authorize caller tries to call lazymint() - Creator', async() => {
        //  The 'CollectionV2' supports lazy minting only
        //  This collection version NOT support Single and Batch minting
        //  The method lazymint() is retricted to be called by SporesNFTMarket
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';

        const balanceBefore = await collection.balanceOf(creator.address);

        //  Creator sends a minting request
        await expect(
            collection.connect(creator).lazymint(creator.address, creator.address, tokenId, uri)   
        ).to.be.revertedWith('CollectionV2: Unauthorized');
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when non-authorize caller tries to call lazymint() - Admin', async() => {
        //  The 'CollectionV2' supports lazy minting only
        //  This collection version NOT support Single and Batch minting
        //  The method lazymint() is retricted to be called by SporesNFTMarket
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';
        const maxEdition = 10;
        const subCollectionId = 1;

        const balanceBefore = await collection.balanceOf(creator.address);

        //  Admin sends a minting request
        await expect(
            collection.connect(admin).lazymint(creator.address, creator.address, tokenId, uri)   
        ).to.be.revertedWith('CollectionV2: Unauthorized');
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(ethers.constants.Zero);
        await expect(
            collection.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when SporesNFTMarket requests mint token, but invalid info - Invalid Creator', async() => {
        //  Lazy minting: When Buyer purchases 'on sale' item
        //  Voucher, which contains approval and authorized signatures, is passed to SporesNFTMarket
        //  Once these are verified, the request will be forwarded to Collection contract to mint an item:
        //      + Mint item to Creator
        //      + Transfer item to Buyer
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';
        const maxEdition = 10;
        const subCollectionId = 1;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);

        //  Assume Market is SporesNFTMarket
        //  Market sends a minting request
        await expect(
            collection.connect(market).lazymint(buyer.address, buyer.address, tokenId, uri)   
        ).to.be.revertedWith('CollectionV2: Invalid creator');
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal(balBuyerBefore);
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(ethers.constants.Zero);
        await expect(
            collection.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when SporesNFTMarket requests mint token, but invalid info - Invalid CollectionID', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        //  But, the `tokenId` belongs to CollectionID = 88
        //  Thus, maxEdition = 0 -> revert
        const tokenId = BigNumber.from('880001000000000001');
        const uri = 'https://test.metadata/880001000000000001';
        const maxEdition = 10;
        const subCollectionId = 1;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);

        //  Market sends a minting request
        await expect(
            collection.connect(market).lazymint(creator.address, buyer.address, tokenId, uri)   
        ).to.be.revertedWith('CollectionV2: Invalid collection');
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal(balBuyerBefore);
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(ethers.constants.Zero);
        await expect(
            collection.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when SporesNFTMarket requests mint token, but invalid info - Invalid Sub-collectionID', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        //  But, the `tokenId` belongs to sub-collectionId = 3
        //  Thus, maxEdition = 0 -> revert
        const tokenId = BigNumber.from('990003000000000001');
        const uri = 'https://test.metadata/990003000000000001';
        const subCollectionId = 3;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);

        //  Market sends a minting request
        await expect(
            collection.connect(market).lazymint(creator.address, buyer.address, tokenId, uri)   
        ).to.be.revertedWith('CollectionV2: Reach max edition');
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal(balBuyerBefore);
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(ethers.constants.Zero);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(ethers.constants.Zero);
        await expect(
            collection.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should succeed when SporesNFTMarket requests mint token with valid settings - Sub-Collection = 1', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';
        const maxEdition = 10;
        const subCollectionId = 1;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);
        const mintedAmtBefore = (await collection.subcollections(subCollectionId)).mintedAmt;

        //  Market sends a minting request
        const tx = await collection.connect(market).lazymint(creator.address, buyer.address, tokenId, uri);
        const receipt = await tx.wait();
        let event1 = receipt.events.find(e => { return e.event == 'CollectionMintSingle' }); 
        let event2 = receipt.events.filter(e => { return e.event == 'Transfer' });

        expect(event1 != undefined).true;
        expect(event1.args._to).deep.equal(buyer.address);
        expect(event1.args._nft).deep.equal(collection.address);
        expect(event1.args._id).deep.equal(tokenId);

        expect(event2 != undefined).true;
        expect(event2.length).deep.equal(2);
        expect(event2[0].args.from).deep.equal(ethers.constants.AddressZero);
        expect(event2[0].args.to).deep.equal(creator.address);
        expect(event2[0].args.tokenId).deep.equal(tokenId);
        expect(event2[1].args.from).deep.equal(creator.address);
        expect(event2[1].args.to).deep.equal(buyer.address);
        expect(event2[1].args.tokenId).deep.equal(tokenId);
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal( balBuyerBefore.add(1) );
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(mintedAmtBefore.add(1));   
        expect(await collection.ownerOf(tokenId)).deep.equal(buyer.address); 
    });

    it('Should succeed when SporesNFTMarket requests mint token with valid settings - Sub-Collection = 2', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990002000000000001');
        const uri = 'https://test.metadata/990002000000000001';
        const maxEdition = 20;
        const subCollectionId = 2;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);
        const mintedAmtBefore = (await collection.subcollections(subCollectionId)).mintedAmt;

        //  Market sends a minting request
        const tx = await collection.connect(market).lazymint(creator.address, buyer.address, tokenId, uri);
        const receipt = await tx.wait();
        let event1 = receipt.events.find(e => { return e.event == 'CollectionMintSingle' }); 
        let event2 = receipt.events.filter(e => { return e.event == 'Transfer' });

        expect(event1 != undefined).true;
        expect(event1.args._to).deep.equal(buyer.address);
        expect(event1.args._nft).deep.equal(collection.address);
        expect(event1.args._id).deep.equal(tokenId);

        expect(event2 != undefined).true;
        expect(event2.length).deep.equal(2);
        expect(event2[0].args.from).deep.equal(ethers.constants.AddressZero);
        expect(event2[0].args.to).deep.equal(creator.address);
        expect(event2[0].args.tokenId).deep.equal(tokenId);
        expect(event2[1].args.from).deep.equal(creator.address);
        expect(event2[1].args.to).deep.equal(buyer.address);
        expect(event2[1].args.tokenId).deep.equal(tokenId);
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal( balBuyerBefore.add(1) );
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(mintedAmtBefore.add(1));   
        expect(await collection.ownerOf(tokenId)).deep.equal(buyer.address); 
    });

    it('Should revert when SporesNFTMarket requests mint token, but tokenID already minted - Sub-Collection = 1', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';
        const maxEdition = 10;
        const subCollectionId = 1;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);
        const mintedAmtBefore = (await collection.subcollections(subCollectionId)).mintedAmt;

        //  Market sends a minting request
        //  but `tokenId` has been already minted
        await expect(
            collection.connect(market).lazymint(creator.address, buyer.address, tokenId, uri)
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal(balBuyerBefore);
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(mintedAmtBefore); 
        expect(await collection.ownerOf(tokenId)).deep.equal(buyer.address); 
    });

    it('Should revert when SporesNFTMarket requests mint token, but tokenID already minted - Sub-Collection = 2', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990002000000000001');
        const uri = 'https://test.metadata/990002000000000001';
        const maxEdition = 20;
        const subCollectionId = 2;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);
        const mintedAmtBefore = (await collection.subcollections(subCollectionId)).mintedAmt;

        //  Market sends a minting request
        //  but `tokenId` has been already minted
        await expect(
            collection.connect(market).lazymint(creator.address, buyer.address, tokenId, uri)
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal(balBuyerBefore);
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(mintedAmtBefore); 
        expect(await collection.ownerOf(tokenId)).deep.equal(buyer.address); 
    });

    it('Should succeed when SporesNFTMarket requests mint additional token with valid settings - Sub-Collection = 1', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990001000000000002');
        const uri = 'https://test.metadata/990001000000000002';
        const maxEdition = 10;
        const subCollectionId = 1;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);
        const mintedAmtBefore = (await collection.subcollections(subCollectionId)).mintedAmt;

        //  Market sends a minting request
        const tx = await collection.connect(market).lazymint(creator.address, buyer.address, tokenId, uri);
        const receipt = await tx.wait();
        let event1 = receipt.events.find(e => { return e.event == 'CollectionMintSingle' }); 
        let event2 = receipt.events.filter(e => { return e.event == 'Transfer' });

        expect(event1 != undefined).true;
        expect(event1.args._to).deep.equal(buyer.address);
        expect(event1.args._nft).deep.equal(collection.address);
        expect(event1.args._id).deep.equal(tokenId);

        expect(event2 != undefined).true;
        expect(event2.length).deep.equal(2);
        expect(event2[0].args.from).deep.equal(ethers.constants.AddressZero);
        expect(event2[0].args.to).deep.equal(creator.address);
        expect(event2[0].args.tokenId).deep.equal(tokenId);
        expect(event2[1].args.from).deep.equal(creator.address);
        expect(event2[1].args.to).deep.equal(buyer.address);
        expect(event2[1].args.tokenId).deep.equal(tokenId);
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal( balBuyerBefore.add(1) );
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(mintedAmtBefore.add(1)); 
        expect(await collection.ownerOf(tokenId)).deep.equal(buyer.address); 
    });

    it('Should succeed when SporesNFTMarket requests mint additional token with valid settings - Sub-Collection = 2', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990002000000000002');
        const uri = 'https://test.metadata/990002000000000002';
        const maxEdition = 20;
        const subCollectionId = 2;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);
        const mintedAmtBefore = (await collection.subcollections(subCollectionId)).mintedAmt;

        //  Market sends a minting request
        const tx = await collection.connect(market).lazymint(creator.address, buyer.address, tokenId, uri);
        const receipt = await tx.wait();
        let event1 = receipt.events.find(e => { return e.event == 'CollectionMintSingle' }); 
        let event2 = receipt.events.filter(e => { return e.event == 'Transfer' });

        expect(event1 != undefined).true;
        expect(event1.args._to).deep.equal(buyer.address);
        expect(event1.args._nft).deep.equal(collection.address);
        expect(event1.args._id).deep.equal(tokenId);

        expect(event2 != undefined).true;
        expect(event2.length).deep.equal(2);
        expect(event2[0].args.from).deep.equal(ethers.constants.AddressZero);
        expect(event2[0].args.to).deep.equal(creator.address);
        expect(event2[0].args.tokenId).deep.equal(tokenId);
        expect(event2[1].args.from).deep.equal(creator.address);
        expect(event2[1].args.to).deep.equal(buyer.address);
        expect(event2[1].args.tokenId).deep.equal(tokenId);
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal( balBuyerBefore.add(1) );
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(mintedAmtBefore.add(1)); 
        expect(await collection.ownerOf(tokenId)).deep.equal(buyer.address); 
    });
})