# front-run-bot
The front run bot for Pancakeswap (BSC)

Pancakeswap frontrun bot that purchases the specified token when liquidity is added.
Bot is following the “target” address and trades tokens on Pancakeswap.
Bot can front run by setting higher gas fee and using direct node for transaction.

## Prerequisities
- Node and NPM https://nodejs.org/en/download/
- Wallet with ETH for gas and token swap

## Running BOT
- Update env.js and provide private key to wallet and token address you want to target
- Bot is preconfigured for Pancakeswap on Ethereum network. Review configuration in constants.js. If you want to use bot with Pancakeswap you need to provide infura network configuration and Pancakeswap ABIs. 
- Install packages `npm install` from inside project folder
- Run script `npm start` or `node frontrun.js`
