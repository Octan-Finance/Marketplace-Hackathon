const { BigNumber } = require('@ethersproject/bignumber');
const chai = require('chai');
const chaiAsPromise = require('chai-as-promised');
const { ethers, upgrades } = require('hardhat');
const { TASK_ETHERSCAN_VERIFY } = require('hardhat-deploy');


chai.use(chaiAsPromise);
const expect = chai.expect;

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

//  This test splits into three cases:
//  - Case 1:
//      + SporesRegistry is fixed (non-upgrade)
//      + Phase 1: SporesNFTMarket supports Buy/Sell NFT721
//      + Phase 2: Release SporesNFTMarketv2 supports Buy/Sell NFT1155
//        Both contract is running concurrently
//  - Case 2:
//      + SporesRegistry is fixed (non-upgrade)
//      + Phase 1: SporesNFTMarket supports Buy/Sell NFT721
//      + Phase 2: Release SporesNFTMarketv3 supports both Buy/Sell NFT721-NFT1155
//  - Case 3: Testing SporesRegistry Upgradeability
//      + SporesRegistry is deployed
//      + Phase 1: SporesNFTMarket supports Buy/Sell NFT721
//      + Phase 2: 
//          * SporesRegistry is updated
//          * Release SporesNFTMarketUpgradeTest

/**********************************************************************************************************************
- Case 3:
    + SporesRegistry is deployed
    + Phase 1: SporesNFTMarket supports Buy/Sell NFT721
    + Phase 2: 
        * SporesRegistry is updated
        * Release SporesNFTMarketUpgradeTest
***********************************************************************************************************************/

describe('SporesNFTMarket Contract Testing - Buy NFT721/NFT1155 with ERC20/Native Coin - Case 3', () => {
    let provider;
    let deployer, seller, buyer, verifier, feeCollector, verifier2, verifier3;
    let token721, token1155, minter, market, registry;
    let invalidToken721, invalidToken1155;
    let newMinter, newMarket;

    const NATIVE_COIN_NFT_721 = 0;
    const NATIVE_COIN_NFT_1155 = 1;
    const ERC_20_NFT_721 = 2;
    const ERC_20_NFT_1155 = 3;
    const SINGLE_UNIT = 1;
    const ERC721 = 0;
    const ERC1155 = 1;

    const STATUS = {
        'ACTIVE'    : 0,
        'DEPRECATED': 1
    };

    before(async() => {
        //  Get pre-fund accounts
        [deployer, seller, buyer, verifier, feeCollector, anotherSeller, verifier2, verifier3] = await ethers.getSigners();
        provider = ethers.provider;

        //  Deploy and initialize SporesNFT721 contract
        //  SporesNFT721 contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesNFT721 = await ethers.getContractFactory('SporesNFT721', deployer);
        token721 = await upgrades.deployProxy(SporesNFT721, ['Spores NFT', 'SPONFT'], {initializer: 'init'});
        await token721.deployed();

        //  Deploy and initialize SporesNFT1155 contract
        //  SporesNFT1155 contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesNFT1155 = await ethers.getContractFactory('SporesNFT1155', deployer);
        token1155 = await upgrades.deployProxy(SporesNFT1155, {initializer: 'init'});
        await token1155.deployed();

        //  Deploy invalid token721 and token1155 contract. These contracts are just example
        const NFT721 = await ethers.getContractFactory('ERC721Test', deployer);
        const NFT1155 = await ethers.getContractFactory('ERC1155Test', deployer);
        invalidToken721 = await NFT721.deploy('NFT721', 'NFT721');
        invalidToken1155 = await NFT1155.deploy();

        //  Deploy some ERC20Test contracts. These contracts are used for testing only
        const ERC20 = await ethers.getContractFactory('ERC20Test', deployer);
        erc201 = await ERC20.deploy('ERC20-1', 'ERC20-1');
        erc202 = await ERC20.deploy('ERC20-2', 'ERC20-2');
        erc203 = await ERC20.deploy('ERC20-3', 'ERC20-3');
        erc204 = await ERC20.deploy('ERC20-4', 'ERC20-4');
        erc205 = await ERC20.deploy('ERC20-5', 'ERC20-5');

        //  Deploy and initialize SporesRegistry contract
        //  SporesRegistry contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesRegistry = await ethers.getContractFactory('SporesRegistry', deployer);
        const supportTokens = [erc201.address, erc202.address, erc203.address, erc204.address];
        registry = await upgrades.deployProxy(SporesRegistry, 
            [feeCollector.address, verifier.address, token721.address, token1155.address, supportTokens],
            {initializer: 'init'}
        );
        await registry.deployed();

        //  Deploy and initialize SporesNFTMarket contract
        //  SporesNFTMarket contract is written following non-upgradeability feature
        //  Hence, constructor is defined and being called when deploying SporesNFTMarket contract
        const SporesNFTMarket = await ethers.getContractFactory('SporesNFTMarket', deployer);
        market = await SporesNFTMarket.deploy(registry.address);

        //  Deploy and initialize SporesNFTMinter contract
        //  This is a version that supports both single and batch minting Spores NFT Tokens
        //  SporesNFTMinter contract is also written following non-upgradeability feature
        const SporesNFTMinter = await ethers.getContractFactory('SporesNFTMinter', deployer);
        minter = await SporesNFTMinter.deploy(registry.address);

        //  By default, Minter role of SporesNFT721 and SporesNFT1155 is 'deployer'
        //  So, it should be transferred to an address of SporesNFTMinter contract
        await token721.transferMinter(minter.address);
        await token1155.transferMinter(minter.address);

        //  Add Market and Minter contract into SporesRegistry
        await registry.updateMarket(market.address);
        await registry.updateMinter(minter.address);
    });  
    
    /**************************************************************************************************
                                                Phase 1
    ***************************************************************************************************/
    
    
    /************************************** Native Coin - NFT721 **************************************/

    it('Should succeed purchase NFT721 with native coin', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minter.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(0);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
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
        expect(event.args._seller).deep.equal(seller.address);
        expect(event.args._paymentReceiver).deep.equal(seller.address);
        expect(event.args._contractNFT).deep.equal(token721.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(0);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balanceOfSellerBefore.add(BigNumber.from(payToSeller))).deep.equal(balanceOfSellerAfter);
    });

    //  'Price' - param and signed by Verifier - are matched
    //  but msg.value is insufficient
    it('Should revert when purchase NFT721 with invalid Price - Invalid msg.value', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210002;
        const uri = 'https://test.metadata/7210002';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minter.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
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

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    //  'Price' - param and signed by Verifier - are NOT matched
    it('Should revert when purchase NFT721 with invalid Price', async() => {
        const tokenId = 7210002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidPrice = 900000;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
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

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when purchase NFT721 with invalid token721 contract', async() => {
        const tokenId = 7210002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, invalidToken721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: NFT721 Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = 7210002;
        const invalidTokenId = 7211000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        await expect(
            token721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
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
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        await expect(
            token721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210003;
        const uri = 'https://test.metadata/7210003';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        const mintTx = await minter.connect(anotherSeller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.balanceOf(anotherSeller.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(anotherSeller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
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

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.balanceOf(anotherSeller.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
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

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(1);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = 7210002;

        //  Prepare input data, and send a minting request
        const tokenId2 = 7210004;
        const uri = 'https://test.metadata/7210004';
        const signature1 = await verifySignature(verifier, seller.address, tokenId2, uri, ERC721);
        const mintTx = await minter.connect(seller).mintSporesERC721(tokenId2, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(2);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId2)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId1,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
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

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(2);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId2)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when token721 - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210002;
        const opcode = 721;

        //  Register invalidToken721 contract
        await registry.registerNFTContract(invalidToken721.address, opcode, false);

        //  Prepare input data, and send a minting request
        const mintTx = await invalidToken721.mint(seller.address, tokenId);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await invalidToken721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(2);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, invalidToken721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(2);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(2);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
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

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(2);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = 7210002;

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, false);
   
        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(2);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
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

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(2);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    /************************************** ERC20 - NFT721 **************************************/

    it('Should succeed purchase NFT721 with ERC-20', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210010;
        const uri = 'https://test.metadata/7210010';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minter.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Mint ERC-201 to Buyer
        const erc201Amt = 1000000000000;
        await erc201.mint(buyer.address, erc201Amt);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc201.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc201.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc201.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc201Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 100000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            erc201.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc201.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await market.connect(buyer).buyNFT721ERC20(info, signature2);
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(seller.address);
        expect(event.args._paymentReceiver).deep.equal(seller.address);
        expect(event.args._contractNFT).deep.equal(token721.address);
        expect(event.args._paymentToken).deep.equal(erc201.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_721);

        //  Check balance of Seller, Buyer after purchase
        const balanceOfBuyerAfter = await erc201.balanceOf(buyer.address);
        const balanceOfSellerAfter = await erc201.balanceOf(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(2);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balanceOfSellerBefore.add(BigNumber.from(payToSeller))).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore.sub(BigNumber.from(price))).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid payment', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210011;
        const uri = 'https://test.metadata/7210011';
        const signature1 = await verifySignature(verifier, seller.address, tokenId, uri, ERC721);
        const mintTx = await minter.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Mint ERC-202 to Buyer
        const erc202Amt = 1000000000000;
        await erc202.mint(buyer.address, erc202Amt);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc202.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc202.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc202Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc205.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid ERC-20 payment token
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: Invalid payment');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc202.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid token721 contract', async() => {
        const tokenId = 7210011;
        const opcode = 721;
        const erc202Amt = 1000000000000;

        //  Unregister invalidToken721 contract
        await registry.unregisterNFTContract(invalidToken721.address, opcode);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc202.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc202.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc202Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, invalidToken721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: NFT721 Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc202.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = 7210011;
        const invalidTokenId = 7211000;
        const erc202Amt = 1000000000000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc202.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc202.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc202Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        await expect(
            token721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc202.address,
            invalidTokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc202.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        await expect(
            token721.ownerOf(invalidTokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when purchase NFT721 with invalid tokenId - Seller Not Owned', async() => {
        //  Prepare input data, and send a minting request
        const erc202Amt = 1000000000000;
        const tokenId = 7210012;
        const uri = 'https://test.metadata/7210012';
        const signature1 = await verifySignature(verifier, anotherSeller.address, tokenId, uri, ERC721);
        const mintTx = await minter.connect(anotherSeller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc202.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc202.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc202Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.balanceOf(anotherSeller.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(anotherSeller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId - Seller not owned
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesNFTMarket: Seller is not owner');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc202.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.balanceOf(anotherSeller.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(anotherSeller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when Seller - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210011;
        const erc202Amt = 1000000000000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc202.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc202.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc202Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, anotherSeller.address, anotherSeller.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid Seller
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc202.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(3);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = 7210011;
        const erc202Amt = 1000000000000;

        //  Prepare input data, and send a minting request
        const tokenId2 = 7210013;
        const uri = 'https://test.metadata/7210013';
        const signature1 = await verifySignature(verifier, seller.address, tokenId2, uri, ERC721);
        const mintTx = await minter.connect(seller).mintSporesERC721(tokenId2, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
       await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc202.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc202.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc202Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(4);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId2)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId1,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc202.address,
            tokenId2, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc202.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(4);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId2)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when token721 - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210011;
        const erc202Amt = 1000000000000;
        const opcode = 721;

        //  Register invalidToken721 contract
        await registry.registerNFTContract(invalidToken721.address, opcode, false);

        //  Prepare input data, and send a minting request
        const mintTx = await invalidToken721.mint(seller.address, tokenId);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await invalidToken721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc202.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc202.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc202Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(4);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, invalidToken721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with invalid token721 contract
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc202.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(4);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = 7210011;
        const erc202Amt = 1000000000000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc202.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc202.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc202Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(4);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc202.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(4);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = 7210011;
        const erc202Amt = 1000000000000;

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, false);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc202.connect(buyer).approve(market.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc202.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc202.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc202Amt);
        expect(await token721.balanceOf(seller.address)).deep.equal(4);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            erc202.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, erc202.address,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('ERC721: transfer caller is not owner nor approved');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc202.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc202.balanceOf(buyer.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(4);
        expect(await token721.balanceOf(buyer.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });


    /**************************************************************************************************
                                                Phase 2
    ***************************************************************************************************/

    //  A scenario: SporesRegistry is upgraded. Instead of using one Verifier only
    //  Now, it has a mapping of authorized Verifier
    //  SporesNFTMarket and SporesNFTMinter are also required to be updated.
    //  These two contract are not upgradeable contract, so they must be abandonned and re-deploy new ones
    //  SporesNFTMarket (support Buy/Sell NFT721) -> SporesNFTMarketUpgradeTest (support both NFT721-NFT1155)
    it('Should succeed upgrade SporesRegistry', async () => {
        const SporesRegistry_v2 = await ethers.getContractFactory("SporesRegistryUpgradeTest", deployer);
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

        //  Re-deploy SporesNFTMarket and SporesNFTMinter
        const SporesNFTMarket = await ethers.getContractFactory('SporesNFTMarketUpgradeTest', deployer);
        newMarket = await SporesNFTMarket.deploy(registry.address);
        const SporesNFTMinter = await ethers.getContractFactory('SporesNFTMinterUpgradeTest', deployer);
        newMinter = await SporesNFTMinter.deploy(registry.address);

        //  Call SporesNFT721 and SporesNFT1155 to link Minter role to a new address
        await token721.transferMinter(newMinter.address);
        await token1155.transferMinter(newMinter.address);

        //  Update newMarket and newMiner into SporesRegistry
        await registry.updateMinter(newMinter.address);
        await registry.updateMarket(newMarket.address);

        //  It should not allow minter to mint NFT721 and NFT1155
        //  And it also should not allow market to trade any NFT721 items
        const tokenId1 = 7211111;
        const feeRate = 1000;
        const sellId = 18002080;
        const price = 1000000;
        const uri1 = 'https://test.metadata/7211111';
        const signature1 = await verifySignature(verifier2, seller.address, tokenId1, uri1, ERC721);
        await expect(
            minter.connect(seller).mintSporesERC721(tokenId1, uri1, signature1)
        ).to.be.revertedWith('SporesRegistry: Unauthorized');

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc201.connect(buyer).approve(market.address, 1000000000000000);

        const tokenId721 = 7210011;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token721.address, tokenId721,
            erc201.address, feeRate, price, SINGLE_UNIT, sellId, ERC_20_NFT_721
        );

        const info1 = [
            seller.address, seller.address, token721.address, erc201.address,
            tokenId721, feeRate, price, SINGLE_UNIT, sellId
        ];
        await expect(
            market.connect(buyer).buyNFT721ERC20(
                info1, signature2
            )
        ).to.be.revertedWith('SporesRegistry: Unauthorized');

        const signature3 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token721.address, tokenId721,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info2 = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
            tokenId721, feeRate, price, SINGLE_UNIT, sellId
        ];
        await expect(
            market.connect(buyer).buyNFT721NativeCoin(
                info2, signature3,
                {
                    value: price
                }
            )
        ).to.be.revertedWith('SporesRegistry: Unauthorized');

        const tokenId2 = 1155111;
        const amount = 1111;
        const uri2 = 'https://test.metadata/1155111';
        const signature4 = await verifySignature(verifier, seller.address, tokenId2, uri2, ERC1155);
        await expect(
            minter.connect(seller).mintSporesERC1155(tokenId2, amount, uri2, signature4)
        ).to.be.revertedWith('SporesRegistry: Unauthorized');
    });

    it('Should succeed purchase NFT721 (minted before upgrading) with native coin', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7210002;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(market.address, false);
        await token721.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        const tokenBalanceOfSellerBefore = await token721.balanceOf(seller.address);
        const tokenBalanceOfBuyerBefore = await token721.balanceOf(buyer.address);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await newMarket.connect(buyer).buyNFT721NativeCoin(
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
        expect(event.args._contractNFT).deep.equal(token721.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(tokenBalanceOfSellerBefore.sub(1));
        expect(await token721.balanceOf(buyer.address)).deep.equal(tokenBalanceOfBuyerBefore.add(1));
        expect(await token721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balanceOfSellerBefore.add(BigNumber.from(payToSeller))).deep.equal(balanceOfSellerAfter);
    });

    it('Should succeed purchase newly minted NFT721 with native coin', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7211000;
        const uri = 'https://test.metadata/7211000';
        const signature1 = await verifySignature(verifier2, seller.address, tokenId, uri, ERC721);
        const mintTx = await newMinter.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        const tokenBalanceOfSellerBefore = await token721.balanceOf(seller.address);
        const tokenBalanceOfBuyerBefore = await token721.balanceOf(buyer.address);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).sub(BigNumber.from(price).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase
        const tx = await newMarket.connect(buyer).buyNFT721NativeCoin(
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
        expect(event.args._contractNFT).deep.equal(token721.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(SINGLE_UNIT);
        expect(event.args._fee).deep.equal(BigNumber.from(price).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_721);

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(tokenBalanceOfSellerBefore.sub(1));
        expect(await token721.balanceOf(buyer.address)).deep.equal(tokenBalanceOfBuyerBefore.add(1));
        expect(await token721.ownerOf(tokenId)).deep.equal(buyer.address);
        expect(balanceOfSellerBefore.add(BigNumber.from(payToSeller))).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when a signature is provided by old verifier - NFT721 with Native Coin', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 7211002;
        const uri = 'https://test.metadata/7211002';
        const signature1 = await verifySignature(verifier2, seller.address, tokenId, uri, ERC721);
        const mintTx = await newMinter.connect(seller).mintSporesERC721(tokenId, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT721 item
        await token721.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        const tokenBalanceOfSellerBefore = await token721.balanceOf(seller.address);
        const tokenBalanceOfBuyerBefore = await token721.balanceOf(buyer.address);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);

        //  Prepare a signature of Verifier to purchase NFT721
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token721.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, SINGLE_UNIT, sellId, NATIVE_COIN_NFT_721
        );

        const info = [
            seller.address, seller.address, token721.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, SINGLE_UNIT, sellId
        ];
        //  Buyer makes a purchase with a signature from old Verifier
        await expect(
            newMarket.connect(buyer).buyNFT721NativeCoin(
                info, signature2,
                {
                    value: price
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token721.balanceOf(seller.address)).deep.equal(tokenBalanceOfSellerBefore);
        expect(await token721.balanceOf(buyer.address)).deep.equal(tokenBalanceOfBuyerBefore);
        expect(await token721.ownerOf(tokenId)).deep.equal(seller.address);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    /************************************** Native Coin - NFT1155 **************************************/

    it('Should succeed purchase NFT1155 with native coin', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 1155001;
        const uri = 'https://test.metadata/1155001';
        const amount = 1101;
        const signature1 = await verifySignature(verifier2, seller.address, tokenId, uri, ERC1155);
        const mintTx = await newMinter.connect(seller).mintSporesERC1155(tokenId, amount, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const payToSeller = BigNumber.from(price).mul(purchaseAmt).sub(BigNumber.from(price).mul(purchaseAmt).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase
        const tx = await newMarket.connect(buyer).buyNFT1155NativeCoin(
            info, signature2,
            {
                value: BigNumber.from(price).mul(purchaseAmt)
            }
        );
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(seller.address);
        expect(event.args._paymentReceiver).deep.equal(seller.address);
        expect(event.args._contractNFT).deep.equal(token1155.address);
        expect(event.args._paymentToken).deep.equal(ethers.constants.AddressZero);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(purchaseAmt);
        expect(event.args._fee).deep.equal(BigNumber.from(price).mul(purchaseAmt).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(NATIVE_COIN_NFT_1155);

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount - purchaseAmt);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(purchaseAmt);
        expect(balanceOfSellerBefore.add(BigNumber.from(payToSeller))).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when a signature is provided by old verifier - NFT1155 with Native Coin', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 1155101;
        const uri = 'https://test.metadata/1155101';
        const amount = 1101;
        const signature1 = await verifySignature(verifier3, seller.address, tokenId, uri, ERC1155);
        const mintTx = await newMinter.connect(seller).mintSporesERC1155(tokenId, amount, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        const tokenBalanceOfSellerBefore = await token1155.balanceOf(seller.address, tokenId);
        const tokenBalanceOfBuyerBefore = await token1155.balanceOf(buyer.address, tokenId);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with a signature from old Verifier
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2,
                {
                    value: BigNumber.from(price).mul(purchaseAmt)
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(tokenBalanceOfSellerBefore);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(tokenBalanceOfBuyerBefore);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    }); 

    //  'Price' - param and signed by Verifier - are matched
    //  but msg.value is insufficient
    it('Should revert when purchase NFT1155 with invalid amount - Invalid msg.value', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 1155002;
        const uri = 'https://test.metadata/1155002';
        const amount = 1102;
        const signature1 = await verifySignature(verifier3, seller.address, tokenId, uri, ERC1155);
        const mintTx = await newMinter.connect(seller).mintSporesERC1155(tokenId, amount, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid msg.value
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2, 
                {
                    value: BigNumber.from(price).mul(purchaseAmt - 1)
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: Insufficient payment');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    //  'Price' - param and signed by Verifier - are NOT matched
    it('Should revert when purchase NFT1155 with invalid amount - Invalid Price', async() => {
        const tokenId = 1155002;
        const amount = 1102;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const invalidPrice = 900000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, invalidPrice, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid Price
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2, 
                {
                    value: BigNumber.from(invalidPrice).mul(purchaseAmt)
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when purchase NFT1155 with invalid token1155 contract', async() => {
        const tokenId = 1155002;
        const amount = 1102;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, invalidToken1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid token1155 contract
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2,
                {
                    value: BigNumber.from(price).mul(purchaseAmt)
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: NFT1155 Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when purchase NFT1155 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = 1155002;
        const amount = 1102;
        const invalidTokenId = 1155100;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(await token1155.balanceOf(seller.address, invalidTokenId)).deep.equal(0);
        expect(await token1155.balanceOf(buyer.address, invalidTokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            invalidTokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2,
                {
                    value: BigNumber.from(price).mul(purchaseAmt)
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: Invalid purchase amount');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(await token1155.balanceOf(seller.address, invalidTokenId)).deep.equal(0);
        expect(await token1155.balanceOf(buyer.address, invalidTokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    //  This case suppose to be detectd by Verifier
    //  Assuming Verifier miss the case, so the contract must handle properly
    it('Should revert when purchase NFT1155 with invalid amount - Amount exceed', async() => {
        const tokenId = 1155002;
        const amount = 1102;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 1103;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid amount - Amount exceed
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2,
                {
                    value: BigNumber.from(price).mul(purchaseAmt)
                }
            )    
        ).to.be.revertedWith('SporesNFTMarket: Invalid purchase amount');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when purchase amount - param and signed by Verifier - not matched', async() => {
        const tokenId = 1155002;
        const amount = 1102;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const invalidPurchaseAmt = 20;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, invalidPurchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid amount
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2,
                {
                    value: BigNumber.from(price).mul(invalidPurchaseAmt)
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    //  TODO
    it(`TODO - Should revert when Seller - param and signed by Verifier - not matched`, async() => {});

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = 1155002;
        const tokenId2 = 1155003;
        const amount = 1103;
        const uri = 'https://test.metadata/1155003';
        const signature1 = await verifySignature(verifier2, seller.address, tokenId2, uri, ERC1155);
        const mintTx = await newMinter.connect(seller).mintSporesERC1155(tokenId2, amount, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId1)).deep.equal(1102);
        expect(await token1155.balanceOf(seller.address, tokenId2)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(buyer.address, tokenId2)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId1,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId2, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2,
                {
                    value: BigNumber.from(price).mul(purchaseAmt)
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId1)).deep.equal(1102);
        expect(await token1155.balanceOf(seller.address, tokenId2)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(buyer.address, tokenId2)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when token1155 - param and signed by Verifier - not matched', async() => {
        const tokenId = 1155002;
        const amount = 1102;
        const opcode = 1155;

        //  Register invalidToken1155 contract
        await registry.registerNFTContract(invalidToken1155.address, opcode, false);

        //  Prepare input data, and send a minting request
        const mintTx = await invalidToken1155.mint(seller.address, tokenId, amount);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await invalidToken1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, invalidToken1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid token1155 contract
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2,
                {
                    value: BigNumber.from(price).mul(purchaseAmt)
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = 1155002;
        const amount = 1102;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, purchaseAmt,invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellID
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2,
                {
                    value: BigNumber.from(price).mul(purchaseAmt)
                }
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = 1155002;
        const amount = 1102;

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, false);
   
        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId,
            ethers.constants.AddressZero, feeRate, price, purchaseAmt, sellId, NATIVE_COIN_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, ethers.constants.AddressZero,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            newMarket.connect(buyer).buyNFT1155NativeCoin(
                info, signature2,
                {
                    value: BigNumber.from(price).mul(purchaseAmt)
                }
            )    
        ).to.be.revertedWith('ERC1155: caller is not owner nor approved');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await provider.getBalance(seller.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
    });

    /************************************** ERC20 - NFT1155 **************************************/

    it('Should succeed purchase NFT1155 with ERC20', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 1155011;
        const uri = 'https://test.metadata/1155011';
        const amount = 1111;
        const signature1 = await verifySignature(verifier2, seller.address, tokenId, uri, ERC1155);
        const mintTx = await newMinter.connect(seller).mintSporesERC1155(tokenId, amount, uri, signature1);
        await mintTx.wait();

        //  Mint ERC-203 to Buyer
        const erc203Amt = 1000000000000;
        await erc203.mint(buyer.address, erc203Amt);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc203.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc203.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc203.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc203Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const purchaseAmt = 10;
        const sellId = 18002080;
        const payToSeller = BigNumber.from(price).mul(purchaseAmt).sub(BigNumber.from(price).mul(purchaseAmt).div(1000));
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId,
            erc203.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc203.address,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase
        const tx = await newMarket.connect(buyer).buyNFT1155ERC20(info, signature2);
        const receipt = await tx.wait();
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMarketTransaction' });

        expect(event != undefined).true;
        expect(event.args._buyer).deep.equal(buyer.address);
        expect(event.args._seller).deep.equal(seller.address);
        expect(event.args._paymentReceiver).deep.equal(seller.address);
        expect(event.args._contractNFT).deep.equal(token1155.address);
        expect(event.args._paymentToken).deep.equal(erc203.address);
        expect(event.args._tokenId).deep.equal(tokenId);
        expect(event.args._price).deep.equal(price);
        expect(event.args._amount).deep.equal(purchaseAmt);
        expect(event.args._fee).deep.equal(BigNumber.from(price).mul(purchaseAmt).div(1000));
        expect(event.args._saleId).deep.equal(sellId);
        expect(event.args._tradeType).deep.equal(ERC_20_NFT_1155);

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc203.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc203.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount - purchaseAmt);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(purchaseAmt);
        expect(balanceOfSellerAfter).deep.equal(balanceOfSellerBefore.add(payToSeller));
        expect(balanceOfBuyerAfter).deep.equal(balanceOfBuyerBefore.sub(BigNumber.from(price).mul(purchaseAmt)));
    });

    it('Should revert when a signature is given by old verifier - NFT1155 with ERC20', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 1155016;
        const uri = 'https://test.metadata/1155016';
        const amount = 1116;
        const signature1 = await verifySignature(verifier2, seller.address, tokenId, uri, ERC1155);
        const mintTx = await newMinter.connect(seller).mintSporesERC1155(tokenId, amount, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc203.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc203.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc203.balanceOf(buyer.address);
        const tokenBalanceOfSellerBefore = await token1155.balanceOf(seller.address, tokenId);
        const tokenBalanceOfBuyerBefore = await token1155.balanceOf(buyer.address, tokenId);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier, seller.address, seller.address, token1155.address, tokenId,
            erc203.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc203.address,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with a signature from old Verifier
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc203.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc203.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(tokenBalanceOfSellerBefore);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(tokenBalanceOfBuyerBefore);
        expect(balanceOfSellerAfter).deep.equal(balanceOfSellerBefore);
        expect(balanceOfBuyerAfter).deep.equal(balanceOfBuyerBefore);
    });

    it('Should revert when purchase NFT1155 with invalid payment token', async() => {
        //  Prepare input data, and send a minting request
        const tokenId = 1155012;
        const uri = 'https://test.metadata/1155012';
        const amount = 1112;
        const signature1 = await verifySignature(verifier2, seller.address, tokenId, uri, ERC1155);
        const mintTx = await newMinter.connect(seller).mintSporesERC1155(tokenId, amount, uri, signature1);
        await mintTx.wait();

        //  Mint ERC-203 to Buyer
        const erc204Amt = 1000000000000;
        await erc204.mint(buyer.address, erc204Amt);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc204.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc205.address,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid msg.value
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(info, signature2)    
        ).to.be.revertedWith('SporesNFTMarket: Invalid payment');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when purchase NFT1155 with invalid Price', async() => {
        const tokenId = 1155012;
        const amount = 1112;
        const erc204Amt = 1000000000000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc204.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const invalidPrice = 900000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc204.address,
            tokenId, feeRate, invalidPrice, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid Price
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when purchase NFT1155 with invalid token1155 contract', async() => {
        const tokenId = 1155012;
        const amount = 1112;
        const erc204Amt = 1000000000000;
        const opcode = 1155;

        //  Unregister invalidToken1155 contract
        await registry.unregisterNFTContract(invalidToken1155.address, opcode);

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc204.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, invalidToken1155.address, erc204.address,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid token1155 contract
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(info, signature2)    
        ).to.be.revertedWith('SporesNFTMarket: NFT1155 Contract not supported');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when purchase NFT1155 with invalid tokenId - TokenId not existed', async() => {
        const tokenId = 1155012;
        const amount = 1112;
        const erc204Amt = 1000000000000;
        const invalidTokenId = 1155100;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc204.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(await token1155.balanceOf(seller.address, invalidTokenId)).deep.equal(0);
        expect(await token1155.balanceOf(buyer.address, invalidTokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc204.address,
            invalidTokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(info, signature2)    
        ).to.be.revertedWith('SporesNFTMarket: Invalid purchase amount');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(await token1155.balanceOf(seller.address, invalidTokenId)).deep.equal(0);
        expect(await token1155.balanceOf(buyer.address, invalidTokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    //  This case suppose to be detectd by Verifier
    //  Assuming Verifier miss the case, so the contract must handle properly
    it('Should revert when purchase NFT1155 with invalid amount - Amount exceed', async() => {
        const tokenId = 1155012;
        const amount = 1112;
        const erc204Amt = 1000000000000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc204.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 1113;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc204.address,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid amount - Amount exceed
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(info, signature2)    
        ).to.be.revertedWith('SporesNFTMarket: Invalid purchase amount');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when purchase amount - param and signed by Verifier - not matched', async() => {
        const tokenId = 1155012;
        const amount = 1112;
        const erc204Amt = 1000000000000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc204.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const invalidPurchaseAmt = 20;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc204.address,
            tokenId, feeRate, price, invalidPurchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid amount
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(info, signature2)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    //  TODO
    it(`TODO - Should revert when Seller - param and signed by Verifier - not matched`, async() => {});

    it('Should revert when tokenId - param and signed by Verifier - not matched', async() => {
        const tokenId1 = 1155012;
        const tokenId2 = 1155013;
        const amount = 1113;
        const erc204Amt = 1000000000000;
        const uri = 'https://test.metadata/1155013';
        const signature1 = await verifySignature(verifier3, seller.address, tokenId2, uri, ERC1155);
        const mintTx = await newMinter.connect(seller).mintSporesERC1155(tokenId2, amount, uri, signature1);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc204.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId1)).deep.equal(1112);
        expect(await token1155.balanceOf(seller.address, tokenId2)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(buyer.address, tokenId2)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId1,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc204.address,
            tokenId2, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid tokenId
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(info, signature2)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId1)).deep.equal(1112);
        expect(await token1155.balanceOf(seller.address, tokenId2)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(buyer.address, tokenId2)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when token1155 - param and signed by Verifier - not matched', async() => {
        const tokenId = 1155012;
        const amount = 1112;
        const erc204Amt = 1000000000000;
        const opcode = 1155;

        //  Register invalidToken1155 contract
        await registry.registerNFTContract(invalidToken1155.address, opcode, false);

        //  Prepare input data, and send a minting request
        const mintTx = await invalidToken1155.mint(seller.address, tokenId, amount);
        await mintTx.wait();

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc204.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, invalidToken1155.address, tokenId,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc204.address,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase with invalid token1155 contract
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(info, signature2)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when sellId - param and signed by Verifier - not matched', async() => {
        const tokenId = 1155012;
        const amount = 1112;
        const erc204Amt = 1000000000000;

        //  Seller setApproveForAll to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, true);

        //  Buyer setApproveForAll to allow SporesNFTMarket transfer ERC20
        await erc204.connect(buyer).approve(newMarket.address, 1000000000000000);

        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const invalidSellId = 18004080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier2, seller.address, seller.address, token1155.address, tokenId,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc204.address,
            tokenId, feeRate, price, purchaseAmt, invalidSellId
        ];
        //  Buyer makes a purchase with invalid sellId
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(info, signature2)    
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });

    it('Should revert when Seller has not yet setApprovalForAll', async() => {
        const tokenId = 1155012;
        const amount = 1112;
        const erc204Amt = 1000000000000;

        //  Seller disable 'setApproveForAll' to allow SporesNFTMarket transfer NFT1155 item
        await token1155.connect(seller).setApprovalForAll(newMarket.address, false);
   
        //  Check balance of Seller, Buyer before purchase
        const balanceOfSellerBefore = await erc204.balanceOf(seller.address);
        const balanceOfBuyerBefore = await erc204.balanceOf(buyer.address);
        expect(balanceOfSellerBefore).deep.equal(0);
        expect(balanceOfBuyerBefore).deep.equal(erc204Amt);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);

        //  Prepare a signature of Verifier to purchase NFT1155
        const price = 1000000;
        const feeRate = 1000;
        const sellId = 18002080;
        const purchaseAmt = 10;
        const signature2 = await verifyPurchaseSignature(
            verifier3, seller.address, seller.address, token1155.address, tokenId,
            erc204.address, feeRate, price, purchaseAmt, sellId, ERC_20_NFT_1155
        );

        const info = [
            seller.address, seller.address, token1155.address, erc204.address,
            tokenId, feeRate, price, purchaseAmt, sellId
        ];
        //  Buyer makes a purchase when Seller has not yet setApprovalForAll
        await expect(
            newMarket.connect(buyer).buyNFT1155ERC20(
                info, signature2
            )    
        ).to.be.revertedWith('ERC1155: caller is not owner nor approved');

        //  Check balance of Seller, Buyer after purchase
        const balanceOfSellerAfter = await erc204.balanceOf(seller.address);
        const balanceOfBuyerAfter = await erc204.balanceOf(buyer.address);
        expect(await token1155.balanceOf(seller.address, tokenId)).deep.equal(amount);
        expect(await token1155.balanceOf(buyer.address, tokenId)).deep.equal(0);
        expect(balanceOfSellerBefore).deep.equal(balanceOfSellerAfter);
        expect(balanceOfBuyerBefore).deep.equal(balanceOfBuyerAfter);
    });
});    