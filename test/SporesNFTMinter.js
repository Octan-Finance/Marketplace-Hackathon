const { BigNumber } = require('@ethersproject/bignumber');
const chai = require('chai');
const chaiAsPromise = require('chai-as-promised');
const { ethers, upgrades } = require('hardhat');

chai.use(chaiAsPromise);
const expect = chai.expect;

const ERC721_MINT = 0;
const ERC1155_MINT = 1;

function encodeURIs(...uris) {
    return ethers.utils.solidityPack([...Array(uris.length).fill('string')], [...uris]);
}

function verifySignature(verifier, toAddress, tokenId, uri, type) {
    let message = ethers.utils.solidityKeccak256(['address', 'uint256', 'string', 'uint256'], [toAddress, tokenId, uri, type]);

    return verifier.signMessage(ethers.utils.arrayify(message));
}

function verifySignatureBatch(verifier, toAddress, encodeURIs, type, ...tokenIds) {
    let message = ethers.utils.solidityKeccak256(['address', ...Array(tokenIds.length).fill("uint256"), 'bytes', 'uint256'],
        [toAddress, ...tokenIds, encodeURIs, type]);

    return verifier.signMessage(ethers.utils.arrayify(message));
}

/* 
- Attention: There are a couple of contracts implementing a feature of upgradeability
  + SporesNFT721 and SporesNFT1155: upgradeable smart contracts using upgradeable libraries from Openzeppelin
  + SporesNFTMinter: non-upgradeable smart contract. As of now, there are two versions of SporesNFTMinter:
    * SporesNFTMinter: a version of Minter contract that supports only minting a single NFT Token per request
    * SporesNFTMinterBatch: a version of Minter contract that supports a single and batch minting

- The following test scenarios will be split into below cases:
  + SporesNFTMinter contract interacts with SporesNFT721 and SporesNFT1155 (with non-upgradeable).
  In this category, there are two subcases also being tested
    * SporesNFTMinter (non-batch minting version) will be set as Minter role of SporesNFT721 and SporesNFT1155
    * SporesNFTMinter will be abandoned and replaced by SporesNFTMinterBatch. Then, SporesNFT721 and SporesNFT1155 transfer Minter role
      to SporesNFTMinterBatch
  + SporesNFTMinter contract interacts with SporesNFT721 and SporesNFT1155 (with upgradeable)
    * SporesNFTMinter (non-batch minting version) will be set as Minter role of SporesNFT721 and SporesNFT1155
    * Upgrade SporesNFT721 and SporesNFT1155
    * SporesNFTMinter will be abandonned and replaced by SporesNFTMinterBatch. Then, SporesNFT721 and SporesNFT1155 transfer Minter role
      to SporesNFTMinterBatch
*/

describe('SporesNFTMinter Contract Testing - Without Upgradeability', () => {
    let deployer, owner, verifier, feeCollector, anotherOwner;
    let token721, token1155, minter, minterBatch, registry;
    before(async() => {
        //  Get pre-fund accounts
        [deployer, owner, verifier, feeCollector, anotherOwner] = await ethers.getSigners();

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
        registry = await SporesRegistry.deploy();
        registry.init(
            feeCollector.address, verifier.address, token721.address, token1155.address, supportTokens
        );

        //  Deploy and initialize SporesNFTMinter contract
        //  SporesNFTMinter contract is written following non-upgradeability feature
        //  Hence, constructor is defined and being called when deploying SporesNFTMinter contract
        const SporesNFTMinter = await ethers.getContractFactory('SporesNFTMinter', deployer);
        minter = await SporesNFTMinter.deploy(registry.address);

        //  Deploy and initialize SporesNFTMinterBatch contract
        //  This is a version that supports both single and batch minting Spores NFT Tokens
        //  SporesNFTMinterBatch contract is also written following non-upgradeability feature
        const SporesNFTMinterBatch = await ethers.getContractFactory('SporesNFTMinterBatch', deployer);
        minterBatch = await SporesNFTMinterBatch.deploy(registry.address);

        //  By default, Minter role of SporesNFT721 and SporesNFT1155 is 'deployer'
        //  So, it should be transferred to an address of SporesNFTMinter contract
        await token721.transferMinter(minter.address);
        await token1155.transferMinter(minter.address);

        //  Register Minter contract into SporesRegistry
        await registry.updateMinter(minter.address);
    });

    it('Should succeed minting a new SporesNFT721', async () => {
        //  Prepare input data. TokenID is a new one
        const tokenId = 1344356;
        const uri = 'https://test.metadata/1';
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request
        const mintTx = await minter.connect(owner).mintSporesERC721(tokenId, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated
        //  + Owner of 'tokenId' must be equal to 'owner'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token721.address);
        expect(event.args._amount.eq(1));
        expect(event.args._id.eq(tokenId));

        expect(await token721.tokenURI(tokenId)).deep.equal(uri);
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should revert when minting SporesNFT721 of existed tokenId', async () => {
        //  Preparing input data. TokenID has already existed
        const tokenId = 1344356;
        const uri = 'https://test.metadata/1';
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request of existed TokenID
        await expect(
            minter.connect(anotherOwner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('ERC721: token already minted');

        //  Verify that:
        //  + Balance of 'anotherOwner' remains unchanged
        //  + Owner of 'tokenId' remains unchanged
        expect(await token721.balanceOf(anotherOwner.address)).deep.equal(0);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should succeed minting a new SporesNFT1155', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId = 235321;
        const uri = 'https://test.metadata/1';
        const amount = 23;
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        //  Send a minting request
        const mintTx = await minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated with respect to 'tokenId'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token1155.address);
        expect(event.args._amount.eq(amount));
        expect(event.args._id.eq(tokenId));

        expect(await token1155.uri(tokenId)).deep.equal(uri);
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(23);
    });

    it('Should revert when minting SporesNFT1155 of existed tokenId', async () => {
        //  Prepare input data. TokenID has already existed
        const tokenId = 235321;
        const uri = 'https://test.metadata/1';
        const amount = 23;
        const newUri = 'https://testmetadata/2';
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, newUri, ERC1155_MINT);

        await expect(
            minter.connect(anotherOwner).mintSporesERC1155(tokenId, amount, newUri, signature)
        ).to.be.revertedWith('SporesNFT1155: Token already minted');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        expect(await token1155.balanceOf(anotherOwner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT721 without a signature', async () => {
        // Prepare input data
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 without a signature', async () => {
        // Prepare input data
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT721 with a signature that is generated by an invalid Verifier', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 with a signature that is generated by an invalid Verifier', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT721', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 14;
        const invalidTokenId = 12;
        const uri = 'https://test.metadata/1';
        const signature = verifySignature(verifier, owner.address, invalidTokenId, uri, ERC721_MINT);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT1155', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 14;
        const invalidTokenId = 12;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const signature = verifySignature(verifier, owner.address, invalidTokenId, uri, ERC1155_MINT);
        
        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when requesting ERC721 minting and signed ERC1155 minting - SporesNFT721', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Balance of 'deployer' should be zero
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        expect(await token721.balanceOf(deployer.address)).deep.equal(0);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when requesting ERC1155 minting and signed ERC721 minting - SporesNFT1155', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        //  + Balance of 'deployer' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId)).deep.equal(0);
    });

    it('Should succeed to transfer Minter role to SporesNFTMinterBatch', async () => {
        //  SporesNFTMinterBatch has already deployed, then just transfer Minter role
        //  Assuming, pauser has already been set to pause minting requests
        await token721.transferMinter(minterBatch.address);
        await token1155.transferMinter(minterBatch.address);
        //  Update MinterBatch as Minter in SporesRegistry
        await registry.updateMinter(minterBatch.address);
        
        //  Then, check whether SporesNFTMinter (old Minter role) still be able to mint SporesNFT Tokens
        //  Prepare input data. TokenID has already existed
        //  Preparing input data. TokenID has already existed
        const tokenId721 = 7210123;
        const uri721 = 'https://test.metadata/1';
        const signature721 = await verifySignature(verifier, anotherOwner.address, tokenId721, uri721, ERC721_MINT);
 
        const tokenId1155 = 11550123;
        const uri1155 = 'https://test.metadata/1';
        const amount = 23;
        const signature1155 = await verifySignature(verifier, anotherOwner.address, tokenId1155, uri1155, ERC1155_MINT);

        //  Old Minter sends a minting request
        await expect(
            minter.connect(owner).mintSporesERC721(tokenId721, uri721, signature721)
        ).to.be.revertedWith('SporesRegistry: Unauthorized');
        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId1155, amount, uri1155, signature1155)
        ).to.be.revertedWith('SporesRegistry: Unauthorized');

        //  Verify that:
        //  + NFT721: balance of 'owner' remains unchanged
        //  + NFT1155: balance of 'owner' is zero wrt 'tokenId1155'
        //  + Owner of 'tokenId721' not found
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        expect(await token1155.balanceOf(owner.address, tokenId1155)).deep.equal(0);
        await expect(
            token721.ownerOf(tokenId721)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should succeed minting a new SporesNFT721 - Single Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        const tokenId = 7210123;
        const uri = 'https://test.metadata/7210123';
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request
        const mintTx = await minterBatch.connect(owner).mintSporesERC721(tokenId, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated
        //  + Owner of 'tokenId' must be equal to 'owner'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token721.address);
        expect(event.args._amount.eq(1));
        expect(event.args._id.eq(tokenId));

        expect(await token721.tokenURI(tokenId)).deep.equal(uri);
        expect(await token721.balanceOf(owner.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should revert when minting SporesNFT721 of existed tokenId - Single Minting - New Minter', async () => {
        //  Preparing input data. TokenID has already existed
        const tokenId = 7210123;
        const uri = 'https://test.metadata/7210123';
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request of existed TokenID
        await expect(
            minterBatch.connect(anotherOwner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('ERC721: token already minted');

        //  Verify that:
        //  + Balance of 'anotherOwner' remains unchanged
        //  + Owner of 'tokenId' remains unchanged
        expect(await token721.balanceOf(anotherOwner.address)).deep.equal(0);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should succeed minting a new SporesNFT721 - Batch Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        const tokenId1 = 7210124;
        const uri1 = 'https://test.metadata/7210124';

        const tokenId2 = 7210125;
        const uri2 = 'https://test.metadata/7210125';

        const tokenId3 = 7210126;
        const uri3 = 'https://test.metadata/7210126';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );
        

        //  Send a minting request
        const mintTx = await minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMintBatch' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated
        //  + Owner of 'tokenId' must be equal to 'owner'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMintBatch' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token721.address);
        expect(event.args._amounts[0].eq(1));
        expect(event.args._amounts[1].eq(1));
        expect(event.args._amounts[2].eq(1));
        expect(event.args._ids[0].eq(tokenId1));
        expect(event.args._ids[1].eq(tokenId2));
        expect(event.args._ids[2].eq(tokenId3));

        expect(await token721.tokenURI(tokenId1)).deep.equal(uri1);
        expect(await token721.tokenURI(tokenId2)).deep.equal(uri2);
        expect(await token721.tokenURI(tokenId3)).deep.equal(uri3);
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        expect(await token721.ownerOf(tokenId1)).deep.equal(owner.address);
        expect(await token721.ownerOf(tokenId2)).deep.equal(owner.address);
        expect(await token721.ownerOf(tokenId3)).deep.equal(owner.address);
    });

    it('Should revert when one requesting Token ID is existed - Batch Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        const tokenId1 = 7210127;
        const uri1 = 'https://test.metadata/7210127';

        const tokenId2 = 7210128;
        const uri2 = 'https://test.metadata/7210128';

        // TokenID is an existed one
        const tokenId3 = 7210126;
        const uri3 = 'https://test.metadata/7210126';
        
        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        //  Send a minting request
        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('ERC721: token already minted');

        //  Verify that: 
        //  + Balance of 'owner' remains unchanged
        //  + Owner of existed 'tokenId' remains unchanged
        //  + Owner of non-existed 'tokenId' should be 'not found'
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        expect(await token721.ownerOf(tokenId3)).deep.equal(owner.address);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should succeed minting a new SporesNFT1155 - Single Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId = 11550123;
        const uri = 'https://test.metadata/11550123';
        const amount = 123;
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        //  Send a minting request
        const mintTx = await minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated with respect to 'tokenId'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token1155.address);
        expect(event.args._amount.eq(amount));
        expect(event.args._id.eq(tokenId));

        expect(await token1155.uri(tokenId)).deep.equal(uri);
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(123);
    });

    it('Should revert when minting SporesNFT1155 of existed tokenId - Single Minting - New Minter', async () => {
        //  Prepare input data. TokenID has already existed
        const tokenId = 11550123;
        const uri = 'https://test.metadata/11550123';
        const amount = 123;
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minterBatch.connect(anotherOwner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesNFT1155: Token already minted');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        expect(await token1155.balanceOf(anotherOwner.address, tokenId)).deep.equal(0);
    });

    it('Should succeed minting a new SporesNFT1155 - Batch Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId1 = 11550124;
        const uri1 = 'https://test.metadata/11550124';
        const amount1 = 124;

        const tokenId2 = 11550125;
        const uri2 = 'https://test.metadata/11550125';
        const amount2 = 125;

        const tokenId3 = 11550126;
        const uri3 = 'https://test.metadata/11550126';
        const amount3 = 126;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, tokenId3
        );
        const amounts = [amount1, amount2, amount3];

        //  Send a minting request
        const mintTx = await minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMintBatch' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated with respect to 'tokenId'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMintBatch' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token1155.address);
        expect(event.args._amounts[0].eq(amount1));
        expect(event.args._amounts[1].eq(amount2));
        expect(event.args._amounts[2].eq(amount3));
        expect(event.args._ids[0].eq(tokenId1));
        expect(event.args._ids[1].eq(tokenId2));
        expect(event.args._ids[2].eq(tokenId3));

        expect(await token1155.uri(tokenId1)).deep.equal(uri1);
        expect(await token1155.uri(tokenId2)).deep.equal(uri2);
        expect(await token1155.uri(tokenId3)).deep.equal(uri3);
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(124);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(125);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(126);
    });

    it('Should revert when one of requesting TokenID is existed - Batch Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId1 = 11550127;
        const uri1 = 'https://test.metadata/11550127';
        const amount1 = 127;

        const tokenId2 = 11550128;
        const uri2 = 'https://test.metadata/11550128';
        const amount2 = 128;

        //  TokenID is an existed one
        const tokenId3 = 11550126;
        const uri3 = 'https://test.metadata/11550126';
        const amount3 = 126;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, tokenId3
        );
        const amounts = [amount1, amount2, amount3];

        //  Send a minting request
        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesNFT1155: Token already minted');

        //  Verify that: 
        //  + Balance of 'owner' remains unchanged (existed tokenId)
        //  + Other 'tokenId' should be zero
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(126);
    });

    it('Should revert when minting SporesNFT721 without a signature - Single Minting - New Minter', async () => {
        // Prepare input data
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minterBatch.connect(owner).mintSporesERC721(tokenId, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT721 without a signature - Batch Minting - New Minter', async () => {
        // Prepare input data
        const tokenId1 = 7210001;
        const uri1 = 'https://test.metadata/7210001';

        const tokenId2 = 7210001;
        const uri2 = 'https://test.metadata/7210002';

        const tokenId3 = 7210003;
        const uri3 = 'https://test.metadata/7210003';

        const emptySig = ethers.utils.arrayify(0);
        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenIds' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId3)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 without a signature - Single Minting - New Minter', async () => {
        // Prepare input data
        const tokenId = 1155001;
        const uri = 'https://test.metadata/1155001';
        const amount = 1101;
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT1155 without a signature - Batch Minting - New Minter', async () => {
        // Prepare input data
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3= 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const emptySig = ethers.utils.arrayify(0);
        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const amounts = [amount1, amount2, amount3];

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenIds'
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT721 with a signature that is generated by an invalid Verifier - Single Minting - New Minter', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT721 with a signature that is generated by an invalid Verifier - Batch Minting - New Minter', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId1 = 7210001;
        const uri1 = 'https://test.metadata/7210001';

        const tokenId2 = 7210001;
        const uri2 = 'https://test.metadata/7210002';

        const tokenId3 = 7210003;
        const uri3 = 'https://test.metadata/7210003';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            owner, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenIds' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId3)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 with a signature that is generated by an invalid Verifier - Single Minting - New Minter', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 1155001;
        const uri = 'https://test.metadata/1155001';
        const amount = 1101;
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT1155 with a signature that is generated by an invalid Verifier - Batch Minting - New Minter', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3= 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(owner, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, tokenId3);
        const amounts = [amount1, amount2, amount3];

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenIds'
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(0);
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT721 - Single Minting - New Minter', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const signature = verifySignature(verifier, owner.address, 7210005, uri, ERC721_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT721 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId1 = 7210001;
        const uri1 = 'https://test.metadata/7210001';

        const tokenId2 = 7210001;
        const uri2 = 'https://test.metadata/7210002';

        const tokenId3 = 7210003;
        const uri3 = 'https://test.metadata/7210003';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, 7210005
        );

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId3)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT1155 - Single Minting - New Minter', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 1155001;
        const uri = 'https://test.metadata/1155001';
        const amount = 1101;
        const signature = verifySignature(owner, owner.address, 1155005, uri, ERC1155_MINT);
        
        await expect(
            minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT1155 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3= 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            owner, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, 1155005
        );
        const amounts = [amount1, amount2, amount3];
        
        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenIds'
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(0);
    });

    it('Should revert when requesting ERC721 minting and signed ERC1155 minting - SporesNFT721 - Single Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Balance of 'deployer' should be zero
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        expect(await token721.balanceOf(deployer.address)).deep.equal(0);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when requesting ERC721 minting and signed ERC1155 minting - SporesNFT721 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId1 = 7210001;
        const uri1 = 'https://test.metadata/7210001';

        const tokenId2 = 7210001;
        const uri2 = 'https://test.metadata/7210002';

        const tokenId3 = 7210003;
        const uri3 = 'https://test.metadata/7210003';
        
        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, tokenId3
        );

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Balance of 'deployer' should be zero
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(5);
        expect(await token721.balanceOf(deployer.address)).deep.equal(0);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId3)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when requesting ERC1155 minting and signed ERC721 minting - SporesNFT1155 - Single Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 1155001;
        const uri = 'https://test.metadata/1155001';
        const amount = 1101;
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        //  + Balance of 'deployer' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId)).deep.equal(0);
    });

    it('Should revert when requesting ERC1155 minting and signed ERC721 minting - SporesNFT1155 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3= 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );
        const amounts = [amount1, amount2, amount3];

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        //  + Balance of 'deployer' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId3)).deep.equal(0);
    });

    it('Should revert when function caller and mint to address in signature mismatch - SporesNFT721 - New Minter', async() => {
        const tokenId = 1155002;
        const uri = 'https://test.metadata/1155001';

        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minterBatch.mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier')
    });

    it('Should revert when function caller and mint to address in signature mismatch - SporesNFT1155 - New Minter', async () => {
        const tokenId = 1155002;
        const uri = 'https://test.metadata/1155001';
        const amount = 1244;

        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minterBatch.mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier')
    });

    it('Should revert when function caller and mint to address in signature mismatch - SporesNFT721 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';

        const tokenId3 = 1155003;
        const uri3 = 'https://test.metadata/1155003';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        await expect(
            minterBatch.mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier')
    });

    it('Should revert when function caller and mint to address in signature mismatch - SporesNFT1155 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3 = 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );
        const amounts = [amount1, amount2, amount3];

        await expect(
            minterBatch.mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier')
    });
})

describe('SporesNFTMinter Contract Testing - With Upgradeability', () => {
    let deployer, owner, verifier, feeCollector, anotherOwner;
    let token721, token1155, minter, minterBatch;
    before(async() => {
        //  Get pre-fund accounts
        [deployer, owner, verifier, feeCollector, anotherOwner] = await ethers.getSigners();

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

        //  Deploy and initialize SporesRegistry contract
        //  SporesRegistry contract is written following Contract Upgradeability
        //  Thus, constructor is omitted. Instead, `init()` is replaced
        const SporesRegistry = await ethers.getContractFactory('SporesRegistry', deployer);
        const supportTokens = [];
        registry = await SporesRegistry.deploy();
        registry.init(
            feeCollector.address, verifier.address, token721.address, token1155.address, supportTokens
        );

        //  Deploy and initialize SporesNFTMinter contract
        //  SporesNFTMinter contract is written following non-upgradeability feature
        //  Hence, constructor is defined and being called when deploying SporesNFTMinter contract
        const SporesNFTMinter = await ethers.getContractFactory('SporesNFTMinter', deployer);
        minter = await SporesNFTMinter.deploy(registry.address);

        //  Deploy and initialize SporesNFTMinterBatch contract
        //  This is a version that supports both single and batch minting Spores NFT Tokens
        //  SporesNFTMinterBatch contract is also written following non-upgradeability feature
        const SporesNFTMinterBatch = await ethers.getContractFactory('SporesNFTMinterBatch', deployer);
        minterBatch = await SporesNFTMinterBatch.deploy(registry.address);

        //  By default, Minter role of SporesNFT721 and SporesNFT1155 is 'deployer'
        //  So, it should be transferred to an address of SporesNFTMinter contract
        await token721.transferMinter(minter.address);
        await token1155.transferMinter(minter.address);

        //  Add Minter into SporesRegistry
        await registry.updateMinter(minter.address);
    });

    it('Should succeed minting a new SporesNFT721 - Before Upgrading', async () => {
        //  Prepare input data. TokenID is a new one
        const tokenId = 1344356;
        const uri = 'https://test.metadata/1';
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request
        const mintTx = await minter.connect(owner).mintSporesERC721(tokenId, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated
        //  + Owner of 'tokenId' must be equal to 'owner'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token721.address);
        expect(event.args._amount.eq(1));
        expect(event.args._id.eq(tokenId));

        expect(await token721.tokenURI(tokenId)).deep.equal(uri);
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should revert when minting SporesNFT721 of existed tokenId - Before upgrading', async () => {
        //  Preparing input data. TokenID has already existed
        const tokenId = 1344356;
        const uri = 'https://test.metadata/1';
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request of existed TokenID
        await expect(
            minter.connect(anotherOwner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('ERC721: token already minted');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' remains unchanged
        expect(await token721.balanceOf(anotherOwner.address)).deep.equal(0);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should succeed minting a new SporesNFT1155 - Before upgrading', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId = 235321;
        const uri = 'https://test.metadata/1';
        const amount = 23;
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        //  Send a minting request
        const mintTx = await minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated with respect to 'tokenId'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token1155.address);
        expect(event.args._amount.eq(amount));
        expect(event.args._id.eq(tokenId));

        expect(await token1155.uri(tokenId)).deep.equal(uri);
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(23);
    });

    it('Should revert when minting SporesNFT1155 of existed tokenId - Before uppgrading', async () => {
        //  Prepare input data. TokenID has already existed
        const tokenId = 235321;
        const uri = 'https://test.metadata/1';
        const amount = 23;
        const newUri = 'https://testmetadata/2';
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, newUri, ERC1155_MINT);

        await expect(
            minter.connect(anotherOwner).mintSporesERC1155(tokenId, amount, newUri, signature)
        ).to.be.revertedWith('SporesNFT1155: Token already minted');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        expect(await token1155.balanceOf(anotherOwner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT721 without a signature - Before upgrading', async () => {
        // Prepare input data
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 without a signature - Before upgrading', async () => {
        // Prepare input data
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT721 with a signature that is generated by an invalid Verifier - Before upgrading', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 with a signature that is generated by an invalid Verifier - Before upgrading', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT721 - Before upgrading', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const signature = verifySignature(verifier, owner.address, 12, uri, ERC721_MINT);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT1155 - Before upgrading', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const signature = verifySignature(verifier, owner.address, 12, uri, ERC1155_MINT);
        
        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when a requesting ERC721 minting and a signed ERC1155 minting - SporesNFT721 - Before upgrading', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Balance of 'deployer' should be zero
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        expect(await token721.balanceOf(deployer.address)).deep.equal(0);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a requesting ERC1155 minting and a signed ERC721 minting - SporesNFT1155 - Before upgrading', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        //  + Balance of 'deployer' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId)).deep.equal(0);
    });

    it('Should succeed to upgrading SporesNFT721 and SporesNFT1155', async () => {
        //  Upgrade SporesNFT721
        const SporesNFT721_v2 = await ethers.getContractFactory('SporesNFT721UpgradeableTest', deployer);
        token721 = await upgrades.upgradeProxy(token721.address, SporesNFT721_v2);

        // Upgrade SporesNFT1155
        const SporesNFT1155_v2 = await ethers.getContractFactory('SporesNFT1155UpgradeableTest', deployer);
        token1155 = await upgrades.upgradeProxy(token1155.address, SporesNFT1155_v2);

        //  SporesNFT721 Token
        const tokenId1 = 1344356;
        const uri1 = 'https://test.metadata/1';
        //  SporesNFT1155 Token
        const tokenId2 = 235321;
        const uri2 = 'https://test.metadata/1';
        const amount = 23;

        //  Verify outputs: 
        //  + 'tokenURI' of 'tokenId1' and 'tokenId2' remains unchanged after upgrading
        //  + SporesNFT721: Balance of 'owner' must remain unchanged after upgrading
        //  + SporesNFT721: 'tokenId1' is still owned by 'owner'
        //  + SporesNFT1155: Balance of 'owner' must remain unchanged after upgrading
        expect(await token721.tokenURI(tokenId1)).deep.equal(uri1);
        expect(await token1155.uri(tokenId2)).deep.equal(uri2);
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        expect(await token721.ownerOf(tokenId1)).deep.equal(owner.address);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(amount);
    });

    it('Should revert when minting SporesNFT721 of existed tokenId - After upgrading', async () => {
        //  Preparing input data. TokenID has already existed
        const tokenId = 1344356;
        const uri = 'https://test.metadata/1';
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request of existed TokenID
        await expect(
            minter.connect(anotherOwner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('ERC721: token already minted');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' remains unchanged
        expect(await token721.balanceOf(anotherOwner.address)).deep.equal(0);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should revert when minting SporesNFT1155 of existed tokenId - After uppgrading', async () => {
        //  Prepare input data. TokenID has already existed
        const tokenId = 235321;
        const uri = 'https://test.metadata/1';
        const amount = 23;
        const newUri = 'https://testmetadata/2';
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, newUri, ERC1155_MINT);

        await expect(
            minter.connect(anotherOwner).mintSporesERC1155(tokenId, amount, newUri, signature)
        ).to.be.revertedWith('SporesNFT1155: Token already minted');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        expect(await token1155.balanceOf(anotherOwner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT721 without a signature - After upgrading', async () => {
        // Prepare input data
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 without a signature - After upgrading', async () => {
        // Prepare input data
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT721 with a signature that is generated by an invalid Verifier - After upgrading', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 with a signature that is generated by an invalid Verifier - After upgrading', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 1;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT721 - After upgrading', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const signature = verifySignature(verifier, owner.address, 12, uri, ERC721_MINT);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT1155 - After upgrading', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const signature = verifySignature(verifier, owner.address, 12, uri, ERC1155_MINT);
        
        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when requesting ERC721 minting and signed ERC1155 minting - SporesNFT721 - After upgrading', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minter.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Balance of 'deployer' should be zero
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(1);
        expect(await token721.balanceOf(deployer.address)).deep.equal(0);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when requesting ERC1155 minting and signed ERC721 minting - SporesNFT1155 - After upgrading', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 14;
        const uri = 'https://test.metadata/1';
        const amount = 1;
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        //  + Balance of 'deployer' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId)).deep.equal(0);
    });

    it('Should succeed minting a new SporesNFT721 - After Upgrading', async () => {
        //  Prepare input data. TokenID is a new one
        const tokenId = 3756688;
        const uri = 'https://test.metadata/1';
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request
        const mintTx = await minter.connect(owner).mintSporesERC721(tokenId, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated
        //  + Owner of 'tokenId' must be equal to 'owner'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token721.address);
        expect(event.args._amount.eq(1));
        expect(event.args._id.eq(tokenId));

        expect(await token721.tokenURI(tokenId)).deep.equal(uri);
        expect(await token721.balanceOf(owner.address)).deep.equal(2);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should succeed minting a new SporesNFT1155 - After upgrading', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId = 080588;
        const uri = 'https://test.metadata/1';
        const amount = 100;
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        //  Send a minting request
        const mintTx = await minter.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated with respect to 'tokenId'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token1155.address);
        expect(event.args._amount.eq(amount));
        expect(event.args._id.eq(tokenId));

        expect(await token1155.uri(tokenId)).deep.equal(uri);
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(100);
    });

    it('Should succeed to transfer Minter role to SporesNFTMinterBatch - After upgrading', async () => {
        //  SporesNFTMinterBatch has already deployed, then just transfer Minter role
        //  Assuming, pauser has already been set to pause minting requests
        await token721.transferMinter(minterBatch.address);
        await token1155.transferMinter(minterBatch.address);

        //  Update MinterBatch as new Minter in SporesRegistry
        await registry.updateMinter(minterBatch.address);
        
        //  Then, check whether SporesNFTMinter (old Minter role) still be able to mint SporesNFT Tokens
        //  Prepare input data. TokenID has already existed
        //  Preparing input data. TokenID has already existed
        const tokenId721 = 7210123;
        const uri721 = 'https://test.metadata/1';
        const signature721 = await verifySignature(verifier, anotherOwner.address, tokenId721, uri721, ERC721_MINT);
 
        const tokenId1155 = 11550123;
        const uri1155 = 'https://test.metadata/1';
        const amount = 23;
        const signature1155 = await verifySignature(verifier, anotherOwner.address, tokenId1155, uri1155, ERC1155_MINT);

        //  Old Minter sends a minting request
        await expect(
            minter.connect(owner).mintSporesERC721(tokenId721, uri721, signature721)
        ).to.be.revertedWith('SporesRegistry: Unauthorized');
        await expect(
            minter.connect(owner).mintSporesERC1155(tokenId1155, amount, uri1155, signature1155)
        ).to.be.revertedWith('SporesRegistry: Unauthorized');

        //  Verify that:
        //  + NFT721: balance of 'owner' remains unchanged
        //  + NFT1155: balance of 'owner' is zero wrt 'tokenId1155'
        //  + Owner of 'tokenId721' not found
        expect(await token721.balanceOf(owner.address)).deep.equal(2);
        expect(await token1155.balanceOf(owner.address, tokenId1155)).deep.equal(0);
        await expect(
            token721.ownerOf(tokenId721)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should succeed minting a new SporesNFT721 - Single Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        const tokenId = 7210123;
        const uri = 'https://test.metadata/7210123';
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request
        const mintTx = await minterBatch.connect(owner).mintSporesERC721(tokenId, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated
        //  + Owner of 'tokenId' must be equal to 'owner'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token721.address);
        expect(event.args._amount.eq(1));
        expect(event.args._id.eq(tokenId));

        expect(await token721.tokenURI(tokenId)).deep.equal(uri);
        expect(await token721.balanceOf(owner.address)).deep.equal(3);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should revert when minting SporesNFT721 of existed tokenId - Single Minting - New Minter', async () => {
        //  Preparing input data. TokenID has already existed
        const tokenId = 7210123;
        const uri = 'https://test.metadata/7210123';
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, uri, ERC721_MINT);

        //  Send a minting request of existed TokenID
        await expect(
            minterBatch.connect(anotherOwner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('ERC721: token already minted');

        //  Verify that:
        //  + Balance of 'anotherOwner' remains unchanged
        //  + Owner of 'tokenId' remains unchanged
        expect(await token721.balanceOf(anotherOwner.address)).deep.equal(0);
        expect(await token721.ownerOf(tokenId)).deep.equal(owner.address);
    });

    it('Should succeed minting a new SporesNFT721 - Batch Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        const tokenId1 = 7210124;
        const uri1 = 'https://test.metadata/7210124';

        const tokenId2 = 7210125;
        const uri2 = 'https://test.metadata/7210125';

        const tokenId3 = 7210126;
        const uri3 = 'https://test.metadata/7210126';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        //  Send a minting request
        const mintTx = await minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMintBatch' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated
        //  + Owner of 'tokenId' must be equal to 'owner'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMintBatch' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token721.address);
        expect(event.args._amounts[0].eq(1));
        expect(event.args._amounts[1].eq(1));
        expect(event.args._amounts[2].eq(1));
        expect(event.args._ids[0].eq(tokenId1));
        expect(event.args._ids[1].eq(tokenId2));
        expect(event.args._ids[2].eq(tokenId3));

        expect(await token721.tokenURI(tokenId1)).deep.equal(uri1);
        expect(await token721.tokenURI(tokenId2)).deep.equal(uri2);
        expect(await token721.tokenURI(tokenId3)).deep.equal(uri3);
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        expect(await token721.ownerOf(tokenId1)).deep.equal(owner.address);
        expect(await token721.ownerOf(tokenId2)).deep.equal(owner.address);
        expect(await token721.ownerOf(tokenId3)).deep.equal(owner.address);
    });

    it('Should revert when one requesting Token ID is existed - Batch Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        const tokenId1 = 7210127;
        const uri1 = 'https://test.metadata/7210127';

        const tokenId2 = 7210128;
        const uri2 = 'https://test.metadata/7210128';

        // TokenID is an existed one
        const tokenId3 = 7210126;
        const uri3 = 'https://test.metadata/7210126';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        //  Send a minting request
        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('ERC721: token already minted');

        //  Verify that: 
        //  + Balance of 'owner' remains unchanged
        //  + Owner of existed 'tokenId' remains unchanged
        //  + Owner of non-existed 'tokenId' should be 'not found'
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        expect(await token721.ownerOf(tokenId3)).deep.equal(owner.address);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should succeed minting a new SporesNFT1155 - Single Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId = 11550123;
        const uri = 'https://test.metadata/11550123';
        const amount = 123;
        const signature = await verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        //  Send a minting request
        const mintTx = await minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMint' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated with respect to 'tokenId'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMint' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token1155.address);
        expect(event.args._amount.eq(amount));
        expect(event.args._id.eq(tokenId));

        expect(await token1155.uri(tokenId)).deep.equal(uri);
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(123);
    });

    it('Should revert when minting SporesNFT1155 of existed tokenId - Single Minting - New Minter', async () => {
        //  Prepare input data. TokenID has already existed
        const tokenId = 11550123;
        const uri = 'https://test.metadata/11550123';
        const amount = 123;
        const signature = await verifySignature(verifier, anotherOwner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minterBatch.connect(anotherOwner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesNFT1155: Token already minted');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        expect(await token1155.balanceOf(anotherOwner.address, tokenId)).deep.equal(0);
    });

    it('Should succeed minting a new SporesNFT1155 - Batch Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId1 = 11550124;
        const uri1 = 'https://test.metadata/11550124';
        const amount1 = 124;

        const tokenId2 = 11550125;
        const uri2 = 'https://test.metadata/11550125';
        const amount2 = 125;

        const tokenId3 = 11550126;
        const uri3 = 'https://test.metadata/11550126';
        const amount3 = 126;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, tokenId3
        );
        const amounts = [amount1, amount2, amount3];

        //  Send a minting request
        const mintTx = await minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature);
        const receipt = await mintTx.wait();

        //  Verify outputs: 
        //  + 'SporesNFTMintBatch' event must be corrected
        //  + 'tokenURI' of 'tokenId' must be set
        //  + Balance of 'owner' must be updated with respect to 'tokenId'
        let event = receipt.events.find(e => { return e.event == 'SporesNFTMintBatch' });

        expect(event != undefined).true;
        expect(event.args._to).deep.equal(owner.address);
        expect(event.args._nft).deep.equal(token1155.address);
        expect(event.args._amounts[0].eq(amount1));
        expect(event.args._amounts[1].eq(amount2));
        expect(event.args._amounts[2].eq(amount3));
        expect(event.args._ids[0].eq(tokenId1));
        expect(event.args._ids[1].eq(tokenId2));
        expect(event.args._ids[2].eq(tokenId3));

        expect(await token1155.uri(tokenId1)).deep.equal(uri1);
        expect(await token1155.uri(tokenId2)).deep.equal(uri2);
        expect(await token1155.uri(tokenId3)).deep.equal(uri3);
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(124);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(125);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(126);
    });

    it('Should revert when one of requesting TokenID is existed - Batch Minting - New Minter', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId1 = 11550127;
        const uri1 = 'https://test.metadata/11550127';
        const amount1 = 127;

        const tokenId2 = 11550128;
        const uri2 = 'https://test.metadata/11550128';
        const amount2 = 128;

        //  TokenID is an existed one
        const tokenId3 = 11550126;
        const uri3 = 'https://test.metadata/11550126';
        const amount3 = 126;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, tokenId3
        );
        const amounts = [amount1, amount2, amount3];

        //  Send a minting request
        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesNFT1155: Token already minted');

        //  Verify that: 
        //  + Balance of 'owner' remains unchanged (existed tokenId)
        //  + Other 'tokenId' should be zero
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(126);
    });

    it('Should revert when minting SporesNFT721 without a signature - Single Minting - New Minter', async () => {
        // Prepare input data
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minterBatch.connect(owner).mintSporesERC721(tokenId, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT721 without a signature - Batch Minting - New Minter', async () => {
        // Prepare input data
        const tokenId1 = 7210001;
        const uri1 = 'https://test.metadata/7210001';

        const tokenId2 = 7210001;
        const uri2 = 'https://test.metadata/7210002';

        const tokenId3 = 7210003;
        const uri3 = 'https://test.metadata/7210003';

        const emptySig = ethers.utils.arrayify(0);
        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenIds' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId3)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 without a signature - Single Minting - New Minter', async () => {
        // Prepare input data
        const tokenId = 1155001;
        const uri = 'https://test.metadata/1155001';
        const amount = 1101;
        const emptySig = ethers.utils.arrayify(0);

        await expect(
            minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT1155 without a signature - Batch Minting - New Minter', async () => {
        // Prepare input data
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3= 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const emptySig = ethers.utils.arrayify(0);
        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const amounts = [amount1, amount2, amount3];

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, emptySig)
        ).to.be.revertedWith('ECDSA: invalid signature length');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenIds'
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT721 with a signature that is generated by an invalid Verifier - Single Minting - New Minter', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT721 with a signature that is generated by an invalid Verifier - Batch Minting - New Minter', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId1 = 7210001;
        const uri1 = 'https://test.metadata/7210001';

        const tokenId2 = 7210001;
        const uri2 = 'https://test.metadata/7210002';

        const tokenId3 = 7210003;
        const uri3 = 'https://test.metadata/7210003';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            owner, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenIds' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId3)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when minting SporesNFT1155 with a signature that is generated by an invalid Verifier - Single Minting - New Minter', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId = 1155001;
        const uri = 'https://test.metadata/1155001';
        const amount = 1101;
        const signature = verifySignature(owner, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when minting SporesNFT1155 with a signature that is generated by an invalid Verifier - Batch Minting - New Minter', async () => {
        // Prepare input data. Signature is generated by 'owner', not by 'verifier'
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3= 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            owner, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, tokenId3
        );
        const amounts = [amount1, amount2, amount3];

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenIds'
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(0);
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT721 - Single Minting - New Minter', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const signature = verifySignature(verifier, owner.address, 7210005, uri, ERC721_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT721 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId1 = 7210001;
        const uri1 = 'https://test.metadata/7210001';

        const tokenId2 = 7210001;
        const uri2 = 'https://test.metadata/7210002';

        const tokenId3 = 7210003;
        const uri3 = 'https://test.metadata/7210003';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, 7210005
        );

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId3)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT1155 - Single Minting - New Minter', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId = 1155001;
        const uri = 'https://test.metadata/1155001';
        const amount = 1101;
        const signature = verifySignature(owner, owner.address, 1155005, uri, ERC1155_MINT);
        
        await expect(
            minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
    });

    it('Should revert when a requesting TokenID and a signed TokenID are not matched - SporesNFT1155 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting TokenID and approved TokenID (with signature) are different
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3= 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            owner, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, 1155005
        );
        const amounts = [amount1, amount2, amount3];
        
        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenIds'
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(0);
    });

    it('Should revert when requesting ERC721 minting and signed ERC1155 minting - SporesNFT721 - Single Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 7210001;
        const uri = 'https://test.metadata/7210001';
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC1155_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Balance of 'deployer' should be zero
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        expect(await token721.balanceOf(deployer.address)).deep.equal(0);
        await expect(
            token721.ownerOf(tokenId)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when requesting ERC721 minting and signed ERC1155 minting - SporesNFT721 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId1 = 7210001;
        const uri1 = 'https://test.metadata/7210001';

        const tokenId2 = 7210001;
        const uri2 = 'https://test.metadata/7210002';

        const tokenId3 = 7210003;
        const uri3 = 'https://test.metadata/7210003';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC1155_MINT, tokenId1, tokenId2, tokenId3
        );

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' remains unchanged
        //  + Balance of 'deployer' should be zero
        //  + Owner of 'tokenId' should not exist
        expect(await token721.balanceOf(owner.address)).deep.equal(6);
        expect(await token721.balanceOf(deployer.address)).deep.equal(0);
        await expect(
            token721.ownerOf(tokenId1)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId2)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
        await expect(
            token721.ownerOf(tokenId3)
        ).to.be.revertedWith('ERC721: owner query for nonexistent token');
    });

    it('Should revert when requesting ERC1155 minting and signed ERC721 minting - SporesNFT1155 - Single Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId = 1155001;
        const uri = 'https://test.metadata/1155001';
        const amount = 1101;
        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minterBatch.connect(owner).mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        //  + Balance of 'deployer' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId)).deep.equal(0);
    });

    it('Should revert when requesting ERC1155 minting and signed ERC721 minting - SporesNFT1155 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3= 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );
        const amounts = [amount1, amount2, amount3];

        await expect(
            minterBatch.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier');

        //  Verify that:
        //  + Balance of 'owner' should be zero with respect to 'tokenId'
        //  + Balance of 'deployer' should be zero with respect to 'tokenId'
        expect(await token1155.balanceOf(owner.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(owner.address, tokenId3)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId1)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId2)).deep.equal(0);
        expect(await token1155.balanceOf(deployer.address, tokenId3)).deep.equal(0);
    });


    it('Should revert when function caller and mint to address in signature mismatch - SporesNFT721 - New Minter', async () => {
        const tokenId = 1155002;
        const uri = 'https://test.metadata/1155001';

        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minterBatch.mintSporesERC721(tokenId, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier')
    });

    it('Should revert when function caller and mint to address in signature mismatch - SporesNFT1155 - New Minter', async () => {
        const tokenId = 1155002;
        const uri = 'https://test.metadata/1155001';
        const amount = 1244;

        const signature = verifySignature(verifier, owner.address, tokenId, uri, ERC721_MINT);

        await expect(
            minterBatch.mintSporesERC1155(tokenId, amount, uri, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier')
    });

    it('Should revert when function caller and mint to address in signature mismatch - SporesNFT721 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';

        const tokenId3 = 1155003;
        const uri3 = 'https://test.metadata/1155003';

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );

        await expect(
            minterBatch.mintBatchSporesERC721(tokenIds, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier')
    });

    it('Should revert when function caller and mint to address in signature mismatch - SporesNFT1155 - Batch Minting - New Minter', async () => {
        // Prepare input data. Requesting Receiver and approved Receiver (with signature) are different
        const tokenId1 = 1155001;
        const uri1 = 'https://test.metadata/1155001';
        const amount1 = 1101;

        const tokenId2 = 1155002;
        const uri2 = 'https://test.metadata/1155002';
        const amount2 = 1102;

        const tokenId3 = 1155003;
        const uri3 = 'https://test.metadata/1155003';
        const amount3 = 1103;

        const tokenIds = [tokenId1, tokenId2, tokenId3];
        const uris = [uri1, uri2, uri3];
        const encodedURIs = await encodeURIs(uri1, uri2, uri3);
        const signature = verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId1, tokenId2, tokenId3
        );
        const amounts = [amount1, amount2, amount3];

        await expect(
            minterBatch.mintBatchSporesERC1155(tokenIds, amounts, uris, signature)
        ).to.be.revertedWith('SporesRegistry: Invalid verifier')
    });
})

//  Check gas efficiency between minting multiple single NFTs vs minting batch of NFTs
describe('SporesNFTMinter Contract Testing Gas Efficiency', () => {
    let deployer, owner, verifier, feeCollector;
    let token721, token1155, minter;
    before(async() => {
        //  Get pre-fund accounts
        [deployer, owner, verifier, feeCollector] = await ethers.getSigners();

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
        registry = await SporesRegistry.deploy();
        registry.init(
            feeCollector.address, verifier.address, token721.address, token1155.address, supportTokens
        );
        
        //  Deploy and initialize SporesNFTMinter contract
        //  SporesNFTMinter contract is written following non-upgradeability feature
        //  Hence, constructor is defined and being called when deploying SporesNFTMinter contract
        const SporesNFTMinter = await ethers.getContractFactory('SporesNFTMinterBatch', deployer);
        minter = await SporesNFTMinter.deploy(registry.address);

        //  By default, Minter role of SporesNFT721 and SporesNFT1155 is 'deployer'
        //  So, it should be transferred to an address of SporesNFTMinter contract
        await token721.transferMinter(minter.address);
        await token1155.transferMinter(minter.address);

        //  Add Minter into SporesRegistry
        await registry.updateMinter(minter.address);
    });

    it('Minting multiple SporesNFT721 - 1 by 1 vs batch', async () => {
        //  Prepare input data. TokenID1 is a new one
        const tokenId1 = 1344350;
        const uri1 = 'https://test.metadata/1';
        const signature1 = await verifySignature(verifier, owner.address, tokenId1, uri1, ERC721_MINT);

        //  Prepare input data. TokenID2 is a new one
        const tokenId2 = 1344351;
        const uri2 = 'https://test.metadata/2';
        const signature2 = await verifySignature(verifier, owner.address, tokenId2, uri2, ERC721_MINT);

        //  Prepare input data. TokenID3 is a new one
        const tokenId3 = 1344353;
        const uri3 = 'https://test.metadata/3';
        const signature3 = await verifySignature(verifier, owner.address, tokenId3, uri3, ERC721_MINT);

        //  Prepare input data. TokenID4 is a new one
        const tokenId4 = 1344354;
        const uri4 = 'https://test.metadata/4';

        //  Prepare input data. TokenID2 is a new one
        const tokenId5 = 1344355;
        const uri5 = 'https://test.metadata/5';

        //  Prepare input data. TokenID3 is a new one
        const tokenId6 = 1344356;
        const uri6 = 'https://test.metadata/6';
    
        const tokenIds = [tokenId4, tokenId5, tokenId6]
        const uris = [uri4, uri5, uri6];
        const encodedURIs = await encodeURIs(uri4, uri5, uri6);
        const signatureBatch = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC721_MINT, tokenId4, tokenId5, tokenId6)
        ;

        //  Send a minting request
        const mintTx1 = await minter.connect(owner).mintSporesERC721(tokenId1, uri1, signature1);
        const receipt1 = await mintTx1.wait();
        const mintTx2 = await minter.connect(owner).mintSporesERC721(tokenId2, uri2, signature2);
        const receipt2 = await mintTx2.wait();
        const mintTx3 = await minter.connect(owner).mintSporesERC721(tokenId3, uri3, signature3);
        const receipt3 = await mintTx3.wait();
        const mintTx4 = await minter.connect(owner).mintBatchSporesERC721(tokenIds, uris, signatureBatch);
        const receipt4 = await mintTx4.wait();
        const total_1by1 = receipt1.gasUsed.add(receipt2.gasUsed).add(receipt3.gasUsed).toNumber();
        const total_batch = receipt4.gasUsed.toNumber();
        const result = Math.round(total_1by1 * 100.0 / total_batch) - 100;
        console.log('Gas Used (1 by 1): %d', total_1by1);
        console.log('Gas Used (batch): %d', total_batch);
        console.log('Save ----> %d%', result);
    });

    it('Should succeed minting a new SporesNFT1155', async () => {
        //  Prepare input data. TokenID is a new one
        //  ERC1155 supports minting NFT items with a specific amount
        const tokenId1 = 235321;
        const uri1 = 'https://test.metadata/1';
        const amount1 = 23;
        const signature1 = await verifySignature(verifier, owner.address, tokenId1, uri1, ERC1155_MINT);

        const tokenId2 = 235322;
        const uri2 = 'https://test.metadata/2';
        const amount2 = 23;
        const signature2 = await verifySignature(verifier, owner.address, tokenId2, uri2, ERC1155_MINT);

        const tokenId3 = 235323;
        const uri3 = 'https://test.metadata/3';
        const amount3 = 23;
        const signature3 = await verifySignature(verifier, owner.address, tokenId3, uri3, ERC1155_MINT);

        const tokenId4 = 235324;
        const uri4 = 'https://test.metadata/4';
        const amount4 = 23;

        const tokenId5 = 235325;
        const uri5 = 'https://test.metadata/5';
        const amount5 = 23;

        const tokenId6 = 235326;
        const uri6 = 'https://test.metadata/6';
        const amount6 = 23;

        const tokenIds = [tokenId4, tokenId5, tokenId6];
        const uris = [uri4, uri5, uri6];
        const encodedURIs = await encodeURIs(uri4, uri5, uri6);
        const signatureBatch = await verifySignatureBatch(
            verifier, owner.address, encodedURIs, ERC1155_MINT, tokenId4, tokenId5, tokenId6
        );

        const amounts = [amount4, amount5, amount6];

        //  Send a minting request
        const mintTx1 = await minter.connect(owner).mintSporesERC1155(tokenId1, amount1, uri1, signature1);
        const receipt1 = await mintTx1.wait();
        const mintTx2 = await minter.connect(owner).mintSporesERC1155(tokenId2, amount2, uri2, signature2);
        const receipt2 = await mintTx2.wait();
        const mintTx3 = await minter.connect(owner).mintSporesERC1155(tokenId3, amount3, uri3, signature3);
        const receipt3 = await mintTx3.wait();
        const mintTx4 = await minter.connect(owner).mintBatchSporesERC1155(tokenIds, amounts, uris, signatureBatch);
        const receipt4 = await mintTx4.wait();
        const total_1by1 = receipt1.gasUsed.add(receipt2.gasUsed).add(receipt3.gasUsed).toNumber();
        const total_batch = receipt4.gasUsed.toNumber();
        const result = Math.round(total_1by1 * 100.0 / total_batch) - 100;
        console.log('Gas Used (1 by 1): %d', total_1by1);
        console.log('Gas Used (batch): %d', total_batch);
        console.log('Save ----> %d%', result);
    });
});    