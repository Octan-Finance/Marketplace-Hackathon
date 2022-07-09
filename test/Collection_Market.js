const { BigNumber } = require('@ethersproject/bignumber');
const chai = require('chai');
const chaiAsPromise = require('chai-as-promised');
const { ethers, upgrades } = require('hardhat');
const { TASK_ETHERSCAN_VERIFY } = require('hardhat-deploy');


chai.use(chaiAsPromise);
const expect = chai.expect;

function creationSignature(verifier, collectionId, maxEdition, requestId, admin, registry) {
    let message = ethers.utils.solidityKeccak256(['uint256', 'uint256', 'uint256', 'address', 'address'],
        [collectionId, maxEdition, requestId, admin, registry]);

    return verifier.signMessage(ethers.utils.arrayify(message));   
}

function addSubcollectionSignature(verifier, collectionId, subcollectionId, maxEdition, requestId) {
    let message = ethers.utils.solidityKeccak256(['uint256', 'uint256', 'uint256', 'uint256'],
        [collectionId, subcollectionId, maxEdition, requestId]);

    return verifier.signMessage(ethers.utils.arrayify(message));   
}

function verifySignatureBatch(verifier, toAddress, encodeURIs, type, ...tokenIds) {
    let message = ethers.utils.solidityKeccak256(['address', ...Array(tokenIds.length).fill('uint256'), 'bytes', 'uint256'],
        [toAddress, ...tokenIds, encodeURIs, type]);

    return verifier.signMessage(ethers.utils.arrayify(message));
}

function verifySignature(verifier, toAddress, tokenId, uri, type) {
    let message = ethers.utils.solidityKeccak256(['address', 'uint256', 'string', 'uint256'],
        [toAddress, tokenId, uri, type]);

    return verifier.signMessage(ethers.utils.arrayify(message));
}

function verifyPurchaseSignature(
    verifier, seller, paymentReceiver, contractNFT, tokenId, paymentToken, feeRate, price, amount, sellId, type
) {
    let message = ethers.utils.solidityKeccak256(
        ['address', 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
        [seller, paymentReceiver, contractNFT, tokenId, paymentToken, feeRate, price, amount, sellId, type]);

    return verifier.signMessage(ethers.utils.arrayify(message));
}

describe('SporesNFTMarket and Collection Contracts Testing ', () => {
    let provider;
    let admin, creator, buyer, verifier, feeCollector, anotherSeller;
    let market, registry;
    let collection1, collection2, invalidCollection, token721, token1155;
    let erc201, erc202, erc203, erc204, erc205;

    const NATIVE_COIN_NFT_721 = 0;
    const NATIVE_COIN_NFT_1155 = 1;
    const ERC_20_NFT_721 = 2;
    const ERC_20_NFT_1155 = 3;
    const SINGLE_UNIT = 1;
    const ERC721 = 0;
    const ERC1155 = 1;

    before(async() => {
        //  Get pre-fund accounts
        [admin, creator, buyer, verifier, feeCollector, anotherSeller] = await ethers.getSigners();
        provider = ethers.provider;

        //  Deploy some ERC20Test contracts. These contracts are used for testing only
        const ERC20 = await ethers.getContractFactory('ERC20Test', admin);
        erc201 = await ERC20.deploy('ERC20-1', 'ERC20-1');
        erc202 = await ERC20.deploy('ERC20-2', 'ERC20-2');
        erc203 = await ERC20.deploy('ERC20-3', 'ERC20-3');
        erc204 = await ERC20.deploy('ERC20-4', 'ERC20-4');
        erc205 = await ERC20.deploy('ERC20-5', 'ERC20-5');

        const ERC721 = await ethers.getContractFactory('ERC721Test', admin);
        token721 = await ERC721.deploy('ERC721','721');

        const ERC1155 = await ethers.getContractFactory('ERC1155Test', admin);
        token1155 = await ERC1155.deploy();

        //  Deploy and initialize SporesRegistry contract
        //  SporesRegistry contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesRegistry = await ethers.getContractFactory('SporesRegistry', admin);
        const supportTokens = [erc201.address, erc202.address, erc203.address, erc204.address];
        registry = await upgrades.deployProxy(SporesRegistry, 
            [feeCollector.address, verifier.address, token721.address, token1155.address, supportTokens],
            {initializer: 'init'}
        );
        await registry.deployed();

        //  Create Collection 1
        //  This contract supports one sub-collection per Collection only
        const collectionId = 69;
        const maxEdition = 69;
        const requestId = 18002080;
        const collectionName = 'Collection 1';

        const Collection = await ethers.getContractFactory('Collection', creator);
        const signature = await creationSignature(
            verifier, collectionId, maxEdition, requestId, admin.address, registry.address
        );
        collection1 = await Collection.deploy(
            admin.address, registry.address, collectionId, maxEdition, requestId, collectionName, '', signature
        );

        //  Create Invalid Collection
        const invalidCollectionId = 99;
        const maxEdition1 = 99;
        const requestId1 = 18002081;
        const collectionName1 = 'Invalid Collection';

        const InvalidCollection = await ethers.getContractFactory('CollectionV2', creator);
        invalidCollection = await InvalidCollection.deploy(
            admin.address, registry.address, invalidCollectionId, maxEdition1, requestId1, collectionName1, ''
        );

        //  Deploy and initialize SporesNFTMarket contract
        //  SporesNFTMarket contract is written following non-upgradeability feature
        //  Hence, constructor is defined and being called when deploying SporesNFTMarket contract
        const SporesNFTMarket = await ethers.getContractFactory('SporesNFTMarket', admin);
        market = await SporesNFTMarket.deploy(registry.address);

        //  Add Market and Minter contract into SporesRegistry
        await registry.updateMarket(market.address);
    });  

    it('Should succeed purchase NFT721 with native coin', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('690001000000000001')
        const uri = 'https://test.metadata/690001000000000001';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection1.connect(creator).mint(creator.address, tokenId, uri, signature1);  

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await market.connect(buyer).buyNFT721NativeCoin(
            info, signature2, 
            { 
                value: price 
            }
        );

        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator.address);
        expect(event.args._paymentReceiver).deep.equal(creator.address);
        expect(event.args._contractNFT).deep.equal(collection1.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore.sub(1));
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore.add(1));
        expect(await collection1.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balCreatorBefore.add(BigNumber.from(payToSeller))).deep.equal(balCreatorAfter);
    });

    //  'Price' - param and signed by Verifier - are matched
    //  but msg.value is insufficient
    it('Should revert when purchase NFT721 with invalid Price - Invalid msg.value', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('690001000000000002')
        const uri = 'https://test.metadata/690001000000000002';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection1.connect(creator).mint(creator.address, tokenId, uri, signature1);  

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);


        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid msg.value
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2, 
                { 
                    value: invalidPrice 
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: Insufficient payment');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    //  'Price' - param and signed by Verifier - are NOT matched
    it('Should revert when purchase NFT721 with invalid Price', async() => {
        const tokenId = BigNumber.from('690001000000000002')

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId, feeRate, invalidPrice, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Price
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: invalidPrice
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when purchase NFT721 with invalid Collection contract', async() => {
        const tokenId = BigNumber.from('690001000000000002')

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, invalidCollection.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Collection contract
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: NFT721 Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = BigNumber.from('690001000000000002')
        const invalidTokenId = BigNumber.from('690001000000000100')

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        await expect(
            collection1.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            invalidTokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Check balance of Seller, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        await expect(
            collection1.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('690001000000000003')
        const uri = 'https://test.metadata/690001000000000003';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        await collection1.connect(creator).mint(anotherSeller.address, tokenId, uri, signature1);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, AnotherSeller, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        const nftItemsAnotherSellerBefore = await collection1.balanceOf(anotherSeller.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(anotherSeller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId - seller not owned
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: Seller is not owner');

        //  Check balance of Creator, AnotherSeller, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.balanceOf(anotherSeller.address)).deep.equal(nftItemsAnotherSellerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('690001000000000002')

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, AnotherSeller, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        const nftItemsAnotherSellerBefore = await collection1.balanceOf(anotherSeller.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Seller
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, AnotherSeller, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.balanceOf(anotherSeller.address)).deep.equal(nftItemsAnotherSellerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = BigNumber.from('690001000000000002')

        //  Prepare input data, and send a minting request
        const tokenId2 = BigNumber.from('690001000000000004')
        const uri = 'https://test.metadata/690001000000000004';
        const signature1 = await verifySignature(verifier, creator.address, tokenId2, uri, ERC721);
        await collection1.connect(creator).mint(creator.address, tokenId2, uri, signature1);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection1.ownerOf(tokenId2)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId1,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId2, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection1.ownerOf(tokenId2)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when collection contract - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('690001000000000002');

        //  Prepare input data, and send a minting request
        await token721.mint(creator.address, tokenId);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Collection contract
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('690001000000000002');

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = BigNumber.from('690001000000000002')

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, false);
   
        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    /************************************** ERC20 - NFT721 **************************************/

    it('Should succeed purchase NFT721 with ERC-20', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('690001000000000005')
        const uri = 'https://test.metadata/690001000000000005';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection1.connect(creator).mint(creator.address, tokenId, uri, signature1);  

        //  Mint ERC-201 to Buyer
        const erc201Amt = 1000000000000;
        await erc201.mint(buyer.address, erc201Amt);

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc201.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc201.balanceOf(creator.address);
        const balBuyerBefore = await erc201.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            erc201.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc201.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await market.connect(buyer).buyNFT721ERC20(info, signature2);

        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator.address);
        expect(event.args._paymentReceiver).deep.equal(creator.address);
        expect(event.args._contractNFT).deep.equal(collection1.address);
        expect(event.args._paymentToken).deep.equal(erc201.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_721);

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc201.balanceOf(creator.address);
        const balBuyerAfter = await erc201.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore.sub(1));
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore.add(1));
        expect(await collection1.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balCreatorBefore.add(BigNumber.from(payToSeller))).deep.equal(balCreatorAfter);
        expect(balBuyerBefore.sub(price)).deep.equal(balBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid payment', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('690001000000000006')
        const uri = 'https://test.metadata/690001000000000006';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection1.connect(creator).mint(creator.address, tokenId, uri, signature1);  

        //  Mint ERC-202 to Buyer
        const erc202Amt = 1000000000000;
        await erc202.mint(buyer.address, erc202Amt);

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc205.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid ERC-20 payment token
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: Invalid payment');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid Collection contract', async() => {
        const tokenId = BigNumber.from('690001000000000006')

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, invalidCollection.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: NFT721 Contract not supported');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = BigNumber.from('690001000000000006')
        const invalidTokenId = BigNumber.from('690001000000000069')

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        await expect(
            collection1.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc202.address,
            invalidTokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Check balance of Seller, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
        await expect(
            collection1.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('690001000000000007')
        const uri = 'https://test.metadata/690001000000000007';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        await collection1.connect(creator).mint(anotherSeller.address, tokenId, uri, signature1); 

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, AnotherSeller, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        const nftItemsAnotherSellerBefore = await collection1.balanceOf(anotherSeller.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(anotherSeller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, collection1.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId - Seller not owned
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: Seller is not owner');

        //  Check balance of Creator, AnotherSeller, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.balanceOf(anotherSeller.address)).deep.equal(nftItemsAnotherSellerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('690001000000000006')

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, AnotherSeller, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        const nftItemsAnotherSellerBefore = await collection1.balanceOf(anotherSeller.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, collection1.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Seller
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, AnotherSeller, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.balanceOf(anotherSeller.address)).deep.equal(nftItemsAnotherSellerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = BigNumber.from('690001000000000006')

        //  Prepare input data, and send a minting request
        const tokenId2 = BigNumber.from('690001000000000008')
        const uri = 'https://test.metadata/690001000000000008';
        const signature1 = await verifySignature(verifier, creator.address, tokenId2, uri, ERC721);
        await collection1.connect(creator).mint(creator.address, tokenId2, uri, signature1); 

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection1.ownerOf(tokenId2)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId1,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc202.address,
            tokenId2, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection1.ownerOf(tokenId2)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when token721 - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('690001000000000006');
        const opcode = 721;

        //  Prepare input data, and send a minting request
        await token721.mint(creator.address, tokenId);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('690001000000000006');

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = BigNumber.from('690001000000000006');

        //  Creator disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, false);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should succeed create and add Collection 2 into network', async() => {
        //  Create Collection 2
        //  This contract supports multiple sub-collections per Collection
        const collectionId = 88;
        const maxEdition = 88;
        const requestId = 18002080;
        const collectionName = 'Collection 2';

        const Collection = await ethers.getContractFactory('CollectionV2', creator);
        collection2 = await Collection.deploy(
            admin.address, registry.address, collectionId, maxEdition, requestId, collectionName, ''
        );

        //  Add Collection 2 into SporesRegistry
        await registry.connect(admin).addCollection(collection2.address);
    });

    it('Should succeed purchase NFT721 with native coin - Collection 1 - After adding new Collection', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('690001000000000010')
        const uri = 'https://test.metadata/690001000000000010';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection1.connect(creator).mint(creator.address, tokenId, uri, signature1);  

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await market.connect(buyer).buyNFT721NativeCoin(
            info, signature2, 
            { 
                value: price 
            }
        );

        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator.address);
        expect(event.args._paymentReceiver).deep.equal(creator.address);
        expect(event.args._contractNFT).deep.equal(collection1.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore.sub(1));
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore.add(1));
        expect(await collection1.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balCreatorBefore.add(BigNumber.from(payToSeller))).deep.equal(balCreatorAfter);
    });

    it('Should succeed purchase NFT721 with ERC-20 - Collection 1 - After adding new Collection', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('690001000000000011')
        const uri = 'https://test.metadata/690001000000000011';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection1.connect(creator).mint(creator.address, tokenId, uri, signature1);  

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection1.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc201.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc201.balanceOf(creator.address);
        const balBuyerBefore = await erc201.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection1.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection1.balanceOf(buyer.address);
        expect(await collection1.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection1.address, tokenId,
            erc201.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection1.address, erc201.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await market.connect(buyer).buyNFT721ERC20(info, signature2);

        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator.address);
        expect(event.args._paymentReceiver).deep.equal(creator.address);
        expect(event.args._contractNFT).deep.equal(collection1.address);
        expect(event.args._paymentToken).deep.equal(erc201.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_721);

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc201.balanceOf(creator.address);
        const balBuyerAfter = await erc201.balanceOf(buyer.address);
        expect(await collection1.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore.sub(1));
        expect(await collection1.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore.add(1));
        expect(await collection1.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balCreatorBefore.add(BigNumber.from(payToSeller))).deep.equal(balCreatorAfter);
        expect(balBuyerBefore.sub(price)).deep.equal(balBuyerAfter);
    });

    it('Should succeed purchase NFT721 with native coin - Collection 2', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('880001000000000001')
        const uri = 'https://test.metadata/880001000000000001';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection2.connect(creator).mint(creator.address, tokenId, uri, signature1);  

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await market.connect(buyer).buyNFT721NativeCoin(
            info, signature2, 
            { 
                value: price 
            }
        );

        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator.address);
        expect(event.args._paymentReceiver).deep.equal(creator.address);
        expect(event.args._contractNFT).deep.equal(collection2.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore.sub(1));
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore.add(1));
        expect(await collection2.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balCreatorBefore.add(BigNumber.from(payToSeller))).deep.equal(balCreatorAfter);
    });

    //  'Price' - param and signed by Verifier - are matched
    //  but msg.value is insufficient
    it('Should revert when purchase NFT721 with invalid Price - Invalid msg.value', async() => {
        //  Prepare input data, and send a minting request
        //  Add second sub-collection into Collection 2
        const collectionId = 88;
        const subcollectionId = 2;
        const maxEdition = 99;
        const requestId = 18002080;
        const signature = addSubcollectionSignature(verifier, collectionId, subcollectionId, maxEdition, requestId);
        await collection2.connect(creator).addSubCollection(maxEdition, requestId, signature);

        const tokenId = BigNumber.from('880002000000000001')
        const uri = 'https://test.metadata/880002000000000001';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection2.connect(creator).mint(creator.address, tokenId, uri, signature1);  

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);


        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid msg.value
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2, 
                { 
                    value: invalidPrice 
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: Insufficient payment');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    //  'Price' - param and signed by Verifier - are NOT matched
    it('Should revert when purchase NFT721 with invalid Price', async() => {
        const tokenId = BigNumber.from('880002000000000001')

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            tokenId, feeRate, invalidPrice, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Price
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: invalidPrice
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when purchase NFT721 with invalid Collection contract', async() => {
        const tokenId = BigNumber.from('880002000000000001')

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, invalidCollection.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Collection contract
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: NFT721 Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = BigNumber.from('880002000000000001')
        const invalidTokenId = BigNumber.from('690001000000000050')

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        await expect(
            collection2.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            invalidTokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Check balance of Seller, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        await expect(
            collection2.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        //  Add third sub-collection into Collection 2
        const collectionId = 88;
        const subcollectionId = 3;
        const maxEdition = 99;
        const requestId = 18002080;
        const signature = addSubcollectionSignature(verifier, collectionId, subcollectionId, maxEdition, requestId);
        await collection2.connect(creator).addSubCollection(maxEdition, requestId, signature);

        const tokenId = BigNumber.from('880003000000000001')
        const uri = 'https://test.metadata/880003000000000001';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        await collection2.connect(creator).mint(anotherSeller.address, tokenId, uri, signature1);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, AnotherSeller, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        const nftItemsAnotherSellerBefore = await collection2.balanceOf(anotherSeller.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(anotherSeller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, collection2.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId - seller not owned
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: Seller is not owner');

        //  Check balance of Creator, AnotherSeller, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.balanceOf(anotherSeller.address)).deep.equal(nftItemsAnotherSellerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('880002000000000001')

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, AnotherSeller, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        const nftItemsAnotherSellerBefore = await collection2.balanceOf(anotherSeller.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, collection2.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Seller
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, AnotherSeller, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.balanceOf(anotherSeller.address)).deep.equal(nftItemsAnotherSellerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = BigNumber.from('880002000000000001')

        //  Prepare input data, and send a minting request
        //  Add fourth sub-collection into Collection 2
        const collectionId = 88;
        const subcollectionId = 4;
        const maxEdition = 99;
        const requestId = 18002080;
        const signature = addSubcollectionSignature(verifier, collectionId, subcollectionId, maxEdition, requestId);
        await collection2.connect(creator).addSubCollection(maxEdition, requestId, signature);
        
        const tokenId2 = BigNumber.from('880004000000000001')
        const uri = 'https://test.metadata/880004000000000001';
        const signature1 = await verifySignature(verifier, creator.address, tokenId2, uri, ERC721);
        await collection2.connect(creator).mint(creator.address, tokenId2, uri, signature1);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection2.ownerOf(tokenId2)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId1,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            tokenId2, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection2.ownerOf(tokenId2)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when collection contract - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('880002000000000001');

        //  Prepare input data, and send a minting request
        await token721.mint(creator.address, tokenId);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Collection contract
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('880004000000000001');

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = BigNumber.from('880004000000000001')

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, false);
   
        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await provider.getBalance(creator.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await provider.getBalance(creator.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
    });

    /************************************** ERC20 - NFT721 **************************************/

    it('Should succeed purchase NFT721 with ERC-20', async() => {
        //  Prepare input data, and send a minting request
        //  Add fifth sub-collection into Collection 2
        const collectionId = 88;
        const subcollectionId = 5;
        const maxEdition = 99;
        const requestId = 18002080;
        const signature = addSubcollectionSignature(verifier, collectionId, subcollectionId, maxEdition, requestId);
        await collection2.connect(creator).addSubCollection(maxEdition, requestId, signature);

        const tokenId = BigNumber.from('880005000000000001')
        const uri = 'https://test.metadata/880005000000000001';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection2.connect(creator).mint(creator.address, tokenId, uri, signature1);  

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc201.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc201.balanceOf(creator.address);
        const balBuyerBefore = await erc201.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            erc201.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, erc201.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await market.connect(buyer).buyNFT721ERC20(info, signature2);

        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator.address);
        expect(event.args._paymentReceiver).deep.equal(creator.address);
        expect(event.args._contractNFT).deep.equal(collection2.address);
        expect(event.args._paymentToken).deep.equal(erc201.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_721);

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc201.balanceOf(creator.address);
        const balBuyerAfter = await erc201.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore.sub(1));
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore.add(1));
        expect(await collection2.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balCreatorBefore.add(BigNumber.from(payToSeller))).deep.equal(balCreatorAfter);
        expect(balBuyerBefore.sub(price)).deep.equal(balBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid payment', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('880005000000000002')
        const uri = 'https://test.metadata/880005000000000002';
        const signature1 = await verifySignature(verifier, creator.address, tokenId, uri, ERC721);
        await collection2.connect(creator).mint(creator.address, tokenId, uri, signature1);

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, erc205.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid ERC-20 payment token
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: Invalid payment');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid Collection contract', async() => {
        const tokenId = BigNumber.from('880005000000000002')

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, invalidCollection.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: NFT721 Contract not supported');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = BigNumber.from('880005000000000002')
        const invalidTokenId = BigNumber.from('690001000000000069')

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        await expect(
            collection2.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, erc202.address,
            invalidTokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Check balance of Seller, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
        await expect(
            collection2.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = BigNumber.from('880005000000000003')
        const uri = 'https://test.metadata/880005000000000003';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        await collection2.connect(creator).mint(anotherSeller.address, tokenId, uri, signature1); 

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, AnotherSeller, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        const nftItemsAnotherSellerBefore = await collection2.balanceOf(anotherSeller.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(anotherSeller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, collection2.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId - Seller not owned
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: Seller is not owner');

        //  Check balance of Creator, AnotherSeller, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.balanceOf(anotherSeller.address)).deep.equal(nftItemsAnotherSellerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('880005000000000002')

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, AnotherSeller, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        const nftItemsAnotherSellerBefore = await collection2.balanceOf(anotherSeller.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, collection2.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Seller
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, AnotherSeller, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.balanceOf(anotherSeller.address)).deep.equal(nftItemsAnotherSellerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = BigNumber.from('880005000000000002')

        //  Prepare input data, and send a minting request
        const tokenId2 = BigNumber.from('880005000000000004')
        const uri = 'https://test.metadata/880005000000000004';
        const signature1 = await verifySignature(verifier, creator.address, tokenId2, uri, ERC721);
        await collection2.connect(creator).mint(creator.address, tokenId2, uri, signature1); 

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection2.ownerOf(tokenId2)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId1,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, erc202.address,
            tokenId2, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId1)).deep.equal(creator.address);
        expect(await collection2.ownerOf(tokenId2)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when token721 - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('880005000000000002');

        //  Prepare input data, and send a minting request
        await token721.mint(creator.address, tokenId);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = BigNumber.from('880005000000000004');

        //  Creator setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = BigNumber.from('880005000000000004');

        //  Creator disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await collection2.connect(creator).setApprovalForAll(market.address, false);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Balance of Creator, Buyer before purchase
        const balCreatorBefore = await erc202.balanceOf(creator.address);
        const balBuyerBefore = await erc202.balanceOf(buyer.address);
        const nftItemsCreatorBefore = await collection2.balanceOf(creator.address);
        const nftItemsBuyerBefore = await collection2.balanceOf(buyer.address);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, creator.address, creator.address, collection2.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            creator.address, creator.address, collection2.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        //  Check balance of Creator, Buyer after purchase
        const balCreatorAfter = await erc202.balanceOf(creator.address);
        const balBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await collection2.balanceOf(creator.address)).deep.equal(nftItemsCreatorBefore);
        expect(await collection2.balanceOf(buyer.address)).deep.equal(nftItemsBuyerBefore);
        expect(await collection2.ownerOf(tokenId)).deep.equal(creator.address);
        expect(balCreatorBefore).deep.equal(balCreatorAfter);
        expect(balBuyerBefore).deep.equal(balBuyerAfter);
    });
});