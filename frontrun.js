/**
 * Perform a front-running attack on uniswap
 */
const fs = require('fs');
var Web3 = require("web3");
var abiDecoder = require("abi-decoder");
var colors = require("colors");
var Tx = require("ethereumjs-tx").Transaction;
var axios = require("axios");
var BigNumber = require("big-number");
const ERC20ABI = require("./abi/ERC20.json");

const {
  UNISWAP_ROUTER_ADDRESS,
  UNISWAP_FACTORY_ADDRESS,
  UNISWAP_ROUTER_ABI,
  UNISWAP_FACTORY_ABI,
  UNISWAP_POOL_ABI,
  HTTP_PROVIDER_LINK,
  WEBSOCKET_PROVIDER_LINK,
  HTTP_PROVIDER_LINK_TEST,
  GAS_STATION,
  UPDATE_TIME_INTERVAL,
} = require("./abi/constants.js");
const { PR_K, TOKEN_ADDRESS, AMOUNT, LEVEL, LEVEL_DECIMAL, WETH_TOKEN_ADDRESS, EXPLORER_API} = require("./env.js");
const { lookup } = require('dns');


var input_token_info;
var out_token_info;
var pool_info;
var gas_price_info;

var web3;
var web3Ws;
var uniswapRouter;
var uniswapFactory;
var USER_WALLET;

// one gwei
const ONE_GWEI = 1e9;

var buy_finished = false;
var sell_finished = false;
var buy_failed = false;
var sell_failed = false;
var attack_started = false;

var succeed = false;
var subscription;

async function createWeb3() {
  try 
  {
    web3 = new Web3(new Web3.providers.HttpProvider(HTTP_PROVIDER_LINK));
    web3Ws = new Web3(
      new Web3.providers.WebsocketProvider(WEBSOCKET_PROVIDER_LINK)
    );
    uniswapRouter = new web3.eth.Contract(
      UNISWAP_ROUTER_ABI,
      UNISWAP_ROUTER_ADDRESS
    );
    uniswapFactory = new web3.eth.Contract(
      UNISWAP_FACTORY_ABI,
      UNISWAP_FACTORY_ADDRESS
    );
    abiDecoder.addABI(UNISWAP_ROUTER_ABI);

    return true;
  } 
  catch (error) {
    console.log("create web3 : ", error);
  }
}

async function loop(){
  try{
    
    const amount = AMOUNT;
    const level = LEVEL;

    // get pending transactions
    subscription = web3.eth
    .subscribe("pendingTransactions", function (error, result) {
      console.log(error);
      console.log(result);
    })
    .on("data", async function (transactionHash) {
      try{

        console.log(transactionHash);

        let transaction = await web3.eth.getTransaction(transactionHash);
        if (
          transaction != null &&
          transaction["to"] && transaction["to"].toString().toLowerCase() == UNISWAP_ROUTER_ADDRESS.toString().toLowerCase()
        ) {
          await handleTransaction(
            transaction,
            out_token_address,
            user_wallet,
            amount,
            level
          );
        }
        if (succeed) {
          console.log("The bot finished the attack.");
        }
      }catch(err){
        // console.log("Error on pendingTransactions");
      }
    });
  }catch(error){
    console.log("loop : ", error);
    loop();
  }
}

async function main() {
  try {
    await createWeb3();

    try {
      USER_WALLET = web3.eth.accounts.privateKeyToAccount(PR_K);
    } catch (error) {
      console.log(
        "\x1b[31m%s\x1b[0m",
        "Your private key is invalid. Update env.js with correct PR_K"
      );
    }

    const out_token_address = TOKEN_ADDRESS;

    await preparedAttack();

    console.log("prepared");
    await approve(gas_price_info.high, WETH_TOKEN_ADDRESS, USER_WALLET);
    await approve(gas_price_info.high, out_token_address, USER_WALLET);

    // web3Ws.on = function (evt) {
    //   console.log('evt : ', evt);
    //   web3Ws.send(
    //     JSON.stringify({
    //       method: "subscribe",
    //       topic: "transfers",
    //       address: user_wallet.address,
    //     })
    //   );
    //   console.log("connected");
    // };

    loop();
  } catch (error) {
    console.log("main : ", error);
  }
}

async function handleTransaction(
  transaction,
  out_token_address,
  user_wallet,
  amount,
  level
) {
  try {
    if (await triggersFrontRun(transaction, out_token_address, amount, level)) {
      subscription.unsubscribe();
      console.log("Perform front running attack...");

      let gasPrice = parseInt(transaction["gasPrice"]);
      let newGasPrice = gasPrice + 5 * ONE_GWEI;

      var realInput =
        BigNumber(native_info.balance) > BigNumber(amount).multiply(BigNumber(10 ** input_token_info.decimals))
          ? BigNumber(amount).multiply(BigNumber(10 ** input_token_info.decimals))
          : BigNumber(native_info.balance).multiply(BigNumber(10 ** input_token_info.decimals));
      var gasLimit = (300000).toString();

      console.log("realInput", realInput);
      console.log("gasLimit", gasLimit);

      await swap(
        newGasPrice,
        gasLimit,
        realInput,
        0,  //buy
        out_token_address,
        user_wallet,
        transaction
      );

      console.log(
        "Wait until the large volumn transaction is done...",
        transaction["hash"]
      );

      while (await isPending(transaction["hash"])) {}

      if (buy_failed) {
        succeed = false;
        attack_started = false;
        return;
      }

      console.log("Buy succeed:");

      //Sell
      var out_token_info = await getTokenInfo(
        out_token_address,
        OUT_TOKEN_ABI_REQ,
        user_wallet
      );

      await swap(
        newGasPrice,
        gasLimit,
        out_token_info.balance,
        1,
        out_token_address,
        user_wallet,
        transaction
      );

      console.log("Sell succeed");
      succeed = true;
      attack_started = false;
    }
  } catch (error) {
    console.log("Error on handleTransaction");
    attack_started = false;
  }
}

async function approve(gasPrice, token_address, user_wallet) {
  try {
    var allowance = await out_token_info.token_contract.methods
      .allowance(user_wallet.address, UNISWAP_ROUTER_ADDRESS)
      .call();

    allowance = BigNumber(Math.floor(Number(allowance)).toString());
    amountToSpend = web3.utils.toWei((2 ** 64 - 1).toString(), "ether");

    var decimals = BigNumber(10).power(out_token_info.decimals);
    var max_allowance = BigNumber(10000000000).multiply(decimals);

    if (allowance - amountToSpend < 0) {
      console.log("max_allowance : ", max_allowance.toString());
      var approveTX = {
        from: user_wallet.address,
        to: token_address,
        gas: 50000,
        gasPrice: gasPrice * ONE_GWEI,
        data: out_token_info.token_contract.methods
          .approve(UNISWAP_ROUTER_ADDRESS, max_allowance)
          .encodeABI(),
      };

      var signedTX = await user_wallet.signTransaction(approveTX);
      var result = await web3.eth.sendSignedTransaction(
        signedTX.rawTransaction
      );

      console.log("Sucessfully approved ", token_address);
    }
  } catch (error) {
    console.log("Error on approve ");
  }
}

//select attacking transaction
async function triggersFrontRun(transaction, out_token_address, amount, level) {
  try {

    if (attack_started) return false;

    if (transaction["to"] && transaction["to"].toString().toLowerCase() != UNISWAP_ROUTER_ADDRESS.toString().toLowerCase()) {
      return false;
    }
    

    let data = parseTx(transaction["input"]);
    let method = data[0];
    let params = data[1];
    let gasPrice = parseInt(transaction["gasPrice"]) / ONE_GWEI;

    console.log("[triggersFrontRun] method = ", method);
    
    if (method == "swapExactETHForTokens") {


      let out_min = params[0].value;
      let in_amount = transaction["value"];

      let path = params[1].value;
      let in_token_addr = path[path.length - 2];
      let out_token_addr = path[path.length - 1];

      if (out_token_addr.toString().toLowerCase() != out_token_address.toString().toLowerCase()) {
        return false;
      }

      if (in_token_addr.toString().toLowerCase() != WETH_TOKEN_ADDRESS.toString().toLowerCase()) {
        return false;
      }
     
      
      console.log(transaction);

      //calculate eth amount
      var calc_eth = in_amount;

      log_str =
        transaction["hash"] +
        "\t" +
        gasPrice.toFixed(2) +
        "\tGWEI\t" +
        (calc_eth / 10 ** input_token_info.decimals).toFixed(3) +
        "\t" +
        input_token_info.symbol;
      console.log(log_str.yellow);

      if (calc_eth >= pool_info.attack_volumn) {
        attack_started = true;

        let log_str =
        "Attack "+input_token_info.symbol+" Volumn : Pool "+input_token_info.symbol+" Volumn" +
          "\t\t" +
          (pool_info.attack_volumn / 10 ** input_token_info.decimals).toFixed(3) +
          " " +
          input_token_info.symbol +
          "\t" +
          (pool_info.input_volumn / 10 ** input_token_info.decimals).toFixed(3) +
          " " +
          input_token_info.symbol;
        console.log(log_str);

        return true;
      } else {
        return false;
      }
    }

    return false;
  } catch (error) {
    console.log("Error on triggersFrontRun");
  }
}

async function swap(
  gasPrice,
  gasLimit,
  realInput,
  trade,
  out_token_address,
  user_wallet,
  transaction
) {
  try 
  {
    // Get a wallet address from a private key
    var from = user_wallet;
    var deadline;
    var swapTransaction;

    var nonce = await web3.eth.getTransactionCount(from.address, "pending");
    nonce = web3.utils.toHex(nonce);

    deadline = web3.utils.toHex(0);

    if (trade == 0) {
      //buy
      swapTransaction = uniswapRouter.methods.swapExactETHForTokens(
        "0",
        [WETH_TOKEN_ADDRESS, out_token_address],
        from.address,
        deadline
      );
      var encodedABI = swapTransaction.encodeABI();

      var tx = {
        value: web3.utils.fromWei(realInput, "ether"),
        from: from.address,
        to: UNISWAP_ROUTER_ADDRESS,
        gas: gasLimit,
        gasPrice: gasPrice,
        data: encodedABI,
        nonce: nonce,
      };
    } 
    else {
      //sell
      swapTransaction = uniswapRouter.methods.swapExactTokensForETH(
        realInput.toString(),
        "0",
        [out_token_address, WETH_TOKEN_ADDRESS],
        from.address,
        deadline
      );
      var encodedABI = swapTransaction.encodeABI();

      var tx = {
        from: from.address,
        to: UNISWAP_ROUTER_ADDRESS,
        gas: gasLimit,
        gasPrice: gasPrice,
        data: encodedABI,
        nonce: nonce,
      };
    }

    var signedTx = await from.signTransaction(tx);

    if (trade == 0) {
      let is_pending = await isPending(transaction["hash"]);
      if (!is_pending) {
        console.log(
          "The transaction you want to attack has already been completed!!!"
        );
      }
    }

    console.log("====signed transaction=====", gasLimit, gasPrice);
    await web3.eth
      .sendSignedTransaction(signedTx.rawTransaction)
      .on("transactionHash", function (hash) {
        console.log("swap : ", hash);
      })
      .on("confirmation", function (confirmationNumber, receipt) {
        if (trade == 0) {
          buy_finished = true;
        } else {
          sell_finished = true;
        }
      })
      .on("receipt", function (receipt) {         
      })
      .on("error", function (error, receipt) {
        // If the transaction was rejected by the network with a receipt, the second parameter will be the receipt.
        if (trade == 0) {
          buy_failed = true;
          console.log("Attack failed(buy)");
        } else {
          sell_failed = true;
          console.log("Attack failed(sell)");
        }
      });
  } catch (error) {
    console.log("Error on swap ");
  }
}

function parseTx(input) {
  if (input == "0x") return ["0x", []];
  let decodedData = abiDecoder.decodeMethod(input);
  let method = decodedData["name"];
  let params = decodedData["params"];

  return [method, params];
}

async function getCurrentGasPrices() {

  try {
    var response = await axios.get(GAS_STATION);
    var prices = {
      low: response.data.data.slow.price / ONE_GWEI,
      medium: response.data.data.normal.price / ONE_GWEI,
      high: response.data.data.fast.price / ONE_GWEI,
    };

    console.log(reponse);

    if(!attack_started) console.log("\n");

    var log_str = "***** gas price information *****";

    if(!attack_started) console.log(log_str.green);

    var log_str =
      "High: " +
      prices.high +
      "        medium: " +
      prices.medium +
      "        low: " +
      prices.low;
    if(!attack_started) console.log(log_str);

    return prices;

  } catch (error) {
    var prices = {
      low: 5,
      medium: 5.1,
      high: 5.2,
    };
    console.log("Error on getCurrentGasPrices");
    return prices;
  }
}

async function isPending(transactionHash) {
	try{
		return (await web3.eth.getTransactionReceipt(transactionHash)) == null;
	}
	catch(error){
    console.log("Error on isPending");
	}
}

async function getPoolInfo(in_token_address, out_token_address, level) {
  var log_str =
    "*****\t" +
    input_token_info.symbol +
    "-" +
    out_token_info.symbol +
    " Pair Pool Info\t*****";
  if(!attack_started) console.log(log_str.green);

  try {
    var pool_address = await uniswapFactory.methods
      .getPair(in_token_address, out_token_address)
      .call();
    
      console.log(pool_address);
    if (pool_address == "0x0000000000000000000000000000000000000000") {
      log_str =
        "Uniswap has no " +
        out_token_info.symbol +
        "-" +
        input_token_info.symbol +
        " pair";
        if(!attack_started)  console.log(log_str.yellow);
      return false;
    }

    var log_str = "Address:\t" + pool_address;
    if(!attack_started) console.log(log_str.white);

    var pool_contract = new web3.eth.Contract(UNISWAP_POOL_ABI, pool_address);
    var reserves = await pool_contract.methods.getReserves().call();

    var token0_address = await pool_contract.methods.token0().call();

    if (token0_address === WETH_TOKEN_ADDRESS) {
      var forward = true;
      var eth_balance = reserves[0];
      var token_balance = reserves[1];
    } else {
      var forward = false;
      var eth_balance = reserves[1];
      var token_balance = reserves[0];
    }

    var log_str =
      (eth_balance / 10 ** input_token_info.decimals).toFixed(5) +
      "\t" +
      input_token_info.symbol;
    if(!attack_started) console.log(log_str.white);

    var log_str =
      (token_balance / 10 ** out_token_info.decimals).toFixed(5) +
      "\t" +
      out_token_info.symbol;
    if(!attack_started) console.log(log_str.white);

    var attack_amount = eth_balance * (level / LEVEL_DECIMAL);
    pool_info = {
      contract: pool_contract,
      forward: forward,
      input_volumn: eth_balance,
      output_volumn: token_balance,
      attack_level: level,
      attack_volumn: attack_amount,
    };

    return true;
  } catch (error) {
    console.log("Error: Get Pair Info", error);
  }
}

async function getETHInfo(user_wallet) {
  try {
    var balance = await web3.eth.getBalance(user_wallet.address);
    var decimals = 18;
    var symbol = "WETH";

    return {
      address: WETH_TOKEN_ADDRESS,
      balance: balance,
      symbol: symbol,
      decimals: decimals,
    };
  } catch (error) {
    console.log("get WETH balance error");
  }
}

async function getTokenInfo(tokenAddr, token_abi_ask, user_wallet) {
  try {

    //get token info
    var token_contract = new web3.eth.Contract(ERC20ABI, tokenAddr);

    var balance = await token_contract.methods
      .balanceOf(user_wallet.address)
      .call();
    var decimals = await token_contract.methods.decimals().call();
    var symbol = await token_contract.methods.symbol().call();

    return {
      address: tokenAddr,
      balance: balance,
      symbol: symbol,
      decimals: decimals,
      token_contract,
    };
  } catch (error) {
    console.log("Failed Token Info : ", error);
  }
}

async function preparedAttack() {
  in_token_address = WETH_TOKEN_ADDRESS;
  out_token_address = TOKEN_ADDRESS;
  user_wallet = USER_WALLET;
  amount = AMOUNT;
  level = LEVEL;

  try {

    gas_price_info = await getCurrentGasPrices();

    var log_str = "***** Your Wallet Balance *****";

    log_str = "wallet address:\t" + user_wallet.address;

    if(!attack_started) console.log(log_str.green);

    let native_info = await getETHInfo(user_wallet);

    log_str =
      "ETH balance:\t" + web3.utils.fromWei(native_info.balance, "ether");

    if(!attack_started) console.log(log_str.green);

    if (native_info.balance < 0.0005 * 10 ** 18) {

      console.log("INSUFFICIENT NATIVE BALANCE!".yellow);

      log_str =
        "Your wallet native balance must be more 0.0005 " +
        native_info.symbol +
        "(+0.05 ETH:GasFee) ";

      if(!attack_started) console.log(log_str.red);

      return false;
    }

    const INPUT_TOKEN_ABI_REQ = ERC20ABI;

    input_token_info = await getTokenInfo(
      in_token_address,
      INPUT_TOKEN_ABI_REQ,
      user_wallet
    );

    const OUT_TOKEN_ABI_REQ = ERC20ABI;

    out_token_info = await getTokenInfo(
      out_token_address,
      OUT_TOKEN_ABI_REQ,
      user_wallet
    );

    if (out_token_info === null) {
      return false;
    }

    log_str =
      (
        Number(out_token_info.balance) /
        10 ** Number(out_token_info.decimals)
      ).toFixed(5) +
      "\t" +
      out_token_info.symbol;
    if(!attack_started) console.log(log_str.white);

    //check pool info
    if (
      (await getPoolInfo(
        input_token_info.address,
        out_token_info.address,
        level
      )) == false
    )
      return false;

    log_str =
      "=================== Prepared to attack " +
      input_token_info.symbol +
      "-" +
      out_token_info.symbol +
      " pair ===================";
    if(!attack_started) console.log(log_str.red);
    
    log_str =
      "***** Tracking more " +
      (pool_info.attack_volumn / 10 ** input_token_info.decimals).toFixed(5) +
      " " +
      input_token_info.symbol +
      "  Exchange on Uniswap *****";
    if(!attack_started) console.log(log_str.green);

    setTimeout(() => {
      preparedAttack();
    }, 150000);

    return true;
  } catch (error) {
    console.log("Error on preparedAttack");
  }
}

main();
