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

describe('CollectionV3 Contract Testing', () => {
    let admin, creator, verifier, treasury, buyer, creator2;
    let token721, token1155, collection, collection2;
    let market;
    before(async() => {
        //  Get pre-fund accounts
        [admin, creator, verifier, treasury, buyer, creator2, market] = await ethers.getSigners();

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
        const collectionName = 'CollectionV3 - Collection 1';
        const requestId = 18002080;
        //  Create a signature to request adding 
        const signature = await creationSignature(verifier, collectionId, maxEdition, requestId, admin.address, registry.address);

        //  Create a new Collection
        const Collection = await ethers.getContractFactory('CollectionV3', creator);
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
        ).to.be.revertedWith('CollectionV3: Unauthorized');

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
        ).to.be.revertedWith('CollectionV3: Max Edition is non-zero');

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
        //  The 'CollectionV3' supports lazy minting
        //  The method lazymint() is retricted to be called by SporesNFTMarket
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';

        const balanceBefore = await collection.balanceOf(creator.address);

        //  Creator sends a minting request
        await expect(
            collection.connect(creator).lazymint(creator.address, creator.address, tokenId, uri)   
        ).to.be.revertedWith('CollectionV3: Unauthorized');
        
        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when non-authorize caller tries to call lazymint() - Admin', async() => {
        //  The 'CollectionV3' supports lazy minting
        //  The method lazymint() is retricted to be called by SporesNFTMarket
        const tokenId = BigNumber.from('990001000000000001');
        const uri = 'https://test.metadata/990001000000000001';
        const maxEdition = 10;
        const subCollectionId = 1;

        const balanceBefore = await collection.balanceOf(creator.address);

        //  Admin sends a minting request
        await expect(
            collection.connect(admin).lazymint(creator.address, creator.address, tokenId, uri)   
        ).to.be.revertedWith('CollectionV3: Unauthorized');
        
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
        ).to.be.revertedWith('CollectionV3: Invalid creator');
        
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
        ).to.be.revertedWith('CollectionV3: Invalid collection');
        
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
        ).to.be.revertedWith('CollectionV3: Reach max edition');
        
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

    it('Should succeed when minting a valid TokenId - Single Minting', async() => {
        const tokenId = BigNumber.from('990001000000000003');
        const uri = 'https://test.metadata/990001000000000003';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request when Collection has registered
        await collection.connect(creator).mint(creator.address, tokenId, uri, signature)    

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore.add(1));
        expect(await collection.ownerOf(tokenId)).deep.equal(creator.address);
    });

    it('Should succeed when minting valid TokenIds - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000004');
        const uri1 = 'https://test.metadata/990001000000000004';

        const tokenId2 = BigNumber.from('990001000000000005');
        const uri2 = 'https://test.metadata/990001000000000005';

        const tokenId3 = BigNumber.from('990001000000000006');
        const uri3 = 'https://test.metadata/990001000000000006';

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
        expect(await collection.ownerOf(tokenId)).deep.equal(buyer.address);
    });

    it('Should revert when creator requests minting, but tokenId exists - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000007');
        const uri1 = 'https://test.metadata/990001000000000007';

        const tokenId2 = BigNumber.from('990001000000000008');
        const uri2 = 'https://test.metadata/990001000000000008';

        const tokenId3 = BigNumber.from('990001000000000002');  // minted
        const uri3 = 'https://test.metadata/990001000000000002';

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
        expect(await collection.ownerOf(tokenId3)).deep.equal(buyer.address); 
    });

    it('Should revert when collectionId of minting TokenId does not match Collection ID - Single Minting', async() => {
        const tokenId = BigNumber.from('980001000000000007');
        const uri = 'https://test.metadata/980001000000000007';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - collectionId, derived from TokenId, not match CollectionId of a contract
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, uri, signature)    
        ).to.be.revertedWith('CollectionV3: Invalid collection');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when collectionId of minting TokenIds does not match Collection ID - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('980001000000000007');
        const uri1 = 'https://test.metadata/980001000000000007';

        const tokenId2 = BigNumber.from('980001000000000008');
        const uri2 = 'https://test.metadata/980001000000000008';

        const tokenId3 = BigNumber.from('980001000000000009');
        const uri3 = 'https://test.metadata/980001000000000009';

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
        ).to.be.revertedWith('CollectionV3: Invalid collection');

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
        const tokenId = BigNumber.from('990003000000000007');
        const uri = 'https://test.metadata/990003000000000007';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - subcollectionId, derived from TokenId, not match subcollectionId of a contract
        //  This Collection's version supports multiple sub-collections in a collection
        //  Currently, there are only two sub-collections in the contract
        await expect(
            collection.connect(creator).mint(creator.address, tokenId, uri, signature)    
        ).to.be.revertedWith('CollectionV3: Reach max edition');

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore);
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when subcollectionId of minting TokenIds is invalid - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990003000000000007');
        const uri1 = 'https://test.metadata/990003000000000007';

        const tokenId2 = BigNumber.from('990003000000000008');
        const uri2 = 'https://test.metadata/990003000000000008';

        const tokenId3 = BigNumber.from('990003000000000009');
        const uri3 = 'https://test.metadata/990003000000000009';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - subcollectionId, derived from TokenId, not match subcollectionId of a contract
        //  This Collection's version supports multiple sub-collections in a collection
        //  Currently, there are only two sub-collections in the contract
        await expect(
            collection.connect(creator).mintBatch(creator.address, tokenIds, uris, signature)    
        ).to.be.revertedWith('CollectionV3: Reach max edition');

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
        const tokenId1 = BigNumber.from('990001000000000007');
        const uri1 = 'https://test.metadata/990001000000000007';

        const tokenId2 = BigNumber.from('990001000000000008');
        const uri2 = 'https://test.metadata/990001000000000008';

        const tokenId3 = BigNumber.from('990001000000000009');
        const uri3 = 'https://test.metadata/990001000000000009';

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
        const tokenId1 = BigNumber.from('990001000000000007');
        const uri1 = 'https://test.metadata/990001000000000007';

        const tokenId2 = BigNumber.from('990002000000000008');
        const uri2 = 'https://test.metadata/990002000000000008';

        const tokenId3 = BigNumber.from('990003000000000009');
        const uri3 = 'https://test.metadata/990003000000000009';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, creator.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request - tokenIds of multiple sub-collections
        //  This Collection's version supports multiple sub-collections in one collection
        //  But, when doing a batch minting, it requires a batch of tokenIDs grouping in only one sub-collection
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
        const tokenId = BigNumber.from('990001000000000007');
        const uri = 'https://test.metadata/990001000000000007';
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
        const tokenId1 = BigNumber.from('990001000000000007');
        const uri1 = 'https://test.metadata/990001000000000007';

        const tokenId2 = BigNumber.from('990001000000000008');
        const uri2 = 'https://test.metadata/990001000000000008';

        const tokenId3 = BigNumber.from('990001000000000009');
        const uri3 = 'https://test.metadata/990001000000000009';

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
        const tokenId = BigNumber.from('990001000000000007');
        const uri = 'https://test.metadata/990001000000000007';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);
        const invalidTokenId = BigNumber.from('990001000000000008');

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
        const tokenId1 = BigNumber.from('990001000000000007');
        const uri1 = 'https://test.metadata/990001000000000007';

        const tokenId2 = BigNumber.from('990001000000000008');
        const uri2 = 'https://test.metadata/990001000000000008';

        const tokenId3 = BigNumber.from('990001000000000009');
        const uri3 = 'https://test.metadata/990001000000000009';
        const invalidTokenId = BigNumber.from('990001000000000010');

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
        const tokenId = BigNumber.from('990001000000000007');
        const uri = 'https://test.metadata/990001000000000007';
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
        const tokenId1 = BigNumber.from('990001000000000007');
        const uri1 = 'https://test.metadata/990001000000000007';

        const tokenId2 = BigNumber.from('990001000000000008');
        const uri2 = 'https://test.metadata/990001000000000008';

        const tokenId3 = BigNumber.from('990001000000000009');
        const uri3 = 'https://test.metadata/990001000000000009';
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
        const tokenId = BigNumber.from('990001000000000007');
        const uri = 'https://test.metadata/990001000000000007';
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
        const tokenId1 = BigNumber.from('990001000000000007');
        const uri1 = 'https://test.metadata/990001000000000007';

        const tokenId2 = BigNumber.from('990001000000000008');
        const uri2 = 'https://test.metadata/990001000000000008';

        const tokenId3 = BigNumber.from('990001000000000009');
        const uri3 = 'https://test.metadata/990001000000000009';

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
        const tokenId = BigNumber.from('990001000000000007');
        const uri = 'https://test.metadata/990001000000000007';
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
        const tokenId1 = BigNumber.from('990001000000000007');
        const uri1 = 'https://test.metadata/990001000000000007';

        const tokenId2 = BigNumber.from('990001000000000008');
        const uri2 = 'https://test.metadata/990001000000000008';

        const tokenId3 = BigNumber.from('990001000000000009');
        const uri3 = 'https://test.metadata/990001000000000009';

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
        const tokenId = BigNumber.from('990001000000000003');
        const uri = 'https://test.metadata/990001000000000003';
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
        const tokenId1 = BigNumber.from('990001000000000004');
        const uri1 = 'https://test.metadata/990001000000000004';

        const tokenId2 = BigNumber.from('990001000000000005');
        const uri2 = 'https://test.metadata/990001000000000005';

        const tokenId3 = BigNumber.from('990001000000000006');
        const uri3 = 'https://test.metadata/990001000000000006';

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

    it('Should succeed when minting a valid TokenId - Sub-Collection = 2 - Single Minting', async() => {
        const tokenId = BigNumber.from('990002000000000003');
        const uri = 'https://test.metadata/990002000000000003';
        const signature = await verifySignature(verifier, creator.address, tokenId, uri, ERC721_MINT);

        const balanceBefore = await collection.balanceOf(creator.address);
        //  Send a minting request when Collection has registered
        await collection.connect(creator).mint(creator.address, tokenId, uri, signature)    

        expect(await collection.balanceOf(creator.address)).deep.equal(balanceBefore.add(1));
        expect(await collection.ownerOf(tokenId)).deep.equal(creator.address);
    });

    it('Should succeed when minting valid TokenIds - Sub-Collection = 2 - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990002000000000004');
        const uri1 = 'https://test.metadata/990002000000000004';

        const tokenId2 = BigNumber.from('990002000000000005');
        const uri2 = 'https://test.metadata/990002000000000005';

        const tokenId3 = BigNumber.from('990002000000000006');
        const uri3 = 'https://test.metadata/990002000000000006';

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

    it('Should revert when SporesNFTMarket requests mint token, but tokenID already minted - Lazy minting - Sub-Collection = 1', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990001000000000003');
        const uri = 'https://test.metadata/990001000000000003';
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
        expect(await collection.ownerOf(tokenId)).deep.equal(creator.address); 
    });

    it('Should revert when SporesNFTMarket requests mint token, but tokenID already minted - Lazy minting - Sub-Collection = 2', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990002000000000004');
        const uri = 'https://test.metadata/990002000000000004';
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
        expect(await collection.ownerOf(tokenId)).deep.equal(creator.address); 
    });

    it('Should succeed when SporesNFTMarket requests mint token with valid settings - After Single and Batch minting - Sub-Collection = 1', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990001000000000007');
        const uri = 'https://test.metadata/990001000000000007';
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

    it('Should succeed when SporesNFTMarket requests mint token with valid settings - After Single and Batch minting - Sub-Collection = 2', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990002000000000007');
        const uri = 'https://test.metadata/990002000000000007';
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

    it('Should succeed when minting valid TokenIds - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990001000000000008');
        const uri1 = 'https://test.metadata/990001000000000008';

        const tokenId2 = BigNumber.from('990001000000000009');
        const uri2 = 'https://test.metadata/990001000000000009';

        const tokenId3 = BigNumber.from('990001000000000010');
        const uri3 = 'https://test.metadata/990001000000000010';

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

    it('Should succeed when minting valid TokenIds - Batch Minting', async() => {
        const tokenId1 = BigNumber.from('990002000000000008');
        const uri1 = 'https://test.metadata/990002000000000008';

        const tokenId2 = BigNumber.from('990002000000000009');
        const uri2 = 'https://test.metadata/990002000000000009';

        const tokenId3 = BigNumber.from('990002000000000010');
        const uri3 = 'https://test.metadata/990002000000000010';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, buyer.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        const balanceBefore = await collection.balanceOf(buyer.address);
        //  Send a minting request when Collection has registered
        await collection.connect(creator).mintBatch(buyer.address, tokenIds, uris, signature);    

        expect(await collection.balanceOf(buyer.address)).deep.equal(balanceBefore.add(3));
        expect(await collection.ownerOf(tokenId1)).deep.equal(buyer.address);
        expect(await collection.ownerOf(tokenId2)).deep.equal(buyer.address);
        expect(await collection.ownerOf(tokenId3)).deep.equal(buyer.address);
    });

    it('Should revert when SporesNFTMarket requests mint token, but Sub-Collection 1 already reached max editions', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990001000000000011');
        const uri = 'https://test.metadata/990001000000000011';
        const maxEdition = 10;
        const subCollectionId = 1;

        const balCreatorBefore = await collection.balanceOf(creator.address);
        const balBuyerBefore = await collection.balanceOf(buyer.address);
        const mintedAmtBefore = (await collection.subcollections(subCollectionId)).mintedAmt;

        //  Market sends a minting request
        //  but sub-collection already reached max number of editions
        await expect(
            collection.connect(market).lazymint(creator.address, buyer.address, tokenId, uri)
        ).to.be.revertedWith('CollectionV3: Reach max edition');

        expect(await collection.balanceOf(creator.address)).deep.equal(balCreatorBefore);
        expect(await collection.balanceOf(buyer.address)).deep.equal(balBuyerBefore);
        expect( (await collection.subcollections(subCollectionId)).maxEdition ).deep.equal(maxEdition);
        expect( (await collection.subcollections(subCollectionId)).mintedAmt ).deep.equal(mintedAmtBefore); 
        await expect(
            collection.ownerOf(tokenId)    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token'); 
    });

    it('Should succeed when SporesNFTMarket requests mint token with valid settings - Sub-Collection = 2', async() => {
        //  TokenId is created following this rule:
        //  Collection ID + Sub-collection ID (4 digits) + Edition Number (12 digits)
        //  Currently, there are two sub-collections in this contract
        const tokenId = BigNumber.from('990002000000000011');
        const uri = 'https://test.metadata/990002000000000011';
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