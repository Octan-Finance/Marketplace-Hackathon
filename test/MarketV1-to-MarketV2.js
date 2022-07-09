const { BigNumber } = require('@ethersproject/bignumber');
const chai = require('chai');
const chaiAsPromise = require('chai-as-promised');
const { intToBuffer } = require('ethjs-util');
const { ethers, upgrades } = require('hardhat');
const { TASK_ETHERSCAN_VERIFY } = require('hardhat-deploy');

chai.use(chaiAsPromise);
const expect = chai.expect;

//  Purchase item as lazy minting requires 3 signatures:
//      + Lazy mint signature   -> by Creator
//      + Sale signature        -> by Creator
//      + Authorized signature  -> by BE

function sigHash(sig) {
    let message = ethers.utils.solidityKeccak256(['bytes'], [sig]);
    return ethers.utils.arrayify(message);
}

function createLazyMintSignature(creator, creatorAddr, nft, tokenId, mintAmt, type) {
    let message = ethers.utils.solidityKeccak256(['address', 'address', 'uint256', 'uint256', 'uint256'],
        [creatorAddr, nft, tokenId, mintAmt, type]);

    return creator.signMessage(ethers.utils.arrayify(message));
}

function createSaleSignature(creator, tokenId, nft, creatorAddr, paymentReceiver, paymentToken, unitPrice) {
    let message = ethers.utils.solidityKeccak256(
        ['uint256', 'address', 'address', 'address', 'address', 'uint256'],
        [tokenId, nft, creatorAddr, paymentReceiver, paymentToken, unitPrice]);

    return creator.signMessage(ethers.utils.arrayify(message));
}

function createAuthorizedSignature(verifier, saleID, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2) {
    let message = ethers.utils.solidityKeccak256(
        ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32', 'bytes32'],
        [saleID, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2]);

    return verifier.signMessage(ethers.utils.arrayify(message));
}

function creationSignature(verifier, collectionId, maxEdition, requestId, admin, registry) {
    let message = ethers.utils.solidityKeccak256(['uint256', 'uint256', 'uint256', 'address', 'address'],
        [collectionId, maxEdition, requestId, admin, registry]);

    return verifier.signMessage(ethers.utils.arrayify(message));   
}

function cancelSignature(verifier, saleId, seller) {
    let message = ethers.utils.solidityKeccak256(['address', 'uint256'],
        [seller, saleId]);

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

//  In the test, the scenarios are created as following:
//  - Phase 1:
//      + SporesRegistry is deployed
//      + SporesNFTMinterBatch (version 1) is deployed (only single and batch minting)
//      + SporesNFTMarket (version 1) is deployed (purchase minted NFT721 with Native Coin/ERC-20 Token)
//      + Test purchase NFT721 items
//  - Phase 2:
//      + SporesNFTMinterV2 (support lazy minting, single and batch minting) is deployed to replace the version 1
//      + SporesNFTMarketV2 (purchase minted and lazy minting NFT721 with Native Coin/ERC-20 Token) is deployed to replace the version 1
//      + Update new Market and Minter contract in the SporesRegistry
//      + Test purchase NFT721 items as lazy minting (Collection Version 2-3 and SporesNFT721)
//  - Phase 3:
//      + Test purchase NFT721 items as in the Phase 1
describe('MarketV1 -> MarketV2 Testing - Market Version 1-2, Collection Version 2-3, Minter Version 1-2 integration', () => {
    let provider;
    let admin, creator1, creator2, buyer, verifier, treasury, seller, anotherSeller;
    let marketV1, minterV1, marketV2, minterV2, registry, extension;
    let collectionv21, collectionv31, spo721, spo1155, token721;
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
        [admin, creator1, creator2, buyer, verifier, treasury, seller, anotherSeller] = await ethers.getSigners();
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

        //  Deploy and initialize SporesNFT721 contract
        //  SporesNFT721 contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesNFT721 = await ethers.getContractFactory('SporesNFT721', admin);
        spo721 = await upgrades.deployProxy(SporesNFT721, ['Spores NFT', 'SPONFT'], {initializer: 'init'});
        await spo721.deployed();

        //  Deploy and initialize SporesNFT1155 contract
        //  SporesNFT1155 contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesNFT1155 = await ethers.getContractFactory('SporesNFT1155', admin);
        spo1155 = await upgrades.deployProxy(SporesNFT1155, {initializer: 'init'});
        await spo1155.deployed();

        //  Deploy and initialize SporesRegistry contract
        //  SporesRegistry contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesRegistry = await ethers.getContractFactory('SporesRegistry', admin);
        const supportTokens = [erc201.address, erc202.address, erc203.address, erc204.address];
        registry = await upgrades.deployProxy(SporesRegistry, 
            [treasury.address, verifier.address, spo721.address, spo1155.address, supportTokens],
            {initializer: 'init'}
        );
        await registry.deployed();

        //  Deploy and initialize SporesNFTMarket contract
        //  SporesNFTMarket contract is written following non-upgradeability feature
        //  Hence, constructor is defined and being called when deploying SporesNFTMarket contract
        const SporesNFTMarket = await ethers.getContractFactory('SporesNFTMarket', admin);
        marketV1 = await SporesNFTMarket.deploy(registry.address);

        //  Deploy and initialize SporesNFTMinter contract
        //  This is a version that supports both single and batch minting Spores NFT Tokens
        //  SporesNFTMinter contract is also written following non-upgradeability feature
        const SporesNFTMinter = await ethers.getContractFactory('SporesNFTMinterBatch', admin);
        minterV1 = await SporesNFTMinter.deploy(registry.address);

        //  By default, Minter role of SporesNFT721 and SporesNFT1155 is 'admin'
        //  So, it should be transferred to an address of SporesNFTMinter contract
        await spo721.transferMinter(minterV1.address);
        await spo1155.transferMinter(minterV1.address);

        //  Add Market and Minter contract into SporesRegistry
        await registry.updateMarket(marketV1.address);
        await registry.updateMinter(minterV1.address);
    });

    /*************************************************************************************************************
                                                Phase 1
        + SporesNFTMinterBatch (version 1) supports single and batch minting
        + SporesNFTMarket (version 1) support purchasing NFT721 with Native Coin/ERC-20 Token
        + NO lazy minting and NO purchase NFT item as lazy minting
    **************************************************************************************************************/

    it('Should succeed purchase NFT721 with native coin', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minterV1.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await marketV1.connect(buyer).buyNFT721NativeCoin(
            info, signature2, 
            { 
                value: price 
            }
        );

        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(seller.address);
        expect(event.args._paymentReceiver).deep.equal(seller.address);
        expect(event.args._contractNFT).deep.equal(spo721.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller.sub(1));
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer.add(1));
        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller.add(payToSeller))
    });

    //  'Price' - param and signed by Verifier - are matched
    //  but msg.value is insufficient
    it('Should revert when purchase NFT721 with invalid Price - Invalid msg.value', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210002;
        const uri = 'https://test.metadata/7210002';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minterV1.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        
        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid msg.value
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2, 
                { 
                    value: invalidPrice 
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: Insufficient payment');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    //  'Price' - param and signed by Verifier - are NOT matched
    it('Should revert when purchase NFT721 with invalid Price', async() => {
        const tokenId = 7210002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        
        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, invalidPrice, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Price
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: invalidPrice
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when purchase NFT721 with invalid token721 contract', async() => {
        const tokenId = 7210002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: NFT721 Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = 7210002;
        const invalidTokenId = 7211000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        await expect(
            spo721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            invalidTokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
        await expect(
            spo721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210003;
        const uri = 'https://test.metadata/7210003';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        const mintTx = await minterV1.connect(anotherSeller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const itemAnotherSeller = await spo721.balanceOf(anotherSeller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId - seller not owned
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: Seller is not owner');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await spo721.balanceOf(anotherSeller.address)).deep.equal(itemAnotherSeller);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Seller
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = 7210002;

        //  Prepare input data, and send a minting request
        const tokenId2 = 7210004;
        const uri = 'https://test.metadata/7210004';
        const signature1 = await verifySignature(verifier, seller.address, tokenId2, uri, ERC721);
        const mintTx = await minterV1.connect(seller).mintSporesERC721(tokenId2, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId2)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId1,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId2, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId2)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when token721 - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210002;
        const opcode = 721;

        //  Register invalidToken721 contract
        await registry.registerNFTContract(token721.address, opcode, false);

        //  Prepare input data, and send a minting request
        const mintTx = await token721.mint(seller.address, tokenId);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = 7210002;

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, false);
   
        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    /************************************** ERC20 - NFT721 **************************************/

    it('Should succeed purchase NFT721 with ERC-20', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210010;
        const uri = 'https://test.metadata/7210010';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minterV1.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Mint ERC-201 to Buyer
        const erc201Amt = 1000000000000;
        await erc201.mint(buyer.address, erc201Amt);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc201.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc201.balanceOf(seller.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 100000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc201.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc201.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await marketV1.connect(buyer).buyNFT721ERC20(info, signature2);
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(seller.address);
        expect(event.args._paymentReceiver).deep.equal(seller.address);
        expect(event.args._contractNFT).deep.equal(spo721.address);
        expect(event.args._paymentToken).deep.equal(erc201.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_721);

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller.sub(1));
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer.add(1));
        expect(await erc201.balanceOf(seller.address)).deep.equal(balSeller.add(payToSeller));
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer.sub(price))
    });

    it('Should revert when purchase NFT721 with invalid payment', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210011;
        const uri = 'https://test.metadata/7210011';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minterV1.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Mint ERC-202 to Buyer
        const erc202Amt = 1000000000000;
        await erc202.mint(buyer.address, erc202Amt);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc205.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid ERC-20 payment token
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: Invalid payment');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when purchase NFT721 with invalid token721 contract', async() => {
        const tokenId = 7210011;
        const opcode = 721;

        //  Unregister invalidToken721 contract
        await registry.unregisterNFTContract(token721.address, opcode);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: NFT721 Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = 7210011;
        const invalidTokenId = 7211000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        await expect(
            spo721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            invalidTokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
        await expect(
            spo721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210012;
        const uri = 'https://test.metadata/7210012';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        const mintTx = await minterV1.connect(anotherSeller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const itemAnotherSeller = await spo721.balanceOf(anotherSeller.address);
        
        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId - Seller not owned
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: Seller is not owner');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await spo721.balanceOf(anotherSeller.address)).deep.equal(itemAnotherSeller);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210011;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Seller
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = 7210011;

        //  Prepare input data, and send a minting request
        const tokenId2 = 7210013;
        const uri = 'https://test.metadata/7210013';
        const signature1 = await verifySignature(verifier, seller.address, tokenId2, uri, ERC721);
        const mintTx = await minterV1.connect(seller).mintSporesERC721(tokenId2, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
       await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId2)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId1,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId2, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId2)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when token721 - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210011;
        const opcode = 721;

        //  Register invalidToken721 contract
        await registry.registerNFTContract(token721.address, opcode, false);

        //  Prepare input data, and send a minting request
        const mintTx = await token721.mint(seller.address, tokenId);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210011;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = 7210011;

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, false);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Shoud succeed to deploy Market and Minter Version 2', async() => {
        //  Deploy Extension contract of SporesNFTMarketV2
        const Extension = await ethers.getContractFactory('MarketExtension', admin);
        extension = await Extension.deploy(registry.address);

        //  Deploy and initialize SporesNFTMarket contract
        //  SporesNFTMarket contract is written following non-upgradeability feature
        //  Hence, constructor is defined and being called when deploying SporesNFTMarket contract
        const SporesNFTMarket = await ethers.getContractFactory('SporesNFTMarketV2', admin);
        marketV2 = await SporesNFTMarket.deploy(registry.address, extension.address);

        //  Deploy and initialize SporesNFTMinter contract
        //  This is a version that supports both single and batch minting Spores NFT Tokens
        //  SporesNFTMinter contract is also written following non-upgradeability feature
        const SporesNFTMinter = await ethers.getContractFactory('SporesNFTMinterV2', admin);
        minterV2 = await SporesNFTMinter.deploy(registry.address);

        //  transfer Minter role to new Minter contract
        await spo721.connect(admin).transferMinter(minterV2.address);
        await spo1155.connect(admin).transferMinter(minterV2.address);

        //  Add Market and Minter Version 2 contract into SporesRegistry
        await registry.updateMarket(marketV2.address);
        await registry.updateMinter(minterV2.address);
    });

    it('Should revert when purchase NFT721 with Native Coin from deprecated SporesNFTMarket', async() => {
        const tokenId = 7210002;

        //  Seller 'setApproveForAll' to allow SporesNFTMarketV1 transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);
   
        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        
        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase through deprecated SporesNFTMarket
        await expect(
            marketV1.connect(buyer).buyNFT721NativeCoin(info, signature2, {value: price})    
        ).to.be.revertedWith('SporesRegistry: Unauthorized');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });


    it('Should revert when purchase NFT721 with ERC20 from deprecated SporesNFTMarket', async() => {
        const tokenId = 7210011;

        //  Seller 'setApproveForAll' to allow SporesNFTMarketV1 transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV1.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarketV1 transfer ERC20
        await erc202.connect(buyer).approve(marketV1.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balaSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        
        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase through deprecated SporesNFTMarket
        await expect(
            marketV1.connect(buyer).buyNFT721ERC20(info, signature2)    
        ).to.be.revertedWith('SporesRegistry: Unauthorized');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balaSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    /*************************************************************************************************************
                                                Phase 2
        + SporesNFTMinterV2 (version 2) supports lazy minting, single and batch minting
        + SporesNFTMarketV2 (version 2) support purchasing NFT721 with Native Coin/ERC-20 Token and
            purchasing NFT721 as Lazy Minting with Native Coin/ERC-20 Token
        + Transfer from Version 1 -> Version 2
    **************************************************************************************************************/
    it('Should succeed to create CollectionV2', async() => {
        //  Create CollectionV2 - Collection 1
        //  This contract supports one multiple sub-collections, and lazy minting
        //  but NOT supports single and batch minting
        const collectionId = 721269;
        const maxEdition = 10;
        const requestId = 18002080;
        const collectionName = 'CollectionV2 - Collection 1';

        const CollectionV2 = await ethers.getContractFactory('CollectionV2', creator1);
        const signature = await creationSignature(
            verifier, collectionId, maxEdition, requestId, admin.address, registry.address
        );
        collectionv21 = await CollectionV2.deploy(
            admin.address, registry.address, collectionId, maxEdition, requestId, collectionName, '', signature
        );
    })

    it('Should succeed to create CollectionV3', async() => {
        //  Create CollectionV3 - Collection 1
        //  This contract supports multiple sub-collections, lazy minting
        //  and also supports single + batch minting
        const collectionId = 721369;
        const maxEdition = 11;
        const requestId = 18002080;
        const collectionName = 'CollectionV2 - Collection 1';

        const CollectionV3 = await ethers.getContractFactory('CollectionV3', creator2);
        const signature = await creationSignature(
            verifier, collectionId, maxEdition, requestId, admin.address, registry.address
        );
        collectionv31 = await CollectionV3.deploy(
            admin.address, registry.address, collectionId, maxEdition, requestId, collectionName, '', signature
        );
    })

    it('Should succeed when Buyer purchase an item as lazy minting - Native Coin - CollectionV2', async() => {
        const tokenId = BigNumber.from('7212690001000000000001')
        const uri = 'https://test.metadata/7212690001000000000001';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 1000;
        const saleId = 180021080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 1000;
        const feeRate = 50000;
        const fee = BigNumber.from(purchasePrice).mul(feeRate).div(1000000);
        const payToSeller = BigNumber.from(purchasePrice).sub(fee);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, ethers.constants.AddressZero, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        const tx = await marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice});
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' }); 

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator1.address);
        expect(event.args._paymentReceiver).deep.equal(creator1.address);
        expect(event.args._contractNFT).deep.equal(collectionv21.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(purchasePrice);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(fee);
        expect(event.args._saleId).deep.equal(saleId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        expect(await collectionv21.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer.add(SINGLE_UNIT));
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator.add(payToSeller));
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury.add(fee));
    });

    it('Should succeed when Buyer purchase an item as lazy minting - Native Coin - CollectionV3', async() => {
        const tokenId = BigNumber.from('7213690001000000000001')
        const uri = 'https://test.metadata/7213690001000000000001';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 2000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 2000;
        const feeRate = 50000;
        const fee = BigNumber.from(purchasePrice).mul(feeRate).div(1000000);
        const payToSeller = BigNumber.from(purchasePrice).sub(fee);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        const tx = await marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice});
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' }); 

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator2.address);
        expect(event.args._paymentReceiver).deep.equal(creator2.address);
        expect(event.args._contractNFT).deep.equal(collectionv31.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(purchasePrice);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(fee);
        expect(event.args._saleId).deep.equal(saleId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        expect(await collectionv31.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer.add(SINGLE_UNIT));
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator.add(payToSeller));
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury.add(fee));
    });

    it('Should succeed when Buyer purchase an item as lazy minting - ERC20 - CollectionV2', async() => {
        const tokenId = BigNumber.from('7212690001000000000002')
        const uri = 'https://test.metadata/7212690001000000000002';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 10000;
        const saleId = 180021080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 10000;
        const feeRate = 50000;
        const fee = BigNumber.from(purchasePrice).mul(feeRate).div(1000000);
        const payToSeller = BigNumber.from(purchasePrice).sub(fee);

        //  Mint ERC-20 - Buyer and set an amount of allowance
        await erc201.mint(buyer.address, 1000000000000000);
        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        const tx = await marketV2.connect(buyer).redeem(addrs, uints, data);
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' }); 

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator1.address);
        expect(event.args._paymentReceiver).deep.equal(creator1.address);
        expect(event.args._contractNFT).deep.equal(collectionv21.address);
        expect(event.args._paymentToken).deep.equal(erc201.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(purchasePrice);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(fee);
        expect(event.args._saleId).deep.equal(saleId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_721);

        expect(await collectionv21.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer.add(SINGLE_UNIT));
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer.sub(purchasePrice));
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator.add(payToSeller));
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury.add(fee));
    });

    it('Should succeed when Buyer purchase an item as lazy minting - ERC20 - CollectionV3', async() => {
        const tokenId = BigNumber.from('7213690001000000000002')
        const uri = 'https://test.metadata/7213690001000000000002';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 20000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 20000;
        const feeRate = 50000;
        const fee = BigNumber.from(purchasePrice).mul(feeRate).div(1000000);
        const payToSeller = BigNumber.from(purchasePrice).sub(fee);

        //  Mint ERC-20 - Buyer and set an amount of allowance
        await erc202.mint(buyer.address, 1000000000000000);
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, erc202.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, erc202.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await erc202.balanceOf(creator2.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const balTreasury = await erc202.balanceOf(treasury.address);

        const tx = await marketV2.connect(buyer).redeem(addrs, uints, data);
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' }); 

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator2.address);
        expect(event.args._paymentReceiver).deep.equal(creator2.address);
        expect(event.args._contractNFT).deep.equal(collectionv31.address);
        expect(event.args._paymentToken).deep.equal(erc202.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(purchasePrice);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(fee);
        expect(event.args._saleId).deep.equal(saleId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_721);

        expect(await collectionv31.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer.add(SINGLE_UNIT));
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer.sub(purchasePrice));
        expect(await erc202.balanceOf(creator2.address)).deep.equal(balCreator.add(payToSeller));
        expect(await erc202.balanceOf(treasury.address)).deep.equal(balTreasury.add(fee));
    });

    it('Should succeed when User cancels onsale with valid settings', async() => {
        const saleId = 11112222;
        const sig = await cancelSignature(verifier, saleId, creator1.address);

        expect(await extension.canceled(saleId)).deep.equal(false);
        const tx = await marketV2.connect(creator1).cancel(saleId, sig);
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'Cancel' }); 

        expect(event != undefined).true;
        expect(event.args._saleId).deep.equal(saleId);
        expect(event.args._seller).deep.equal(creator1.address);

        expect(await extension.canceled(saleId)).deep.equal(true);
    });

    it('Should revert when User cancels onsale without a signature', async() => {
        const saleId = 2123456;
        const emptySig = ethers.utils.arrayify(0);

        expect(await extension.canceled(saleId)).deep.equal(false);
        await expect(
            marketV2.connect(creator1).cancel(saleId, emptySig)  
        ).to.be.revertedWith('ECDSA: invalid signature length');
        expect(await extension.canceled(saleId)).deep.equal(false);
    });

    it('Should revert when User cancels onsale, but saleId was already recorded', async() => {
        const saleId = 11112222;        //  saleId was canceled by creator1
        const sig = await cancelSignature(verifier, saleId, creator2.address);

        expect(await extension.canceled(saleId)).deep.equal(true);
        await expect(
            marketV2.connect(creator2).cancel(saleId, sig)  
        ).to.be.revertedWith('SaledID already recorded');
        expect(await extension.canceled(saleId)).deep.equal(true);
    });

    it('Should revert when User cancels onsale, but saleId, params and signature, not matched', async() => {
        const saleId = 2123456;        
        const invalidSaleId = 12345;
        const sig = await cancelSignature(verifier, saleId, creator1.address);

        expect(await extension.canceled(saleId)).deep.equal(false);
        expect(await extension.canceled(invalidSaleId)).deep.equal(false);
        await expect(
            marketV2.connect(creator1).cancel(invalidSaleId, sig)  
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');
        expect(await extension.canceled(saleId)).deep.equal(false);
        expect(await extension.canceled(invalidSaleId)).deep.equal(false);
    });

    it('Should revert when User cancels onsale, but seller, params and signature, not matched', async() => {
        const saleId = 2123456;        
        const sig = await cancelSignature(verifier, saleId, creator1.address);

        expect(await extension.canceled(saleId)).deep.equal(false);
        await expect(
            marketV2.connect(creator2).cancel(saleId, sig)  
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');
        expect(await extension.canceled(saleId)).deep.equal(false);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but price is invalid - Native Coin', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 2999;                 //  invalid purchase price. Require: purchasePrice >= unitPrice      
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, ethers.constants.AddressZero, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid purchase price');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but price is invalid - ERC20', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 29999;        //  invalid purchase price. Require: purchasePrice >= unitPrice 
        const feeRate = 50000;

        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, erc202.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, erc202.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await erc202.balanceOf(creator2.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const balTreasury = await erc202.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid purchase price');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc202.balanceOf(creator2.address)).deep.equal(balCreator);
        expect(await erc202.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but insufficient payment - Native Coin', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const insufficientPayment = 2999;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, ethers.constants.AddressZero, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: insufficientPayment})
        ).to.be.revertedWith('SporesNFTMarketV2: Insufficient payment');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but insufficient balance - ERC20', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = (await erc202.balanceOf(buyer.address)).add(1);
        const feeRate = 50000;

        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, erc202.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, erc202.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await erc202.balanceOf(creator2.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const balTreasury = await erc202.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc202.balanceOf(creator2.address)).deep.equal(balCreator);
        expect(await erc202.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but saleId was canceled - Native Coin', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 11112222;    // saleID was canceled
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, ethers.constants.AddressZero, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('Invalid saleId');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but saleId was canceled - ERC20', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 11112222;    // saleId was canceled
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, erc202.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, erc202.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await erc202.balanceOf(creator2.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const balTreasury = await erc202.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('Invalid saleId');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc202.balanceOf(creator2.address)).deep.equal(balCreator);
        expect(await erc202.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but invalid paymentToken - ERC20', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;   
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  erc205 token contract has not been registered
        await erc205.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, erc205.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, erc205.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await erc205.balanceOf(creator2.address);
        const balBuyer = await erc205.balanceOf(buyer.address);
        const balTreasury = await erc205.balanceOf(treasury.address);

        //  Even though Buyer does not have any ERC-20 tokens in erc205 contract
        //  the code fails likely before making a payment
        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid payment');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc205.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc205.balanceOf(creator2.address)).deep.equal(balCreator);
        expect(await erc205.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but nftContract is invalid - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        const opcode = 721;
        //  Un-register token721 contract
        await registry.connect(admin).unregisterNFTContract(token721.address, opcode);

        //  Assume Creator generates a valid signature with a valid nftContract address
        //  However, nftContract, that is passed into a Market contract, is incorrect 
        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead of passing an address of CollectionV31 contract
        //  Another address, i.e. token721, is provided
        const addrs = [creator2.address, token721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Contract not supported');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but nftContract is invalid - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Assume Creator generates a valid signature with a valid nftContract address
        //  However, nftContract, that is passed into a Market contract, is incorrect 
        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead of passing an address of CollectionV31 contract
        //  Another address, i.e. token721, is provided
        const addrs = [creator1.address, token721.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Contract not supported');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but minting signature is not provided - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  Assume minting signature is empty
        const sig1 = ethers.utils.arrayify(0);

        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but minting signature is not provided - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Assume minting signature is empty
        const sig1 = ethers.utils.arrayify(0);

        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but sale signature is not provided - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )

        //  Assume SaleInfo signature is empty
        const sig2 = ethers.utils.arrayify(0);

        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but sale signature is not provided - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )

        //  Assume SaleInfo signature is empty
        const sig2 = ethers.utils.arrayify(0);

        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but authorized signature is not provided - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )

        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )

        //  Assume authorized signature is empty
        const sig3 = ethers.utils.arrayify(0);

        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but authorized signature is not provided - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )

        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )

        //  Assume authorized signature is empty
        const sig3 = ethers.utils.arrayify(0)

        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but creators, param and signed, are not matched - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of Creator1 is provided in the param
        const addrs = [creator1.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator2 = await provider.getBalance(creator2.address);
        const balCreator1 = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator1);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator2);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but creators, param and signed, are not matched - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of Creator2 is provided in the param
        const addrs = [creator2.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator1 = await erc201.balanceOf(creator1.address);
        const balCreator2 = await erc201.balanceOf(creator2.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator1);
        expect(await erc201.balanceOf(creator2.address)).deep.equal(balCreator2);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but nftContract, param and signed, are not matched - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of collectionv21 is provided in the param
        const addrs = [creator2.address, collectionv21.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreatorV31 = await collectionv31.balanceOf(creator2.address);
        const itemBuyerV31 = await collectionv31.balanceOf(buyer.address);
        const itemCreatorV21 = await collectionv21.balanceOf(creator2.address);
        const itemBuyerV21 = await collectionv21.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreatorV31);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyerV31);
        expect(await collectionv21.balanceOf(creator2.address)).deep.equal(itemCreatorV21);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyerV21);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but nftContract, param and signed, are not matched - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of collectionV31 is provided in the param
        const addrs = [creator1.address, collectionv31.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreatorV21 = await collectionv21.balanceOf(creator1.address);
        const itemBuyerV21 = await collectionv21.balanceOf(buyer.address);
        const itemCreatorV31 = await collectionv31.balanceOf(creator1.address);
        const itemBuyerV31 = await collectionv31.balanceOf(buyer.address);
        const balCreator1 = await erc201.balanceOf(creator1.address);
        const balCreator2 = await erc201.balanceOf(creator2.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreatorV21);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyerV21);
        expect(await collectionv31.balanceOf(creator1.address)).deep.equal(itemCreatorV31);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyerV31);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator1);
        expect(await erc201.balanceOf(creator2.address)).deep.equal(balCreator2);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but paymentToken, param and signed, are not matched - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of ERC-20 token is provided
        const addrs = [creator2.address, collectionv31.address, erc202.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);
        const balERCCreator = await erc202.balanceOf(creator2.address);
        const balERCTreasury = await erc202.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(creator2.address)).deep.equal(balERCCreator);
        expect(await erc202.balanceOf(treasury.address)).deep.equal(balERCTreasury);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but paymentToken, param and signed, are not matched - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of erc202 is provided in the param
        const addrs = [creator1.address, collectionv21.address, erc202.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator201 = await erc201.balanceOf(creator1.address);
        const balBuyer201 = await erc201.balanceOf(buyer.address);
        const balTreasury201 = await erc201.balanceOf(treasury.address);
        const balCreator202 = await erc202.balanceOf(creator1.address);
        const balBuyer202 = await erc202.balanceOf(buyer.address);
        const balTreasury202 = await erc202.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator201);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer201);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury201);
        expect(await erc202.balanceOf(creator1.address)).deep.equal(balCreator202);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer202);
        expect(await erc202.balanceOf(treasury.address)).deep.equal(balTreasury202);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but paymentReceiver, param and signed, are not matched - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of buyer is provided as paymentReceiver
        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, buyer.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but paymentReceiver, param and signed, are not matched - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of Buyer is provided
        const addrs = [creator1.address, collectionv21.address, erc201.address, buyer.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but tokenId, param and signed, are not matched - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const invalidTokenId = BigNumber.from('72136900011234')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [invalidTokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collectionv31.ownerOf(invalidTokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collectionv31.ownerOf(invalidTokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but tokenId, param and signed, are not matched - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const invalidTokenId = BigNumber.from('72136900011234')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidTokenId is provided
        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [invalidTokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collectionv21.ownerOf(invalidTokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collectionv21.ownerOf(invalidTokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but unitPrice, param and signed, are not matched - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const invalidUnitPrice = 3000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const invalidPurchasePrice = 3000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, Buyer provides invalidUnitPrice and invalidPurchasePrice
        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, invalidUnitPrice, saleId, invalidPurchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: invalidPurchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but unitPrice, param and signed, are not matched - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const invalidUnitPrice = 1000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const invalidPurchasePrice = 1000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidUnitPrice and invalidPurchasePrice are provided
        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, invalidUnitPrice, saleId, invalidPurchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but saleId, param and signed, are not matched - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const invalidSaleId = 1234;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidSaleId is provided
        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, invalidSaleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but saleId, param and signed, are not matched - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const invalidSaleId = 1234;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidSaleId is provided
        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, invalidSaleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but purchasePrice, param and signed, are not matched - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 10000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const invalidPurchasePrice = 10000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidPurchasePrice is provided
        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, invalidPurchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: invalidPurchasePrice})
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but purchasePrice, param and signed, are not matched - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 1000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const invalidPurchasePrice = 1000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidPurchasePrice is provided
        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, invalidPurchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but feeRate, param and signed, are not matched - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;
        const invalidFeeRate = 10000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidFeeRate is provided
        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, invalidFeeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but feeRate, param and signed, are not matched - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;
        const invalidFeeRate = 10000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidFeeRate is provided
        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, invalidFeeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but not set allowance - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        //  Buyer not set allowance
        await erc201.connect(buyer).approve(marketV2.address, 0);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('ERC20: transfer amount exceeds allowance');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    })

    it('Should revert when User purchases an item as lazy minting, but tokenId already minted - Native Coin', async() => {
        const tokenId = BigNumber.from('7213690001000000000001')        //  tokenId already minted
        const uri = 'https://test.metadata/7213690001000000000001';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031090;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        expect(await collectionv31.ownerOf(tokenId)).deep.equal(buyer.address); 
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(creator1.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(creator1).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await collectionv31.ownerOf(tokenId)).deep.equal(buyer.address); 
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(creator1.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when User purchases an item as lazy minting, but tokenId already minted - ERC20', async() => {
        const tokenId = BigNumber.from('7212690001000000000001')        //  tokenId already minted
        const uri = 'https://test.metadata/7212690001000000000001';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.mint(creator2.address, 1000000000000000);
        await erc201.connect(creator2).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        expect(await collectionv21.ownerOf(tokenId)).deep.equal(buyer.address);
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(creator2.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(creator2.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(creator2).redeem(addrs, uints, data)
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await collectionv21.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(creator2.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(creator2.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it(`Should revert when Buyer purchases an item as lazy minting, but Creator and Collection's Owner are not matched - Native Coin`, async() => {
        const tokenId = BigNumber.from('7213690001000000000003')
        const uri = 'https://test.metadata/7213690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031090;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  Collectionv21 is owned by Creator1 and CollectionV31 is owned by Creator2
        //  NFT's creator generates Lazymint signature, but address is the collectionv21
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv21.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv21.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator2.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('CollectionV2: Invalid creator');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token'); 
        expect(await collectionv21.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it(`Should revert when Buyer purchases an item as lazy minting, but Creator and Collection's Owner are not matched - ERC20`, async() => {
        const tokenId = BigNumber.from('7212690001000000000003')
        const uri = 'https://test.metadata/7212690001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Collectionv21 is owned by Creator1 and CollectionV31 is owned by Creator2
        //  NFT's creator generates Lazymint signature, but address is the collectionv31
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv31.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv31.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator1.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('CollectionV3: Invalid creator');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv31.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it(`Should revert when Buyer purchases an item as lazy minting, but collectionID, derived from tokenID, is invalid - Native Coin`, async() => {
        const tokenId = BigNumber.from('7213700001000000000003')    //  CollectionID = 721369
        const uri = 'https://test.metadata/7213700001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031090;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('CollectionV3: Invalid collection');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token'); 
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it(`Should revert when Buyer purchases an item as lazy minting, but collectionID, derived from tokenID, is invalid - ERC20`, async() => {
        const tokenId = BigNumber.from('7212700001000000000003')    //  CollectionID = 721269
        const uri = 'https://test.metadata/7212700001000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Collectionv21 is owned by Creator1 and CollectionV31 is owned by Creator2
        //  NFT's creator generates Lazymint signature, but address is the collectionv31
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('CollectionV2: Invalid collection');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it(`Should revert when Buyer purchases an item as lazy minting, but sub-collectionID, derived from tokenID, is invalid - Native Coin`, async() => {
        const tokenId = BigNumber.from('7213690002000000000003')            //  Currently, only one sub-collection is created
        const uri = 'https://test.metadata/7213690002000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031090;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, collectionv31.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, collectionv31.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, collectionv31.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv31.balanceOf(creator2.address);
        const itemBuyer = await collectionv31.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('CollectionV3: Reach max edition');

        await expect(
            collectionv31.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token'); 
        expect(await collectionv31.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it(`Should revert when Buyer purchases an item as lazy minting, but sub-collectionID, derived from tokenID, is invalid - ERC20`, async() => {
        const tokenId = BigNumber.from('7212690002000000000003')            //  Currently, only one sub-collection is created
        const uri = 'https://test.metadata/7212690002000000000003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Collectionv21 is owned by Creator1 and CollectionV31 is owned by Creator2
        //  NFT's creator generates Lazymint signature, but address is the collectionv31
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, collectionv21.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, collectionv21.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, collectionv21.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await collectionv21.balanceOf(creator1.address);
        const itemBuyer = await collectionv21.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('CollectionV2: Reach max edition');

        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await collectionv21.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should succeed when Buyer purchase an item as lazy minting - Native Coin - Spores721', async() => {
        const tokenId = BigNumber.from('72166880001')
        const uri = 'https://test.metadata/72166880001';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 6000;
        const saleId = 180021080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 6000;
        const feeRate = 50000;
        const fee = BigNumber.from(purchasePrice).mul(feeRate).div(1000000);
        const payToSeller = BigNumber.from(purchasePrice).sub(fee);

        //  Lazy minting to SporesNFT721 will proceed as:
        //      + Mint NFT to Creator
        //      + Transfer minted NFT to Buyer
        //  In transferring, Creator must setApprovalForAll
        await spo721.connect(creator1).setApprovalForAll(marketV2.address, true);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, ethers.constants.AddressZero, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        const tx = await marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice});
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' }); 

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator1.address);
        expect(event.args._paymentReceiver).deep.equal(creator1.address);
        expect(event.args._contractNFT).deep.equal(spo721.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(purchasePrice);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(fee);
        expect(event.args._saleId).deep.equal(saleId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer.add(SINGLE_UNIT));
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator.add(payToSeller));
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury.add(fee));
    });

    it('Should succeed when Buyer purchase an item as lazy minting - ERC20 - Spores721', async() => {
        const tokenId = BigNumber.from('72166880002')
        const uri = 'https://test.metadata/72166880002';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 180021080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;
        const fee = BigNumber.from(purchasePrice).mul(feeRate).div(1000000);
        const payToSeller = BigNumber.from(purchasePrice).sub(fee);

        //  Mint ERC-20 - Buyer and set an amount of allowance
        await erc203.mint(buyer.address, 1000000000000000);
        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Lazy minting to SporesNFT721 will proceed as:
        //      + Mint NFT to Creator
        //      + Transfer minted NFT to Buyer
        //  In transferring, Creator must setApprovalForAll
        await spo721.connect(creator1).setApprovalForAll(marketV2.address, true);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        const tx = await marketV2.connect(buyer).redeem(addrs, uints, data);
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' }); 

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(creator1.address);
        expect(event.args._paymentReceiver).deep.equal(creator1.address);
        expect(event.args._contractNFT).deep.equal(spo721.address);
        expect(event.args._paymentToken).deep.equal(erc203.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(purchasePrice);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(fee);
        expect(event.args._saleId).deep.equal(saleId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_721);

        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer.add(SINGLE_UNIT));
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer.sub(purchasePrice));
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator.add(payToSeller));
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury.add(fee));
    });

    it('Should revert when Buyer purchases an item as lazy minting, but price is invalid - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 7999;                 //  invalid purchase price. Require: purchasePrice >= unitPrice      
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, ethers.constants.AddressZero, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid purchase price');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but price is invalid - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 79999;        //  invalid purchase price. Require: purchasePrice >= unitPrice 
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, spo721.address, erc203.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator2.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid purchase price');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(creator2.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but insufficient payment - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 6000;
        const saleId = 180021080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 6000;
        const insufficientPayment = 5999;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, ethers.constants.AddressZero, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: insufficientPayment})
        ).to.be.revertedWith('SporesNFTMarketV2: Insufficient payment');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but insufficient balance - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('772166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = (await erc203.balanceOf(buyer.address)).add(1);
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, spo721.address, erc203.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator2.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(creator2.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but saleId was canceled - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 6000;
        const saleId = 11112222;    // saleID was canceled
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 6000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, ethers.constants.AddressZero, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('Invalid saleId');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but saleId was canceled - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 11112222;    // saleId was canceled
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, spo721.address, erc203.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator2.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('Invalid saleId');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(creator2.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but invalid paymentToken - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 180031080;   
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;

        //  erc205 token contract has not been registered
        await erc205.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, erc205.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, spo721.address, erc205.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc205.balanceOf(creator2.address);
        const balBuyer = await erc205.balanceOf(buyer.address);
        const balTreasury = await erc205.balanceOf(treasury.address);

        //  Even though Buyer does not have any ERC-20 tokens in erc205 contract
        //  the code fails likely before making a payment
        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid payment');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc205.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc205.balanceOf(creator2.address)).deep.equal(balCreator);
        expect(await erc205.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but nftContract is invalid - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 60000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 60000;
        const feeRate = 50000;

        //  Assume Creator generates a valid signature with a valid nftContract address
        //  However, nftContract, that is passed into a Market contract, is incorrect 
        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead of passing an address of CollectionV31 contract
        //  Another address, i.e. token721, is provided
        const addrs = [creator2.address, token721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Contract not supported');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but nftContract is invalid - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Assume Creator generates a valid signature with a valid nftContract address
        //  However, nftContract, that is passed into a Market contract, is incorrect 
        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead of passing an address of spo721 contract
        //  Another address, i.e. token721, is provided
        const addrs = [creator1.address, token721.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Contract not supported');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but minting signature is not provided - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 60000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 60000;
        const feeRate = 50000;

        //  Assume minting signature is empty
        const sig1 = ethers.utils.arrayify(0);

        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but minting signature is not provided - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Assume minting signature is empty
        const sig1 = ethers.utils.arrayify(0);

        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but sale signature is not provided - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 60000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 60000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )

        //  Assume SaleInfo signature is empty
        const sig2 = ethers.utils.arrayify(0);

        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but sale signature is not provided - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )

        //  Assume SaleInfo signature is empty
        const sig2 = ethers.utils.arrayify(0);

        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but authorized signature is not provided - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )

        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )

        //  Assume authorized signature is empty
        const sig3 = ethers.utils.arrayify(0);

        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but authorized signature is not provided - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )

        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )

        //  Assume authorized signature is empty
        const sig3 = ethers.utils.arrayify(0)

        const addrs = [creator1.address, spo721.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but creators, param and signed, are not matched - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of Creator1 is provided in the param
        const addrs = [creator1.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator2 = await provider.getBalance(creator2.address);
        const balCreator1 = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator1);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator2);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but creators, param and signed, are not matched - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of Creator2 is provided in the param
        const addrs = [creator2.address, spo721.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator1 = await erc203.balanceOf(creator1.address);
        const balCreator2 = await erc203.balanceOf(creator2.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator1);
        expect(await erc203.balanceOf(creator2.address)).deep.equal(balCreator2);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but nftContract, param and signed, are not matched - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of collectionv21 is provided in the param
        const addrs = [creator2.address, collectionv21.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreatorSPO = await spo721.balanceOf(creator2.address);
        const itemBuyerSPO = await spo721.balanceOf(buyer.address);
        const itemCreatorV21 = await collectionv21.balanceOf(creator2.address);
        const itemBuyerV21 = await collectionv21.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            collectionv21.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreatorSPO);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyerSPO);
        expect(await collectionv21.balanceOf(creator2.address)).deep.equal(itemCreatorV21);
        expect(await collectionv21.balanceOf(buyer.address)).deep.equal(itemBuyerV21);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but nftContract, param and signed, are not matched - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of collectionV31 is provided in the param
        const addrs = [creator1.address, collectionv31.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreatorSPO = await spo721.balanceOf(creator1.address);
        const itemBuyerSPO = await spo721.balanceOf(buyer.address);
        const itemCreatorV31 = await collectionv31.balanceOf(creator1.address);
        const itemBuyerV31 = await collectionv31.balanceOf(buyer.address);
        const balCreator1 = await erc203.balanceOf(creator1.address);
        const balCreator2 = await erc203.balanceOf(creator2.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreatorSPO);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyerSPO);
        expect(await collectionv31.balanceOf(creator1.address)).deep.equal(itemCreatorV31);
        expect(await collectionv31.balanceOf(buyer.address)).deep.equal(itemBuyerV31);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator1);
        expect(await erc203.balanceOf(creator2.address)).deep.equal(balCreator2);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but paymentToken, param and signed, are not matched - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 60000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 60000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of ERC-20 token is provided
        const addrs = [creator2.address, spo721.address, erc203.address, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);
        const balERCCreator = await erc203.balanceOf(creator2.address);
        const balERCTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator2.address)).deep.equal(balERCCreator);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balERCTreasury);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but paymentToken, param and signed, are not matched - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const feeRate = 50000;

        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);
        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of erc202 is provided in the param
        const addrs = [creator1.address, spo721.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator203 = await erc203.balanceOf(creator1.address);
        const balBuyer203 = await erc203.balanceOf(buyer.address);
        const balTreasury203 = await erc203.balanceOf(treasury.address);
        const balCreator201 = await erc201.balanceOf(creator1.address);
        const balBuyer201 = await erc201.balanceOf(buyer.address);
        const balTreasury201 = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator203);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer203);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury203);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator201);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer201);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury201);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but paymentReceiver, param and signed, are not matched - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of buyer is provided as paymentReceiver
        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, buyer.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but paymentReceiver, param and signed, are not matched - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 6000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 6000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, address of Buyer is provided
        const addrs = [creator1.address, spo721.address, erc203.address, buyer.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but tokenId, param and signed, are not matched - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const invalidTokenId = BigNumber.from('7211234')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 60000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 60000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [invalidTokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            spo721.ownerOf(invalidTokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            spo721.ownerOf(invalidTokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but tokenId, param and signed, are not matched - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const invalidTokenId = BigNumber.from('7211234')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidTokenId is provided
        const addrs = [creator1.address, spo721.address, erc203.address, creator1.address];
        const uints = [invalidTokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            spo721.ownerOf(invalidTokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            spo721.ownerOf(invalidTokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but unitPrice, param and signed, are not matched - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const invalidUnitPrice = 8000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const invalidPurchasePrice = 8000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, Buyer provides invalidUnitPrice and invalidPurchasePrice
        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, invalidUnitPrice, saleId, invalidPurchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: invalidPurchasePrice})
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but unitPrice, param and signed, are not matched - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const invalidUnitPrice = 1000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const invalidPurchasePrice = 1000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidUnitPrice and invalidPurchasePrice are provided
        const addrs = [creator1.address, spo721.address, erc203.address, creator1.address];
        const uints = [tokenId, invalidUnitPrice, saleId, invalidPurchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid signature or params');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but saleId, param and signed, are not matched - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 180031080;
        const invalidSaleId = 1234;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidSaleId is provided
        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, invalidSaleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but saleId, param and signed, are not matched - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 8000;
        const saleId = 180021080;    
        const invalidSaleId = 1234;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 8000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidSaleId is provided
        const addrs = [creator1.address, spo721.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, invalidSaleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but purchasePrice, param and signed, are not matched - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 10000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const invalidPurchasePrice = 10000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidPurchasePrice is provided
        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, invalidPurchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: invalidPurchasePrice})
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but purchasePrice, param and signed, are not matched - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 1000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const invalidPurchasePrice = 1000;
        const feeRate = 50000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidPurchasePrice is provided
        const addrs = [creator1.address, spo721.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, invalidPurchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but feeRate, param and signed, are not matched - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 30000;
        const saleId = 180031080;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 30000;
        const feeRate = 50000;
        const invalidFeeRate = 10000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidFeeRate is provided
        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, invalidFeeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but feeRate, param and signed, are not matched - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 3000;
        const saleId = 180021080;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 3000;
        const feeRate = 50000;
        const invalidFeeRate = 10000;

        await erc203.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc203.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        //  Instead, invalidFeeRate is provided
        const addrs = [creator1.address, spo721.address, erc203.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, invalidFeeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc203.balanceOf(creator1.address);
        const balBuyer = await erc203.balanceOf(buyer.address);
        const balTreasury = await erc203.balanceOf(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        await expect(
            spo721.ownerOf(tokenId)  
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc203.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc203.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc203.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when User purchases an item as lazy minting, but tokenId already minted - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880001')        //  tokenId already minted
        const uri = 'https://test.metadata/72166880001';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 18001234;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, ethers.constants.AddressZero, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address); 
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(creator2.address);
        const balCreator = await provider.getBalance(creator1.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(creator2).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address); 
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator1.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when User purchases an item as lazy minting, but tokenId already minted - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880001')        //  tokenId already minted
        const uri = 'https://test.metadata/72166880001';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 6000;
        const saleId = 18001234;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 6000;
        const feeRate = 50000;

        await erc201.mint(creator2.address, 1000000000000000);
        await erc201.connect(creator2).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address);
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(creator2.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(creator2.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(creator2).redeem(addrs, uints, data)
        ).to.be.revertedWith('ERC721: token already minted');

        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(creator2.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when Buyer purchases an item as lazy minting, but Creator not setApprovalForAll - Spores721 - Native Coin', async() => {
        const tokenId = BigNumber.from('72166880003')        
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 80000;
        const saleId = 18001234;
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 80000;
        const feeRate = 50000;

        //  SporesNFT721: Lazy minting requires Creator setApprovalForAll
        //  so that when an NFT is minted, it can be transferred to Buyer
        //  Assume Creator not setApprovalForAll
        await spo721.connect(creator2).setApprovalForAll(marketV2.address, false);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator2, creator2.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator2, tokenId, spo721.address, creator2.address, creator2.address, ethers.constants.AddressZero, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator2.address, spo721.address, ethers.constants.AddressZero, creator2.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator2.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await provider.getBalance(creator2.address);
        const balTreasury = await provider.getBalance(treasury.address);

        await expect(
            marketV2.connect(buyer).redeem(addrs, uints, data, {value: purchasePrice})
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        await expect(
            spo721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator2.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(creator2.address)).deep.equal(balCreator);
        expect(await provider.getBalance(treasury.address)).deep.equal(balTreasury);
    });

    it('Should revert when User purchases an item as lazy minting, but Creator not setApprovalForAll - Spores721 - ERC20', async() => {
        const tokenId = BigNumber.from('72166880003')        
        const uri = 'https://test.metadata/72166880003';
        const mintAmt = SINGLE_UNIT;
        const unitPrice = 12000;
        const saleId = 18001234;    
        const onSaleAmt = SINGLE_UNIT;
        const purchaseAmt = SINGLE_UNIT;
        const purchasePrice = 12000;
        const feeRate = 50000;

        //  SporesNFT721: Lazy minting requires Creator setApprovalForAll
        //  so that when an NFT is minted, it can be transferred to Buyer
        //  Assume Creator not setApprovalForAll
        await spo721.connect(creator1).setApprovalForAll(marketV2.address, false);

        await erc201.mint(creator2.address, 1000000000000000);
        await erc201.connect(creator2).approve(marketV2.address, 1000000000000000);

        //  NFT's creator generates Lazymint signature
        const sig1 = await createLazyMintSignature(
            creator1, creator1.address, spo721.address, tokenId, mintAmt, ERC721
        )
        //  NFT's creator generates SaleInfo signature
        const sig2 = await createSaleSignature(
            creator1, tokenId, spo721.address, creator1.address, creator1.address, erc201.address, unitPrice
        )
        const sigHash1 = sigHash(sig1);
        const sigHash2 = sigHash(sig2);
        //  Verifier generate authorized signature
        const sig3 = await createAuthorizedSignature(
            verifier, saleId, onSaleAmt, purchasePrice, purchaseAmt, feeRate, sigHash1, sigHash2
        )

        const addrs = [creator1.address, spo721.address, erc201.address, creator1.address];
        const uints = [tokenId, unitPrice, saleId, purchasePrice, feeRate];
        const data = [sig1, sig2, sig3, uri];

        //  Check information before Buyer purchases through lazy minting
        await expect(
            spo721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        const itemCreator = await spo721.balanceOf(creator1.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const balCreator = await erc201.balanceOf(creator1.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const balTreasury = await erc201.balanceOf(treasury.address);

        await expect(
            marketV2.connect(creator2).redeem(addrs, uints, data)
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        await expect(
            spo721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(await spo721.balanceOf(creator1.address)).deep.equal(itemCreator);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc201.balanceOf(creator1.address)).deep.equal(balCreator);
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer);
        expect(await erc201.balanceOf(treasury.address)).deep.equal(balTreasury);
    });

    /*************************************************************************************************************
                                                Phase 3
        + Test same scenarios as in the Phase 1
    **************************************************************************************************************/
    it('Should succeed purchase NFT721 with native coin', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 72130001;
        const uri = 'https://test.metadata/72130001';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minterV2.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await marketV2.connect(buyer).purchase(
            info, signature2, 
            { 
                value: price 
            }
        );

        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(seller.address);
        expect(event.args._paymentReceiver).deep.equal(seller.address);
        expect(event.args._contractNFT).deep.equal(spo721.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller.sub(1));
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer.add(1));
        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller.add(payToSeller))
    });

    //  'Price' - param and signed by Verifier - are matched
    //  but msg.value is insufficient
    it('Should revert when purchase NFT721 with invalid Price - Invalid msg.value', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 72130002;
        const uri = 'https://test.metadata/72130002';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minterV2.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        
        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid msg.value
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2, 
                { 
                    value: invalidPrice 
                }
            )    
        ).to.be.revertedWith('SporesNFTMarketV2: Insufficient payment');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    //  'Price' - param and signed by Verifier - are NOT matched
    it('Should revert when purchase NFT721 with invalid Price', async() => {
        const tokenId = 72130002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        
        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, invalidPrice, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Price
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2,
                {
                    value: invalidPrice
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when purchase NFT721 with invalid token721 contract', async() => {
        const tokenId = 72130002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesNFTMarketV2: Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = 72130002;
        const invalidTokenId = 72131000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        await expect(
            spo721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            invalidTokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
        await expect(
            spo721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 72130003;
        const uri = 'https://test.metadata/72130003';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        const mintTx = await minterV2.connect(anotherSeller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const itemAnotherSeller = await spo721.balanceOf(anotherSeller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId - seller not owned
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesNFTMarketV2: Seller is not owner');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await spo721.balanceOf(anotherSeller.address)).deep.equal(itemAnotherSeller);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = 72130002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Seller
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = 72130002;

        //  Prepare input data, and send a minting request
        const tokenId2 = 72130004;
        const uri = 'https://test.metadata/72310004';
        const signature1 = await verifySignature(verifier, seller.address, tokenId2, uri, ERC721);
        const mintTx = await minterV2.connect(seller).mintSporesERC721(tokenId2, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId2)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId1,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId2, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId2)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when token721 - param and signed by Verifier - not matched', async() => {
        const tokenId = 72130002;
        const opcode = 721;

        //  Register invalidToken721 contract
        await registry.registerNFTContract(token721.address, opcode, false);

        //  Prepare input data, and send a minting request
        const mintTx = await token721.mint(seller.address, tokenId);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = 72130002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = 72130002;

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, false);
   
        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await provider.getBalance(seller.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await provider.getBalance(seller.address)).deep.equal(balSeller);
    });

    /************************************** ERC20 - NFT721 **************************************/

    it('Should succeed purchase NFT721 with ERC-20', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 72130010;
        const uri = 'https://test.metadata/72130010';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minterV2.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Mint ERC-201 to Buyer
        const erc201Amt = 1000000000000;
        await erc201.mint(buyer.address, erc201Amt);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc201.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc201.balanceOf(seller.address);
        const balBuyer = await erc201.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 100000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc201.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc201.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await marketV2.connect(buyer).purchase(info, signature2);
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(seller.address);
        expect(event.args._paymentReceiver).deep.equal(seller.address);
        expect(event.args._contractNFT).deep.equal(spo721.address);
        expect(event.args._paymentToken).deep.equal(erc201.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_721);

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller.sub(1));
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer.add(1));
        expect(await erc201.balanceOf(seller.address)).deep.equal(balSeller.add(payToSeller));
        expect(await erc201.balanceOf(buyer.address)).deep.equal(balBuyer.sub(price))
    });

    it('Should revert when purchase NFT721 with invalid payment', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 72130011;
        const uri = 'https://test.metadata/72130011';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minterV2.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Mint ERC-202 to Buyer
        const erc202Amt = 1000000000000;
        await erc202.mint(buyer.address, erc202Amt);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc205.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid ERC-20 payment token
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarketV2: Invalid payment');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when purchase NFT721 with invalid token721 contract', async() => {
        const tokenId = 7210011;
        const opcode = 721;

        //  Unregister invalidToken721 contract
        await registry.unregisterNFTContract(token721.address, opcode);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarketV2: Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = 72130011;
        const invalidTokenId = 72131000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        await expect(
            spo721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            invalidTokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
        await expect(
            spo721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 72130012;
        const uri = 'https://test.metadata/7210012';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        const mintTx = await minterV2.connect(anotherSeller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);
        const itemAnotherSeller = await spo721.balanceOf(anotherSeller.address);
        
        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId - Seller not owned
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarketV2: Seller is not owner');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await spo721.balanceOf(anotherSeller.address)).deep.equal(itemAnotherSeller);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = 72130011;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Seller
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = 72130011;

        //  Prepare input data, and send a minting request
        const tokenId2 = 72130013;
        const uri = 'https://test.metadata/72130013';
        const signature1 = await verifySignature(verifier, seller.address, tokenId2, uri, ERC721);
        const mintTx = await minterV2.connect(seller).mintSporesERC721(tokenId2, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
       await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId2)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId1,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId2, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId2)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when token721 - param and signed by Verifier - not matched', async() => {
        const tokenId = 72130011;
        const opcode = 721;

        //  Register invalidToken721 contract
        await registry.registerNFTContract(token721.address, opcode, false);

        //  Prepare input data, and send a minting request
        const mintTx = await token721.mint(seller.address, tokenId);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = 72130011;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = 72130011;

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await spo721.connect(seller).setApprovalForAll(marketV2.address, false);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(marketV2.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        const balSeller = await erc202.balanceOf(seller.address);
        const balBuyer = await erc202.balanceOf(buyer.address);
        const itemSeller = await spo721.balanceOf(seller.address);
        const itemBuyer = await spo721.balanceOf(buyer.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, spo721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, spo721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            marketV2.connect(buyer).purchase(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        //  Check balance of Seller, Buyer after purchase
        expect(await spo721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(await spo721.balanceOf(seller.address)).deep.equal(itemSeller);
        expect(await spo721.balanceOf(buyer.address)).deep.equal(itemBuyer);
        expect(await erc202.balanceOf(seller.address)).deep.equal(balSeller);
        expect(await erc202.balanceOf(buyer.address)).deep.equal(balBuyer);
    });
    
});