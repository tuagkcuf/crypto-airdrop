const { expect } = require("chai");
const { ethers } = require("hardhat");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const { arrayify } = require("ethers/lib/utils");

const toWei = (num) => ethers.utils.parseEther(num.toString());
const fromWei = (num) => ethers.utils.formatEther(num);

describe("AirDrop", function () {
    const TOKENS_IN_POOL = toWei(1000000000);
    const REWARD_AMOUNT = toWei(500);
    let addrs;
    let contractBlockNumber;
    const blockNumberCutoff = 11;

    before(async function () {
        // set up the airdrop

        // create an array that shuffles the numbers from 0 to 19
        // the elements of the array will represent the development account number
        // and the index will represent the order in which that aacount will use ethSwap to buyTokens
        this.shuffle = [];
        while (this.shuffle.length < 20) {
            let r = Math.floor(Math.random() * 20);
            if (this.shuffle.indexOf(r) === -1) {
                this.shuffle.push(r);
            }
        }

        addrs = await ethers.getSigners();

        const EthSwapFactory = await ethers.getContractFactory(
            "EthSwap",
            addrs[0]
        );
        this.ethSwap = await EthSwapFactory.deploy();
        const receipt = await this.ethSwap.deployTransaction.wait();
        contractBlockNumber = receipt.blockNumber;

        // initiate token
        let tokenAddress = await this.ethSwap.token();
        this.token = (
            await ethers.getContractFactory("Token", addrs[0])
        ).attach(tokenAddress);

        // check that all 1 million tokens are in the
        expect(await this.token.balanceOf(this.ethSwap.address)).to.equal(
            TOKENS_IN_POOL
        );

        // every development account buys Tokens from the ethSwap exchange in a random order
        await Promise.all(
            this.shuffle.map(async (i, idx) => {
                const receipt = await (
                    await this.ethSwap
                        .connect(addrs[i])
                        .buyTokens({ value: toWei(10) })
                ).wait();
                expect(receipt.blockNumber).to.eq(idx + 2);
            })
        );

        // query all tokensPurchases events between contract block number to block number cut off on the ethSwap contract
        // to find out all the accounts that have interacted with it
        const filter = this.ethSwap.filters.TokensPurchased();
        const results = await this.ethSwap.queryFilter(
            filter,
            contractBlockNumber,
            blockNumberCutoff
        );
        expect(results.length).to.eq(blockNumberCutoff - contractBlockNumber);

        // get eligible addresses from events and then hash them to get leaf nodes
        this.leafNodes = results.map((i) =>
            keccak256(i.args.account.toString())
        );
        // generate merkelTree from leafNodes
        this.merkleTree = new MerkleTree(this.leafNodes, keccak256, {
            sortPairs: true,
        });
        // get root hash from merkle tree
        const rootHash = this.merkleTree.getRoot();
        // deploy the air drop contract
        const AirDropFactory = await ethers.getContractFactory(
            "AirDrop",
            addrs[0]
        );
        this.airDrop = await AirDropFactory.deploy(rootHash, REWARD_AMOUNT);
    });

    it("Only eligible accounts should be able to claim airdrop", async function () {
        // every eligible account claims their airdrop
        for (let i = 0; i < 20; i++) {
            const proof = this.merkleTree.getHexProof(
                keccak256(addrs[i].address)
            );
            if (proof.length !== 0) {
                await this.airDrop.connect(addrs[i]).claim(proof);
                expect(
                    await this.airDrop.balanceOf(addrs[i].address)
                ).to.eq.apply(REWARD_AMOUNT);
                // fails when user tries to claim tokens again
                await expect(
                    this.airDrop.connect(addrs[i]).claim(proof)
                ).to.be.revertedWith("already claimed air drop");
            } else {
                await expect(
                    this.airDrop.connect(addrs[i]).claim(proof)
                ).to.be.revertedWith("Incorrect merkle proof");
                expect(await this.airDrop.balanceOf(addrs[i].address)).to.eq(0);
            }
        }
    });
});
