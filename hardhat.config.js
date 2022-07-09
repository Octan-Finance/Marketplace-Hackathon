const dotenv = require("dotenv");
dotenv.config({ path: __dirname + "/.env" });

require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");
require("@nomiclabs/hardhat-waffle");
require("@atixlabs/hardhat-time-n-mine");
require("hardhat-deploy");
require("hardhat-gas-reporter");
require('@openzeppelin/hardhat-upgrades');

const mnemonic = process.env.MNEMONIC

module.exports = {
    solidity: {
        compilers: [
            {
                version: "0.8.6"
            }
        ]
    },

    gasReporter: {
        enabled: true
    },

    networks: {
        development: {
            url: "http://127.0.0.1:8545",     // Localhost (default: none)
            accounts: {
                mnemonic: mnemonic,
                count: 10
            },
            live: false, 
            saveDeployments: true
        },
        mainnet: {
            url: process.env.MAINNET_PROVIDER,
            accounts: [
                process.env.ETH_DEPLOYER            
            ],
            timeout: 900000,
            chainId: 1
        },
        binance: {
            url: process.env.BSC_MAINNET_PROVIDER,
            accounts: [
                process.env.BSC_DEPLOYER
            ],
            timeout: 9000000,
            chainId: 56,
        },
        matic: {
            url: process.env.MATIC_POLYGON_PROVIDER,
            accounts: [
                process.env.POLY_DEPLOYER,
            ],
            timeout: 900000,
            chainId: 137
        },
        fantom: {
            url: process.env.FANTOM_MAINNET_PROVIDER,
            accounts: [
                process.env.FANTOM_DEPLOYER,
            ],
            timeout: 900000,
            chainId: 250
        },
        moonbeam: {
            url: process.env.MOONBEAM_MAINNET_PROVIDER,
            accounts: [
                process.env.MOONBEAM_DEPLOYER
            ],
            timeout: 20000,
            chainId: 1284
        },
        goerli: {
            url: process.env.GOERLI_PROVIDER,
            accounts: [
                process.env.TESTNET_DEPLOYER,
            ],
            timeout: 20000,
            chainId: 4
        },
        bsctest: {
            url: process.env.BSC_TESTNET_PROVIDER,
            accounts: [
                process.env.TESTNET_DEPLOYER
            ],
            timeout: 20000,
            chainId: 97,
        },
        mumbai: {
            url: process.env.MUMBAI_POLYGON_PROVIDER,
            accounts: [
                process.env.TESTNET_DEPLOYER
            ],
            timeout: 20000,
            chainId: 80001
        },
        fantomtest: {
            url: process.env.FANTOM_TESTNET_PROVIDER,
            accounts: [
                process.env.TESTNET_DEPLOYER
            ],
            timeout: 20000,
            chainId: 4002
        },
        moonriver: {
            url: process.env.MOONRIVER_TESTNET_PROVIDER,
            accounts: [
                process.env.TESTNET_DEPLOYER
            ],
            timeout: 20000,
            chainId: 1285
        },
    },

    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./build/cache",
        artifacts: "./build/artifacts",
        deployments: "./deployments"
    },

    etherscan: {
        // apiKey: process.env.BSC_API_KEY,
        // apiKey: process.env.POLYGON_API_KEY,
        // apiKey: process.env.ETHERSCAN_API_KEY,
        // apiKey: process.env.FTMSCAN_API_KEY,
        // apiKey: process.env.MOONBEAM_API_KEY,
        apiKey: process.env.MOONRIVER_API_KEY,
    }
}