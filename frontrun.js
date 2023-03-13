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

const INPUT_TOKEN_ABI_REQ = ERC20ABI;
const OUT_TOKEN_ABI_REQ = ERC20ABI;

var input_token_info;
var out_token_info;
var pool_info;
var gas_price_info;

var web3;
var web3Ws;
var uniswapRouter;
var uniswapFactory;
var USER_WALLET;
var native_info;

var nonceNum = 200;

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
    subscription = web3Ws.eth
    .subscribe("pendingTransactions", function (error, result) {
      // console.log(error);
      // console.log(result);
    })
    .on("data", async function (transactionHash) {
      try{
        let transaction = await web3.eth.getTransaction(transactionHash);
        if (
          transaction != null &&
          transaction["to"] && transaction["to"].toString().toLowerCase() == UNISWAP_ROUTER_ADDRESS.toString().toLowerCase()
        ) {
          await handleTransaction(
            transaction,
            out_token_address,
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

    web3Ws.on = function (evt) {
      console.log('evt : ', evt);
      web3Ws.send(
        JSON.stringify({
          method: "subscribe",
          topic: "transfers",
          address: user_wallet.address,
        })
      );
      console.log("connected");
    };

    loop();
  } catch (error) {
    console.log("main : ", error);
  }
}

async function handleTransaction(
  transaction,
  out_token_address,
  amount,
  level
) {
  try {
    if (await triggersFrontRun(transaction, out_token_address, amount, level)) 
    {
      subscription.unsubscribe();
      console.log("Perform front running attack...");

      let gasPrice = parseInt(transaction["gasPrice"]);

      let newGasPrice = gasPrice + parseInt(3 * ONE_GWEI);

      console.log("native_info", native_info);
      console.log("amount", web3.utils.toWei(amount.toString(), 'ether'));

      var realInput =
        native_info.balance > web3.utils.toWei(amount.toString(), 'ether')
          ? web3.utils.toWei(amount.toString(), 'ether')
          : native_info.balance;

      var gasLimit = (300000).toString();

      console.log("realInput", realInput);
      console.log("gasLimit", gasLimit);

      await swap(
        newGasPrice,
        gasLimit,
        realInput,
        0,  //buy
        out_token_address,
        transaction
      );

      console.log(
        "Wait until the large volumn transaction is done...",
        transaction["hash"]
      );

      if (buy_failed) {
        succeed = false;
        attack_started = false;
        return;
      }

      console.log("Buy succeed:");

      //Sell
      var out_token_info = await getTokenInfo(
        out_token_address,
        OUT_TOKEN_ABI_REQ
      );

      await swap(
        gasPrice,
        gasLimit,
        out_token_info.balance,
        1,
        out_token_address,
        transaction
      );

      console.log("Sell succeed");
      succeed = true;
      attack_started = false;
    }
  } catch (error) {
    console.log("Error on handleTransaction", error);
    attack_started = false;
  }
}

async function approve(gasPrice, token_address) {
  try {
    var allowance = await out_token_info.token_contract.methods
      .allowance(USER_WALLET.address, UNISWAP_ROUTER_ADDRESS)
      .call();

    allowance = BigNumber(Math.floor(Number(allowance)).toString());
    amountToSpend = web3.utils.toWei((2 ** 64 - 1).toString(), "ether");

    var decimals = BigNumber(10).power(out_token_info.decimals);
    var max_allowance = BigNumber(10000000000).multiply(decimals);

    if (allowance - amountToSpend < 0) {
      console.log("max_allowance : ", max_allowance.toString());
      var approveTX = {
        from: USER_WALLET.address,
        to: token_address,
        gas: 50000,
        gasPrice: gasPrice * ONE_GWEI,
        data: out_token_info.token_contract.methods
          .approve(UNISWAP_ROUTER_ADDRESS, max_allowance)
          .encodeABI(),
      };

      var signedTX = await USER_WALLET.signTransaction(approveTX);
      var result = await web3.eth.sendSignedTransaction(
        signedTX.rawTransaction
      );

      console.log("Sucessfully approved ", token_address);
    }
  } catch (error) {
    console.log("Error on approve ", error);
  }
}

async function updatePoolInfo() {
  try{
      var reserves = await pool_info.contract.methods.getReserves().call();
      var eth_balance;
      var token_balance;

      if(pool_info.forward) {
          eth_balance = reserves[0];
          token_balance = reserves[1];
      } else {
          eth_balance = reserves[1];
          token_balance = reserves[0];
      }

      pool_info.input_volumn = eth_balance;
      pool_info.output_volumn = token_balance;
  }catch (error) {

      console.log('Failed To Get Pair Info'.yellow);

      throw error;
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

      await updatePoolInfo();

      //calculate eth amount
      var calc_eth = calc_profit(in_amount);

      log_str =
        transaction["hash"] +
        "\t" +
        gasPrice.toFixed(2) +
        "\tGWEI\t" +
        (calc_eth / 10 ** input_token_info.decimals).toFixed(3) +
        "\t" +
        input_token_info.symbol;
      console.log(log_str.yellow);

      if (calc_eth >= 0.0005) {
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
    console.log("Error on triggersFrontRun", error);
  }
}

async function swap(
  gasPrice,
  gasLimit,
  realInput,
  trade,
  out_token_address,
  transaction
) {
  try 
  {
    // Get a wallet address from a private key
    var from = USER_WALLET;
    var deadline;

    var swapTransaction;

    nonceNum++;
    var nonce = web3.utils.toHex(nonceNum);
    deadline = Date.now() + 100000 * 60 * 10;

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
        value: realInput,
        // from: from.address,
        to: swapTransaction._parent._address,
        gas: gasLimit,
        gasPrice: gasPrice,
        data: encodedABI,
        // nonce: nonce,
      };

      console.log("made buy transaction");
    } 
    else {
      //sell
      console.log("swapExactTokensForETH");

      swapTransaction = uniswapRouter.methods.swapExactTokensForETH(
        realInput.toString(),
        "0",
        [out_token_address, WETH_TOKEN_ADDRESS],
        from.address,
        deadline
      );
      var encodedABI = swapTransaction.encodeABI();

      var tx = {
        // value: realInput,
        // from: from.address,
        to: swapTransaction._parent._address,
        gas: gasLimit,
        gasPrice: gasPrice,
        data: encodedABI,
        // nonce: nonce,
      };
    }

    var signedTx = await web3.eth.accounts.signTransaction(tx, from.privateKey);

    // console.log("made signedTx", signedTx);

    if (trade == 0) {
      let is_pending = await isPending(transaction["hash"]);
      if (!is_pending) {
        console.log(
          "The transaction you want to attack has already been completed!!!"
        );
      }
    }

    console.log("====signed transaction=====", gasLimit, gasPrice);
    await web3.eth.sendSignedTransaction(signedTx.rawTransaction)
    .on("transactionHash", function (hash) {
      console.log("swap : ", hash);
    })
    .on("error", function (error, receipt) {
      // If the transaction was rejected by the network with a receipt, the second parameter will be the receipt.
      // console.log(error);
      // console.log(receipt);
      if (trade == 0) {
        buy_failed = true;
        console.log("Attack failed(buy)");
      } else {
        sell_failed = true;
        console.log("Attack failed(sell)");
      }
    })
    .on("confirmation", function (confirmationNumber, receipt) {
      // console.log(confirmationNumber);
      // console.log(receipt);
      if (trade == 0) {
        buy_finished = true;
      } else {
        sell_finished = true;
      }
    });
    
  } catch (error) {
    console.log("Error on swap ", error);
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
    console.log("Error on isPending", error);
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

async function getETHInfo() {
  try {
    var balance = await web3.eth.getBalance(USER_WALLET.address);
    var decimals = 18;
    var symbol = "WETH";

    return {
      address: WETH_TOKEN_ADDRESS,
      balance: balance,
      symbol: symbol,
      decimals: decimals,
    };
  } catch (error) {
    console.log("get WETH balance error", error);
  }
}

async function getTokenInfo(tokenAddr, token_abi_ask) {
  try {

    //get token info
    var token_contract = new web3.eth.Contract(ERC20ABI, tokenAddr);

    var balance = await token_contract.methods
      .balanceOf(USER_WALLET.address)
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

    native_info = await getETHInfo();

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


    input_token_info = await getTokenInfo(
      in_token_address,
      INPUT_TOKEN_ABI_REQ
    );


    out_token_info = await getTokenInfo(
      out_token_address,
      OUT_TOKEN_ABI_REQ
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

    console.log("input_volumn", pool_info.input_volumn);
    console.log("output_volumn", pool_info.output_volumn);

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
    console.log("Error on preparedAttack", error);
  }
}


function calc_profit(in_amount){
  // var test_input_volume = 1567.718390400374907413;
  // var test_output_volume = 5283707.386628779152286034;
  // var test_attack_amount = 0.1;
  // var test_in_amount = 50;

  var test_input_volume = web3.utils.toWei(pool_info.input_volumn, 'ether'); 
  var test_output_volume = parseFloat(BigNumber(pool_info.output_volumn).divide(10 ** out_token_info.decimals).toString()); 
  var test_attack_amount = AMOUNT;
  var test_in_amount = web3.utils.toWei(in_amount, 'ether');

  var cap = test_input_volume * test_output_volume;

  console.log("test_input_volume", test_input_volume);
  console.log("test_output_volume", test_output_volume);
  console.log("test_attack_amount", test_attack_amount);
  console.log("test_in_amount", test_in_amount);
  
  var test_input_volume_after_attack = test_input_volume + test_attack_amount * 0.9975;
  
  var purchased_token_amount = test_output_volume - cap / test_input_volume_after_attack;
  
  var test_input_volume_after_target = test_input_volume + test_attack_amount * 0.9975 + test_in_amount * 0.9975;
  
  var purchased_attacker_token_amount = cap / test_input_volume_after_attack - cap / test_input_volume_after_target;
  
  var test_output_volume_after_target = (test_output_volume - purchased_token_amount - purchased_attacker_token_amount) + purchased_token_amount * 0.9975;
  
  var input_profit = test_input_volume + test_attack_amount * 0.9975 + test_in_amount * 0.9975 - cap / test_output_volume_after_target - test_attack_amount;
  
  // console.log("cap", cap);
  // console.log("purchased_token_amount", purchased_token_amount);
  // console.log("purchased_attacker_token_amount", purchased_attacker_token_amount);
  // console.log("test_output_volume_after_target", test_output_volume_after_target);
  // console.log("input_profit", input_profit);
  return input_profit;
}

// console.log("profit", calc_profit(0.01));

main();

